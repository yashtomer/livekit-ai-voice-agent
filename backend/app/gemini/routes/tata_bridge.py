"""
TATA ↔ Gemini Live bridge.

TATA (Smartflo "Voice Streaming" / Two-way Audio Streaming) does NOT use SIP.
It speaks the **Twilio Media-Streams JSON protocol** over a single WebSocket:
you register a static `wss://…/api/tata/stream` URL in the TATA portal and assign
it to a phone number. On every call TATA opens that socket and streams the audio.

Inbound flow:

  Caller dials TATA number
      → TATA opens WS to /api/tata/stream  (URL pasted in the TATA portal)
      → {"event":"start","streamSid":…,"start":{"callSid":…,"from":…}}
      → caller audio: {"event":"media","media":{"payload":"<base64 μ-law 8k>"}}
      → we decode μ-law 8k → PCM16 16k → Gemini Live
      → Gemini PCM16 24k → mix ambient → μ-law 8k (160-byte frames) → TATA
      → {"event":"stop", …}

Outbound flow (we dial the customer) — POST /api/tata/call:
      → TATA Click-to-Call API places the call
      → when it connects, TATA streams it to the SAME /stream endpoint
      → we correlate the stream to the per-call config by destination number

Routes (mounted under /api/tata in main.py):
  POST /call    — trigger an outbound call (Click-to-Call)
  GET  /config  — the WS URL to paste into the TATA portal + missing-env report
  WS   /stream  — bidirectional media stream (μ-law 8 kHz ↔ Gemini PCM16)

TATA wire protocol (ground truth: ../../../ivr_webhook.py):
  TATA→us : connected | start{streamSid,start.callSid,start.from} | media{media.payload}
            | dtmf{dtmf.digit} | mark | stop{stop.reason}
  us→TATA : {"event":"media","streamSid":…,"media":{"payload":…}}   (160-byte μ-law)
            {"event":"clear","streamSid":…}                          (barge-in flush)
"""

import asyncio
import audioop
import base64
import json
import logging
import os
import re
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import aiohttp
from fastapi import APIRouter, Depends, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse

from ...models.user import User
from ...routes.auth import get_current_user
from ..services.logger import start_call, add_transcript, add_tool_event, end_call
from ..services.agents_store import get_default_phone_agent
from ..services.tools_runtime import build_call_context, build_gemini_tools, dispatch_tool_call, render_template
from ..agents import DEFAULT_PHONE_AGENT
from ..ambience import AmbientMixer

OUTPUT_SAMPLE_RATE = 24000
INPUT_SAMPLE_RATE = 16000  # Gemini expects PCM16 @ 16 kHz

# TATA streams G.711 μ-law 8 kHz and expects audio back in fixed 160-byte
# frames (20 ms @ 8 kHz). Unlike Twilio (lenient on frame size) TATA can choke
# on variable-length frames, so we buffer outgoing μ-law and flush 160 at a time.
TATA_FRAME_BYTES = 160

log = logging.getLogger("tata_bridge")

router = APIRouter()

GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
PHONE_LANGUAGE = os.environ.get("PHONE_LANGUAGE", "en")

# ── TATA account config ───────────────────────────────────────────────────────
# Public base URL handed out for the streaming WS (TATA portal needs the wss://).
VITE_BACKEND_URL    = os.environ.get("VITE_BACKEND_URL", "").strip().rstrip("/")
VITE_BACKEND_WS_URL = VITE_BACKEND_URL.replace("https://", "wss://").replace("http://", "ws://")

# Outbound Click-to-Call. Defaults target TATA Smartflo's documented endpoint;
# override any of these to match YOUR account (the exact host/path/field names
# can differ per Smartflo plan — confirm against your TATA API docs).
TATA_CTC_URL     = os.environ.get("TATA_CTC_URL", "https://api-smartflo.tatateleservices.com/v1/click_to_call").strip()
TATA_AUTH_TOKEN  = os.environ.get("TATA_AUTH_TOKEN", "").strip()   # Bearer token from the TATA portal
TATA_CALLER_ID   = os.environ.get("TATA_CALLER_ID", "").strip()    # your DID / caller-id shown to the customer
TATA_AGENT_NUMBER = os.environ.get("TATA_AGENT_NUMBER", "").strip()  # the leg TATA dials first (often a DID/agent)

