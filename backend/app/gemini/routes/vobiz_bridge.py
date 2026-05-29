"""
Vobiz ↔ Gemini Live bridge.

Vobiz is a Plivo-compatible voice API. Inbound calls flow:

  Caller dials Vobiz number
      → Vobiz POSTs to /api/vobiz/voice (Answer URL configured in Vobiz dashboard)
      → We respond with XML containing <Stream>wss://.../api/vobiz/stream</Stream>
      → Vobiz opens a WebSocket to /api/vobiz/stream
      → Caller audio (μ-law 8kHz) is forwarded to Gemini Live
      → Gemini PCM 24kHz audio is downsampled to μ-law 8kHz and sent back
      → Both sides talk in real time

Routes (mounted under /api/vobiz in main.py):
  POST/GET /voice    — Vobiz Answer URL webhook
  WS       /stream   — bidirectional audio stream
  POST     /status   — optional stream status callback
"""

import asyncio
import audioop
import base64
import json
import logging
import os
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import aiohttp
from fastapi import APIRouter, Depends, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

from ...models.user import User
from ...routes.auth import get_current_user
from ..services.logger import start_call, add_transcript, end_call
from ..services.agents_store import get_default_phone_agent
from ..services.tools_runtime import build_gemini_tools, dispatch_tool_call
from ..agents import DEFAULT_PHONE_AGENT
from ..ambience import AmbientMixer

OUTPUT_SAMPLE_RATE = 24000

log = logging.getLogger("vobiz_bridge")

router = APIRouter()

GOOGLE_API_KEY     = os.environ.get("GOOGLE_API_KEY", "")
PHONE_LANGUAGE     = os.environ.get("PHONE_LANGUAGE", "en")
VOBIZ_AUTH_ID      = os.environ.get("VOBIZ_AUTH_ID", "").strip()
VOBIZ_AUTH_TOKEN   = os.environ.get("VOBIZ_AUTH_TOKEN", "").strip()
VOBIZ_PHONE_NUMBER = os.environ.get("VOBIZ_PHONE_NUMBER", "").strip()

MODEL = os.environ.get("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-001")
API_VERSION = os.environ.get("GEMINI_API_VERSION", "v1beta")
INPUT_SAMPLE_RATE = 16000  # Gemini expects PCM16 @ 16kHz

PHONE_SYSTEM_PROMPT = os.environ.get("PHONE_SYSTEM_PROMPT") or DEFAULT_PHONE_AGENT

LANGUAGE_NAMES = {
    "en": "English", "hi": "Hindi", "bn": "Bengali", "ta": "Tamil",
    "te": "Telugu", "mr": "Marathi", "gu": "Gujarati", "es": "Spanish",
    "fr": "French", "de": "German", "ja": "Japanese", "ko": "Korean", "zh": "Chinese",
}


def _make_live_config(system_prompt: str, language: str, voice: str = "Aoede", tools=None):
    from google.genai import types

    lang_name = LANGUAGE_NAMES.get(language, "English")

    # Gemini Live has no clock — inject the real current time (IST) so it
    # can reason about "today", "tomorrow", "9am", etc. correctly.
    now_ist = datetime.now(ZoneInfo("Asia/Kolkata"))
    clock_block = (
        f"\n\nCURRENT DATE/TIME CONTEXT (Asia/Kolkata, India Standard Time):\n"
        f"  Today is {now_ist.strftime('%A, %d %B %Y')}.\n"
        f"  The current time is {now_ist.strftime('%I:%M %p')} IST.\n"
        "  Use these values whenever you need to compute or quote a date/time. "
        "Never guess or invent dates."
    )

    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        tools=tools or [],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_HIGH,
                prefix_padding_ms=20,
                silence_duration_ms=100,
            ),
            activity_handling=types.ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
        ),
        system_instruction=types.Content(
            parts=[types.Part(
                text=system_prompt
                     + clock_block
                     + f"\n\nCRITICAL: Respond ONLY in {lang_name}."
            )]
        ),
    )


# ── Outbound call trigger ─────────────────────────────────────────────────────

# Per-call overrides keyed by short UUID. The id flows:
#   /call  → stores entry → puts ?cfg=<id> on answer_url
#   /voice → reads cfg from query → embeds it in the Stream URL
#   /stream WS → reads cfg → loads + pops the entry
# Entries auto-expire after 1h to avoid leaks if a call never connects.
CALL_CONFIGS: dict[str, dict] = {}
_CALL_CONFIG_TTL_SEC = 3600


def _gc_call_configs() -> None:
    now = datetime.utcnow().timestamp()
    expired = [k for k, v in CALL_CONFIGS.items() if now - v.get("_ts", now) > _CALL_CONFIG_TTL_SEC]
    for k in expired:
        CALL_CONFIGS.pop(k, None)