# Warm transfer (Smartflo Call Options API). When the agent calls transfer_call
# we POST {type:4, call_id, intercom} — TATA then rings the next available human
# in that department per its Ring Strategy. TATA_TRANSFER_CODE is the department/
# agent "transfer code" (intercom) from the TATA portal, e.g. "80002".
TATA_CALL_OPTIONS_URL = os.environ.get(
    "TATA_CALL_OPTIONS_URL", "https://api-smartflo.tatateleservices.com/v1/call/options"
).strip()
TATA_TRANSFER_CODE = os.environ.get("TATA_TRANSFER_CODE", "").strip()

MODEL       = os.environ.get("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-001")
API_VERSION = os.environ.get("GEMINI_API_VERSION", "v1beta")

PHONE_SYSTEM_PROMPT = os.environ.get("PHONE_SYSTEM_PROMPT") or DEFAULT_PHONE_AGENT

LANGUAGE_NAMES = {
    "en": "English", "hi": "Hindi", "bn": "Bengali", "ta": "Tamil",
    "te": "Telugu", "mr": "Marathi", "gu": "Gujarati", "es": "Spanish",
    "fr": "French", "de": "German", "ja": "Japanese", "ko": "Korean", "zh": "Chinese",
}


def _make_live_config(system_prompt: str, language: str, voice: str = "Aoede", tools=None):
    from google.genai import types

    lang_name = LANGUAGE_NAMES.get(language, "English")

    # Gemini Live has no clock — inject current IST so it can reason about
    # "today", "9am", etc. correctly.
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
                text=system_prompt + clock_block + f"\n\nCRITICAL: Respond ONLY in {lang_name}."
            )]
        ),
    )


# ── Per-call config for outbound calls ────────────────────────────────────────
# TATA's streaming URL is statically registered in the portal, so (unlike Vobiz)
# we cannot tag the WS URL with ?cfg=<id>. Instead we key the per-call config by
# the destination phone number's digits and look it up on the `start` event by
# matching the caller/callee number TATA reports. Entries auto-expire after 1h.
CALL_CONFIGS: dict[str, dict] = {}
_CALL_CONFIG_TTL_SEC = 3600


def _digits(num: str | None) -> str:
    """Last 10 digits of a phone number — robust to +91 / 0 / spacing variants."""
    d = re.sub(r"\D", "", num or "")
    return d[-10:] if len(d) >= 10 else d


def _gc_call_configs() -> None:
    now = datetime.utcnow().timestamp()
    for k in [k for k, v in CALL_CONFIGS.items() if now - v.get("_ts", now) > _CALL_CONFIG_TTL_SEC]:
        CALL_CONFIGS.pop(k, None)


def _pop_call_config(*numbers: str | None) -> dict | None:
    """Find and remove the outbound config matching any of the given numbers."""
    for n in numbers:
        key = _digits(n)
        if key and key in CALL_CONFIGS:
            return CALL_CONFIGS.pop(key)
    return None


# ── Outbound call trigger ─────────────────────────────────────────────────────

from pydantic import BaseModel


class OutboundCallRequest(BaseModel):
    to: str                                  # E.164, e.g. "+919876543210"
    system_prompt: str | None = None
    first_message: str | None = None
    language: str | None = None
    voice: str | None = None
    tool_ids: list[int] | None = None
    kb_collection_ids: list[int] | None = None
    ambient_always: str | None = None
    ambient_tool_call: str | None = None
    ambient_volume: float | None = None
    transfer_code: str | None = None         # dept/agent DTMF code for transfer_call (falls back to TATA_TRANSFER_CODE)


@router.post("/call")
async def make_outbound_call(
    req: OutboundCallRequest,
    request: Request,
    _user: User = Depends(get_current_user),
):
    """Trigger an outbound TATA Click-to-Call. When the customer answers, TATA
    streams the call to /api/tata/stream, where we match this config by number.

    NOTE: the Click-to-Call request shape varies by Smartflo plan. Defaults below
    follow TATA's documented click_to_call API; override TATA_CTC_URL / the body
    fields to match your account if the call doesn't place.
    """
    missing = [n for n, v in [
        ("TATA_AUTH_TOKEN", TATA_AUTH_TOKEN),
        ("TATA_CALLER_ID", TATA_CALLER_ID),
    ] if not v]
    if missing:
        raise HTTPException(500, f"Missing env vars: {', '.join(missing)}")

    _gc_call_configs()
    CALL_CONFIGS[_digits(req.to)] = {
        "system_prompt":     (req.system_prompt or "").strip() or PHONE_SYSTEM_PROMPT,
        "first_message":     (req.first_message or "").strip() or None,
        "language":          (req.language or "").strip() or PHONE_LANGUAGE,
        "voice":             (req.voice or "").strip() or "Aoede",
        "tool_ids":          list(req.tool_ids or []),
        "kb_collection_ids": list(req.kb_collection_ids or []),
        "ambient_always":    (req.ambient_always or None) or None,
        "ambient_tool_call": (req.ambient_tool_call or None) or None,
        "ambient_volume":    req.ambient_volume if req.ambient_volume is not None else 0.15,
        "transfer_code":     (req.transfer_code or "").strip() or None,
        "to":                req.to,
        "_ts":               datetime.utcnow().timestamp(),
    }

    # TATA Click-to-Call: connect the customer (destination) to the streaming DID.
    payload = {
        "agent_number":       TATA_AGENT_NUMBER or TATA_CALLER_ID,
        "destination_number": req.to,
        "caller_id":          TATA_CALLER_ID,
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                TATA_CTC_URL,
                json=payload,
                headers={"Authorization": f"Bearer {TATA_AUTH_TOKEN}"},
            ) as resp:
                body = await resp.text()
                log.info("TATA click_to_call → %s %s", resp.status, body[:300])
                try:
                    data = json.loads(body)
                except ValueError:
                    data = {"raw": body}
                if resp.status >= 400:
                    CALL_CONFIGS.pop(_digits(req.to), None)
                    raise HTTPException(resp.status, data)
                return JSONResponse(data)
    except aiohttp.ClientError as exc:
        CALL_CONFIGS.pop(_digits(req.to), None)
        raise HTTPException(502, f"TATA Click-to-Call request failed: {exc}")


# ── Config endpoint (URL to paste into the TATA portal) ───────────────────────

@router.get("/config")
async def tata_config(request: Request):
    host = VITE_BACKEND_WS_URL or f"wss://{request.url.hostname}"
    return JSONResponse({
        "stream_ws_url": f"{host}/api/tata/stream",
        "instructions": "Paste stream_ws_url into TATA Voice Streaming → Add an Endpoint, "
                        "then assign the endpoint to your phone number.",
        "outbound_enabled": bool(TATA_AUTH_TOKEN and TATA_CALLER_ID),
        "transfer_enabled": bool(TATA_AUTH_TOKEN and TATA_TRANSFER_CODE),
        "transfer_code": TATA_TRANSFER_CODE or None,
        "missing_env": [n for n, v in [
            ("VITE_BACKEND_URL", VITE_BACKEND_URL),
            ("TATA_AUTH_TOKEN", TATA_AUTH_TOKEN),
            ("TATA_CALLER_ID", TATA_CALLER_ID),
        ] if not v],
    })


# ── Audio transcoding helpers ─────────────────────────────────────────────────