class OutboundCallRequest(BaseModel):
    to: str  # E.164, e.g. "+919876543210"
    system_prompt: str | None = None  # optional: override default agent prompt
    language: str | None = None       # optional: override PHONE_LANGUAGE
    voice: str | None = None          # optional: override default voice
    tool_ids: list[int] | None = None  # optional: tools to expose to the agent
    kb_collection_ids: list[int] | None = None  # optional: KB collections the agent can search
    ambient_always: str | None = None        # optional: ambient slug played continuously
    ambient_tool_call: str | None = None     # optional: ambient slug played during tool calls
    ambient_volume: float | None = None      # optional: 0..1, default 0.15


@router.post("/call")
async def make_outbound_call(
    req: OutboundCallRequest,
    request: Request,
    _user: User = Depends(get_current_user),
):
    """Trigger an outbound Vobiz call. When the recipient answers, Vobiz hits
    our /voice webhook which connects them to the Gemini agent."""
    missing = [n for n, v in [
        ("VOBIZ_AUTH_ID", VOBIZ_AUTH_ID),
        ("VOBIZ_AUTH_TOKEN", VOBIZ_AUTH_TOKEN),
        ("VOBIZ_PHONE_NUMBER", VOBIZ_PHONE_NUMBER),
    ] if not v]
    if missing:
        raise HTTPException(500, f"Missing env vars: {', '.join(missing)}")

    _gc_call_configs()
    cfg_id = uuid.uuid4().hex[:12]
    CALL_CONFIGS[cfg_id] = {
        "system_prompt":     (req.system_prompt or "").strip() or PHONE_SYSTEM_PROMPT,
        "language":          (req.language or "").strip() or PHONE_LANGUAGE,
        "voice":             (req.voice or "").strip() or "Aoede",
        "tool_ids":          list(req.tool_ids or []),
        "kb_collection_ids": list(req.kb_collection_ids or []),
        "ambient_always":    (req.ambient_always or None) or None,
        "ambient_tool_call": (req.ambient_tool_call or None) or None,
        "ambient_volume":    req.ambient_volume if req.ambient_volume is not None else 0.15,
        "to":                req.to,
        "_ts":               datetime.utcnow().timestamp(),
    }

    host = request.url.hostname
    url = f"https://api.vobiz.ai/api/v1/Account/{VOBIZ_AUTH_ID}/Call/"
    answer_url = f"https://{host}/api/vobiz/voice?cfg={cfg_id}"
    hangup_url = f"https://{host}/api/vobiz/status"

    payload = {
        "from": VOBIZ_PHONE_NUMBER.lstrip("+"),
        "to":   req.to.lstrip("+"),
        "answer_url":    answer_url,
        "answer_method": "POST",
        "hangup_url":    hangup_url,
        "hangup_method": "POST",
        "time_limit":    600,
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(
            url,
            json=payload,
            headers={
                "X-Auth-ID":    VOBIZ_AUTH_ID,
                "X-Auth-Token": VOBIZ_AUTH_TOKEN,
            },
        ) as resp:
            body = await resp.text()
            log.info("vobiz /Call/ → %s %s", resp.status, body)
            try:
                data = json.loads(body)
            except ValueError:
                data = {"raw": body}
            if resp.status >= 400:
                raise HTTPException(resp.status, data)
            return JSONResponse(data)


# ── Answer URL webhook ────────────────────────────────────────────────────────

@router.post("/voice")
@router.get("/voice")
async def voice_webhook(request: Request):
    """Vobiz hits this when a call comes in. Returns XML telling Vobiz to
    open a bidirectional WebSocket to our /stream endpoint."""
    host = request.url.hostname
    cfg = request.query_params.get("cfg", "")
    ws_url = f"wss://{host}/api/vobiz/stream"
    if cfg:
        ws_url += f"?cfg={cfg}"
    log.info("/api/vobiz/voice → stream %s", ws_url)
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true"
          keepCallAlive="true"
          contentType="audio/x-mulaw;rate=8000">
    {ws_url}
  </Stream>
</Response>"""
    return Response(content=xml, media_type="application/xml")


@router.post("/status")
async def stream_status(request: Request):
    """Optional: Vobiz sends StartStream / PlayedStream / StopStream callbacks here.
    Body can be form-encoded OR JSON depending on the event — accept either."""
    ctype = request.headers.get("content-type", "")
    try:
        if "json" in ctype:
            data = await request.json()
        elif "form" in ctype or "urlencoded" in ctype:
            data = dict(await request.form())
        else:
            data = (await request.body()).decode("utf-8", errors="replace")
        log.info("stream-status (%s): %s", ctype, data)
    except Exception as e:
        log.warning("status callback parse error: %s", e)
    return Response(status_code=204)


# ── Audio transcoding helpers ─────────────────────────────────────────────────

def _mulaw8k_to_pcm16k(mulaw_bytes: bytes, state):
    pcm8k = audioop.ulaw2lin(mulaw_bytes, 2)
    pcm16k, state = audioop.ratecv(pcm8k, 2, 1, 8000, 16000, state)
    return pcm16k, state


def _pcm24k_to_mulaw8k(pcm24k_bytes: bytes, state):
    pcm8k, state = audioop.ratecv(pcm24k_bytes, 2, 1, 24000, 8000, state)
    return audioop.lin2ulaw(pcm8k, 2), state


# ── Vobiz WebSocket bridge ────────────────────────────────────────────────────

@router.websocket("/stream")
async def vobiz_stream(ws: WebSocket):
    await ws.accept()
    log.info("Vobiz media stream connected")

    if not GOOGLE_API_KEY:
        log.error("GOOGLE_API_KEY not configured")
        await ws.close()
        return

    cfg_id = ws.query_params.get("cfg", "")
    call_cfg = CALL_CONFIGS.pop(cfg_id, None) if cfg_id else None
    if call_cfg:
        call_prompt   = call_cfg["system_prompt"]
        call_language = call_cfg["language"]
        call_voice    = call_cfg["voice"]
        call_tool_ids = list(call_cfg.get("tool_ids") or [])
        call_kb_ids   = list(call_cfg.get("kb_collection_ids") or [])
        _ambient_always_slug    = call_cfg.get("ambient_always") or None
        _ambient_tool_call_slug = call_cfg.get("ambient_tool_call") or None
        _ambient_vol            = float(call_cfg.get("ambient_volume") or 0.15)
        log.info("Vobiz stream using per-call cfg %s (lang=%s, voice=%s)",
                 cfg_id, call_language, call_voice)
    else:
        _agent = await get_default_phone_agent()
        call_prompt   = _agent.system_prompt if _agent else PHONE_SYSTEM_PROMPT
        call_language = _agent.language      if _agent else PHONE_LANGUAGE
        call_voice    = _agent.voice         if _agent else "Aoede"
        call_tool_ids = list(_agent.tool_ids or []) if _agent else []
        call_kb_ids   = list(getattr(_agent, "kb_collection_ids", None) or []) if _agent else []
        _ambient_always_slug    = getattr(_agent, "ambient_always", None) if _agent else None
        _ambient_tool_call_slug = getattr(_agent, "ambient_tool_call", None) if _agent else None
        _ambient_vol            = getattr(_agent, "ambient_volume", 0.15) if _agent else 0.15
    call_tools = await build_gemini_tools(call_tool_ids, call_kb_ids)
    always_mixer = AmbientMixer(_ambient_always_slug,    OUTPUT_SAMPLE_RATE, _ambient_vol)
    tool_mixer   = AmbientMixer(_ambient_tool_call_slug, OUTPUT_SAMPLE_RATE, _ambient_vol)

    stream_id: str | None = None
    call_id: str | None = None
    in_state = None
    out_state = None
    log_id: int | None = None
    to_number = (call_cfg or {}).get("to") if call_cfg else None

    # Wait for Vobiz "start" event before opening Gemini session
    try:
        while stream_id is None:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            event = msg.get("event")
            if event == "start":
                log.info("Vobiz START event: %s", raw)
                # Vobiz (Plivo-style) nests fields under "start"
                start = msg.get("start", {}) or {}
                stream_id = (
                    msg.get("streamId") or msg.get("stream_id")
                    or start.get("streamId") or start.get("stream_id")
                    or start.get("streamSid")
                )
                call_id = (
                    msg.get("callId") or msg.get("call_id")
                    or start.get("callId") or start.get("call_id")
                    or start.get("callSid")
                )
                log.info("Vobiz stream %s (call %s) started", stream_id, call_id)
                log_id = await start_call(
                    call_type="vobiz",
                    direction="outbound" if to_number else "inbound",
                    phone_number=to_number,
                    language=call_language,
                    voice=call_voice,
                    system_prompt=call_prompt,
                )
            elif event == "stop":
                return
    except WebSocketDisconnect:
        return

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=GOOGLE_API_KEY, http_options={"api_version": API_VERSION})

    try:
        async with client.aio.live.connect(
            model=MODEL,
            config=_make_live_config(call_prompt, call_language, call_voice, tools=call_tools),
        ) as session:

            async def vobiz_to_gemini():
                nonlocal in_state
                media_count = 0
                while True:
                    raw = await ws.receive_text()
                    msg = json.loads(raw)
                    event = msg.get("event")
                    if event == "media":
                        media = msg.get("media", {})
                        payload = media.get("payload", "")
                        if not payload:
                            if media_count == 0:
                                log.info("Vobiz first MEDIA event (no payload): %s", raw[:300])
                            continue
                        if media_count == 0:
                            log.info("Vobiz first MEDIA event received, %d bytes payload",
                                     len(payload))
                        media_count += 1
                        if media_count % 250 == 0:
                            log.info("Vobiz → Gemini: %d media events", media_count)
                        mulaw = base64.b64decode(payload)
                        pcm16k, in_state = _mulaw8k_to_pcm16k(mulaw, in_state)
                        await session.send_realtime_input(
                            audio=types.Blob(
                                data=pcm16k,
                                mime_type=f"audio/pcm;rate={INPUT_SAMPLE_RATE}",
                            )
                        )
                    elif event == "stop":
                        log.info("Vobiz stream %s stopped (got %d media events)",
                                 stream_id, media_count)
                        return
                    else:
                        log.info("Vobiz event %s: %s", event, raw[:200])

            async def gemini_to_vobiz():
                nonlocal out_state
                from google.genai import types as gtypes

                play_count = 0
                _FILLER_BYTES = (OUTPUT_SAMPLE_RATE // 25) * 2  # 40 ms @ 24 kHz PCM16
                _FILLER_SILENCE = b"\x00" * _FILLER_BYTES
                filler_box: dict = {"task": None}

                async def _send_mixed(pcm24k: bytes):
                    nonlocal out_state, play_count
                    mulaw, out_state = _pcm24k_to_mulaw8k(pcm24k, out_state)
                    msg_out = {
                        "event": "playAudio",
                        "media": {
                            "contentType": "audio/x-mulaw",
                            "sampleRate": 8000,
                            "payload": base64.b64encode(mulaw).decode(),
                        },
                    }
                    if stream_id:
                        msg_out["streamId"] = stream_id
                    try:
                        await ws.send_text(json.dumps(msg_out))
                    except Exception:
                        return
                    if play_count == 0:
                        log.info("First playAudio sent (%d bytes mulaw)", len(mulaw))
                    play_count += 1

                async def _filler_loop():
                    try:
                        while True:
                            await _send_mixed(always_mixer.mix(tool_mixer.mix(_FILLER_SILENCE)))
                            await asyncio.sleep(0.04)
                    except asyncio.CancelledError:
                        return

                async def _stop_filler():
                    t = filler_box["task"]
                    if t is not None:
                        t.cancel()
                        try:
                            await t
                        except asyncio.CancelledError:
                            pass
                        filler_box["task"] = None

                try:
                    while True:
                        async for response in session.receive():
                            # ─── Tool calls from Gemini ───
                            tc = getattr(response, "tool_call", None)
                            if tc and tc.function_calls:
                                if (
                                    (always_mixer.enabled or tool_mixer.enabled)
                                    and filler_box["task"] is None
                                ):
                                    filler_box["task"] = asyncio.create_task(_filler_loop())
                                tool_responses = []
                                for fc in tc.function_calls:
                                    result = await dispatch_tool_call(call_tool_ids, fc.name, dict(fc.args or {}), kb_collection_ids=call_kb_ids)
                                    log.info("🔧 tool %s(%s) → %s", fc.name, dict(fc.args or {}), result)
                                    tool_responses.append(
                                        gtypes.FunctionResponse(
                                            id=fc.id,
                                            name=fc.name,
                                            response=result,
                                        )
                                    )
                                await session.send_tool_response(function_responses=tool_responses)
                                continue

                            sc = response.server_content
                            # Barge-in: caller interrupted → flush Vobiz playback queue
                            if sc and sc.interrupted and stream_id:
                                await ws.send_text(json.dumps({
                                    "event": "clearAudio",
                                    "streamId": stream_id,
                                }))
                            if response.data:
                                await _stop_filler()
                                await _send_mixed(always_mixer.mix(response.data))
                            if sc and sc.input_transcription and sc.input_transcription.text:
                                log.info("👤 %s", sc.input_transcription.text)
                                await add_transcript(log_id, "user", sc.input_transcription.text)
                            if sc and sc.output_transcription and sc.output_transcription.text:
                                log.info("🤖 %s", sc.output_transcription.text)
                                await add_transcript(log_id, "model", sc.output_transcription.text)
                        await asyncio.sleep(0)
                finally:
                    await _stop_filler()

            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(vobiz_to_gemini(), name="v2g"),
                    asyncio.create_task(gemini_to_vobiz(), name="g2v"),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass

    except WebSocketDisconnect:
        log.info("Vobiz stream disconnected (stream_id=%s)", stream_id)
    except Exception as exc:
        log.exception("Vobiz bridge error")
        await end_call(log_id, status="error", error_message=str(exc))
        return
    finally:
        await end_call(log_id)