def _mulaw8k_to_pcm16k(mulaw_bytes: bytes, state):
    pcm8k = audioop.ulaw2lin(mulaw_bytes, 2)
    pcm16k, state = audioop.ratecv(pcm8k, 2, 1, 8000, 16000, state)
    return pcm16k, state


def _pcm24k_to_mulaw8k(pcm24k_bytes: bytes, state):
    pcm8k, state = audioop.ratecv(pcm24k_bytes, 2, 1, 24000, 8000, state)
    return audioop.lin2ulaw(pcm8k, 2), state


# ── Warm transfer via Smartflo Call Options API ───────────────────────────────
# https://docs.smartflo.tatatelebusiness.com/reference/v1calloptions
#   POST /v1/call/options  { type:4 (Transfer), call_id, intercom }
# `intercom` is the department/agent transfer code (e.g. "80002"). TATA then
# rings the next available human agent per the department's Ring Strategy.

async def _tata_transfer(call_id: str | None, intercom: str | None) -> dict:
    """Hand the live call off to a TATA department/agent via the Call Options API."""
    if not TATA_AUTH_TOKEN:
        return {"status": "error", "message": "TATA_AUTH_TOKEN not configured."}
    if not call_id:
        return {"status": "error", "message": "No TATA call_id available for transfer."}
    if not intercom:
        return {"status": "error", "message": "No transfer code (intercom) configured."}

    payload = {"type": 4, "call_id": call_id, "intercom": intercom}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                TATA_CALL_OPTIONS_URL,
                json=payload,
                headers={"Authorization": TATA_AUTH_TOKEN},
            ) as resp:
                body = await resp.text()
                log.info("TATA call/options transfer → %s %s", resp.status, body[:300])
                try:
                    data = json.loads(body)
                except ValueError:
                    data = {"raw": body}
                if resp.status >= 400:
                    return {"status": "error", "http_status": resp.status, "detail": data}
                return {"status": "ok", "message": "Transferring you to a human agent now.", "detail": data}
    except aiohttp.ClientError as exc:
        return {"status": "error", "message": f"TATA transfer request failed: {exc}"}


# ── TATA Media Streams WebSocket ──────────────────────────────────────────────

@router.websocket("/stream")
async def tata_stream(ws: WebSocket):
    await ws.accept()
    log.info("TATA media stream connected")

    if not GOOGLE_API_KEY:
        log.error("GOOGLE_API_KEY not configured")
        await ws.close()
        return

    stream_sid: str | None = None
    tata_call_sid: str | None = None
    caller_number: str | None = None
    in_state = None
    out_state = None
    out_buf = bytearray()       # μ-law bytes pending 160-byte framing
    log_id: int | None = None
    transfer_state = {"active": False}
    # Updated whenever a tool response carries a `transfer_number` (e.g. an agent
    # availability lookup returns {"transfer_number": "1003"}). transfer_call then
    # routes to that extension instead of the static TATA_TRANSFER_CODE.
    last_transfer = {"number": None}

    call_cfg: dict | None = None

    # ── Wait for the TATA `start` event, then resolve the agent/config ────────
    try:
        while stream_sid is None:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            event = msg.get("event")
            if event == "start":
                start = msg.get("start", {}) or {}
                stream_sid    = msg.get("streamSid") or start.get("streamSid")
                tata_call_sid = start.get("callSid")
                caller_number = start.get("from")
                to_number     = start.get("to")
                log.info("TATA stream %s started (call %s, from %s)", stream_sid, tata_call_sid, caller_number)

                # Outbound calls left a config keyed by destination number.
                call_cfg = _pop_call_config(to_number, caller_number)
                if call_cfg:
                    call_prompt        = call_cfg["system_prompt"]
                    call_first_message = call_cfg.get("first_message") or None
                    call_language      = call_cfg["language"]
                    call_voice         = call_cfg["voice"]
                    call_tool_ids      = list(call_cfg.get("tool_ids") or [])
                    call_kb_ids        = list(call_cfg.get("kb_collection_ids") or [])
                    _ambient_always_slug    = call_cfg.get("ambient_always") or None
                    _ambient_tool_call_slug = call_cfg.get("ambient_tool_call") or None
                    _ambient_vol            = float(call_cfg.get("ambient_volume") or 0.15)
                    call_transfer_code = call_cfg.get("transfer_code") or TATA_TRANSFER_CODE
                    direction = "outbound"
                    phone_number = call_cfg.get("to") or caller_number
                else:
                    _agent = await get_default_phone_agent()
                    call_prompt        = _agent.system_prompt if _agent else PHONE_SYSTEM_PROMPT
                    call_first_message = getattr(_agent, "first_message", None) if _agent else None
                    call_language      = _agent.language if _agent else PHONE_LANGUAGE
                    call_voice         = _agent.voice if _agent else "Aoede"
                    call_tool_ids      = list(_agent.tool_ids or []) if _agent else []
                    call_kb_ids        = list(getattr(_agent, "kb_collection_ids", None) or []) if _agent else []
                    _ambient_always_slug    = getattr(_agent, "ambient_always", None) if _agent else None
                    _ambient_tool_call_slug = getattr(_agent, "ambient_tool_call", None) if _agent else None
                    _ambient_vol            = getattr(_agent, "ambient_volume", 0.15) if _agent else 0.15
                    call_transfer_code = TATA_TRANSFER_CODE
                    direction = "inbound"
                    phone_number = caller_number

                call_tools   = await build_gemini_tools(call_tool_ids, call_kb_ids)
                always_mixer = AmbientMixer(_ambient_always_slug,    OUTPUT_SAMPLE_RATE, _ambient_vol)
                tool_mixer   = AmbientMixer(_ambient_tool_call_slug, OUTPUT_SAMPLE_RATE, _ambient_vol)

                log_id = await start_call(
                    call_type="tata",
                    direction=direction,
                    phone_number=phone_number,
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

    client_closed = False
    reconnect_count = 0
    # Consecutive Gemini server errors (503 high-demand / UNAVAILABLE) with no
    # productive session in between. Reset whenever a session yields audio, so a
    # transient blip recovers but a sustained outage ends the call gracefully.
    server_error_streak = 0
    MAX_SERVER_ERROR_STREAK = 6

    try:
        while not client_closed:
            productive_box = {"hit": False}
            try:
                async with client.aio.live.connect(
                    model=MODEL,
                    config=_make_live_config(call_prompt, call_language, call_voice, tools=call_tools),
                ) as session:
                    if reconnect_count:
                        log.debug("Gemini Live reconnected (attempt %d)", reconnect_count)

                    # Greeting: speak the configured first message on connect
                    # (only on the very first session, not after a reconnect).
                    if call_first_message and reconnect_count == 0:
                        greeting = render_template(call_first_message, build_call_context(
                            caller_id=caller_number, call_sid=tata_call_sid or stream_sid, conversation_id=log_id,
                        ))
                        try:
                            await session.send_client_content(
                                turns=types.Content(role="user", parts=[types.Part(
                                    text=("[system] The call just connected. Begin now by saying the "
                                          "following greeting verbatim, then stop and wait for the caller:\n"
                                          f"\"{greeting}\"")
                                )]),
                                turn_complete=True,
                            )
                        except Exception:
                            log.exception("Failed to send greeting")

                    async def tata_to_gemini():
                        nonlocal in_state, client_closed
                        while True:
                            try:
                                raw = await ws.receive_text()
                            except WebSocketDisconnect:
                                client_closed = True
                                return
                            msg = json.loads(raw)
                            event = msg.get("event")
                            if event == "media":
                                payload = (msg.get("media") or {}).get("payload", "")
                                if not payload:
                                    continue
                                mulaw = base64.b64decode(payload)
                                pcm16k, in_state = _mulaw8k_to_pcm16k(mulaw, in_state)
                                try:
                                    await session.send_realtime_input(
                                        audio=types.Blob(data=pcm16k, mime_type=f"audio/pcm;rate={INPUT_SAMPLE_RATE}")
                                    )
                                except Exception:
                                    return
                            elif event == "dtmf":
                                log.info("TATA DTMF digit=%s", (msg.get("dtmf") or {}).get("digit"))
                            elif event == "stop":
                                log.info("TATA stream %s stopped", stream_sid)
                                client_closed = True
                                return

                    async def gemini_to_tata():
                        nonlocal out_state, out_buf
                        _FILLER_BYTES = (OUTPUT_SAMPLE_RATE // 25) * 2  # 40 ms @ 24 kHz PCM16
                        _FILLER_SILENCE = b"\x00" * _FILLER_BYTES
                        filler_box: dict = {"task": None}

                        async def _send_mixed(pcm24k: bytes):
                            nonlocal out_state, out_buf
                            if not stream_sid:
                                return
                            mulaw, out_state = _pcm24k_to_mulaw8k(pcm24k, out_state)
                            out_buf.extend(mulaw)
                            # Flush in fixed 160-byte μ-law frames (TATA requirement).
                            while len(out_buf) >= TATA_FRAME_BYTES:
                                frame = bytes(out_buf[:TATA_FRAME_BYTES])
                                del out_buf[:TATA_FRAME_BYTES]
                                try:
                                    await ws.send_text(json.dumps({
                                        "event": "media",
                                        "streamSid": stream_sid,
                                        "media": {"payload": base64.b64encode(frame).decode()},
                                    }))
                                except Exception:
                                    return

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
                                        if (always_mixer.enabled or tool_mixer.enabled) and filler_box["task"] is None:
                                            filler_box["task"] = asyncio.create_task(_filler_loop())
                                        tool_responses = []
                                        did_transfer = False
                                        for fc in tc.function_calls:
                                            _args = dict(fc.args or {})
                                            tool_meta: dict = {}
                                            if fc.name == "transfer_call":
                                                # Warm hand-off to a TATA agent/department via the
                                                # Call Options API. Target priority:
                                                #   1. explicit intercom/transfer_number in the call
                                                #   2. transfer_number returned by an earlier tool
                                                #      (e.g. agent-availability lookup → "1003")
                                                #   3. static TATA_TRANSFER_CODE fallback
                                                intercom = str(
                                                    _args.get("intercom")
                                                    or _args.get("transfer_number")
                                                    or last_transfer["number"]
                                                    or call_transfer_code
                                                    or ""
                                                )
                                                result = await _tata_transfer(tata_call_sid, intercom)
                                                if result.get("status") == "ok":
                                                    did_transfer = True
                                            else:
                                                result = await dispatch_tool_call(
                                                    call_tool_ids, fc.name, _args,
                                                    kb_collection_ids=call_kb_ids,
                                                    context=build_call_context(
                                                        caller_id=caller_number,
                                                        call_sid=tata_call_sid or stream_sid,
                                                        conversation_id=log_id,
                                                    ),
                                                    meta_out=tool_meta,
                                                )
                                                # Capture a transfer_number surfaced by any tool so a
                                                # later transfer_call routes to that exact extension.
                                                if isinstance(result, dict) and result.get("transfer_number"):
                                                    last_transfer["number"] = str(result["transfer_number"])
                                                    log.info("📌 captured transfer_number=%s from %s",
                                                             last_transfer["number"], fc.name)
                                            log.info("🔧 tool %s(%s) → %s", fc.name, _args, result)
                                            await add_tool_event(log_id, fc.name, _args, result, request=tool_meta or None)
                                            tool_responses.append(
                                                types.FunctionResponse(id=fc.id, name=fc.name, response=result)
                                            )
                                        await session.send_tool_response(function_responses=tool_responses)
                                        if did_transfer:
                                            # Stop forwarding agent audio and tear down Gemini;
                                            # TATA now owns the call leg. Keep the WS open so the
                                            # PBX can complete the bridge to the human agent.
                                            transfer_state["active"] = True
                                            log.info("Transfer accepted by TATA — releasing call to human agent")
                                            await _stop_filler()
                                            return
                                        continue

                                    sc = response.server_content
                                    # Barge-in: caller interrupted → flush TATA playback + our buffer
                                    if sc and sc.interrupted and stream_sid:
                                        out_buf.clear()
                                        await ws.send_text(json.dumps({"event": "clear", "streamSid": stream_sid}))
                                    if response.data and stream_sid:
                                        productive_box["hit"] = True
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
                            asyncio.create_task(tata_to_gemini(), name="t2g"),
                            asyncio.create_task(gemini_to_tata(), name="g2t"),
                        ],
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for t in pending:
                        t.cancel()
                        try:
                            await t
                        except asyncio.CancelledError:
                            pass
                    for t in done:
                        exc = t.exception()
                        if exc and not isinstance(exc, WebSocketDisconnect):
                            raise exc

                # A session that produced audio means Gemini is healthy again —
                # clear any accumulated server-error streak.
                if productive_box["hit"]:
                    server_error_streak = 0

                if transfer_state["active"] or client_closed:
                    break

            except WebSocketDisconnect:
                client_closed = True
                break
            except Exception as exc:
                code = getattr(exc, "code", None)
                msg_s = str(exc)
                exc_type = type(exc).__name__

                # Transient Gemini server overload (503 high-demand / UNAVAILABLE /
                # 500). Back off and retry — but give up after a sustained streak so
                # we don't loop on dead air through a real outage. Reconnecting opens
                # a fresh session (conversation context is lost), which is still far
                # better than dropping the live call on a momentary blip.
                if (
                    "ServerError" in exc_type
                    or code in (500, 503)
                    or "503" in msg_s or "500" in msg_s
                    or "UNAVAILABLE" in msg_s or "high demand" in msg_s or "overloaded" in msg_s
                ):
                    server_error_streak += 1
                    if server_error_streak > MAX_SERVER_ERROR_STREAK:
                        log.error("Gemini unavailable after %d consecutive 503s — ending call",
                                  server_error_streak)
                        break
                    backoff = min(0.5 * server_error_streak, 3.0)
                    reconnect_count += 1
                    log.warning("Gemini 503/unavailable (%s) — retry #%d in %.1fs",
                                msg_s[:80], server_error_streak, backoff)
                    await asyncio.sleep(backoff)
                    continue

                # Socket-level drops (preview models drop with 1006/1011 roughly
                # every turn) — re-open the Gemini session without closing TATA.
                if (
                    "APIError" in exc_type or "ConnectionClosed" in exc_type
                    or isinstance(exc, (ConnectionResetError, BrokenPipeError))
                    or code in (1006, 1011)
                    or "abnormal closure" in msg_s or "1006" in msg_s or "1011" in msg_s
                ):
                    reconnect_count += 1
                    log.debug("Gemini reset (%s: %s) — reconnecting (#%d)", exc_type, msg_s[:60], reconnect_count)
                    await asyncio.sleep(0.3)
                    continue
                raise

        # ── Post-transfer: Gemini is closed but the caller is still on the line
        # being bridged to a human. Keep the TATA WS open (draining events) until
        # the PBX tears the call down, so we don't drop the leg mid-transfer.
        if transfer_state["active"]:
            log.info("Transfer in progress — holding TATA stream open until call ends")
            try:
                while True:
                    raw = await ws.receive_text()
                    if json.loads(raw).get("event") == "stop":
                        break
            except WebSocketDisconnect:
                pass

    except WebSocketDisconnect:
        log.info("TATA stream disconnected (stream_sid=%s)", stream_sid)
    except Exception as exc:
        log.exception("TATA bridge error")
        await end_call(log_id, status="error", error_message=str(exc))
        return
    finally:
        await end_call(log_id, api_key=GOOGLE_API_KEY or None)
