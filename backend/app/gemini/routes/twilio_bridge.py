"""
Twilio ↔ Gemini Live bridge.

Routes (prefix /twilio):
  POST /voice   — TwiML webhook Twilio hits when the number is called
  GET  /token   — JWT access token for browser-based Twilio Voice SDK
  WS   /stream  — Twilio Media Streams WebSocket (μ-law 8 kHz ↔ Gemini PCM16)
"""

import asyncio
import audioop
import base64
import json
import logging
import os

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import Response, JSONResponse

from ..services.logger import start_call, add_transcript, add_tool_event, end_call
from ..services.agents_store import get_default_phone_agent
from ..services.tools_runtime import build_gemini_tools, dispatch_tool_call
from ..services.transfer import twilio_transfer, resolve_transfer_number
from ..agents import DEFAULT_PHONE_AGENT
from ..ambience import AmbientMixer

OUTPUT_SAMPLE_RATE = 24000

log = logging.getLogger("twilio_bridge")

router = APIRouter()

GOOGLE_API_KEY   = os.environ.get("GOOGLE_API_KEY", "")
PHONE_LANGUAGE   = os.environ.get("PHONE_LANGUAGE", "en")
TWILIO_ACCOUNT_SID  = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_API_KEY      = os.environ.get("TWILIO_API_KEY", "").strip()
TWILIO_API_SECRET   = os.environ.get("TWILIO_API_SECRET", "").strip()
TWILIO_TWIML_APP_SID = os.environ.get("TWILIO_TWIML_APP_SID", "").strip()
TWILIO_PHONE_NUMBER  = os.environ.get("TWILIO_PHONE_NUMBER", "").strip()

MODEL = "gemini-3.1-flash-live-preview"
INPUT_SAMPLE_RATE = 16000

PHONE_SYSTEM_PROMPT = os.environ.get("PHONE_SYSTEM_PROMPT") or DEFAULT_PHONE_AGENT

LANGUAGE_NAMES = {
    "en": "English", "hi": "Hindi", "bn": "Bengali", "ta": "Tamil",
    "te": "Telugu", "mr": "Marathi", "gu": "Gujarati", "es": "Spanish",
    "fr": "French", "de": "German", "ja": "Japanese", "ko": "Korean", "zh": "Chinese",
}


def _make_live_config(system_prompt: str, language: str, voice: str = "Aoede", tools=None):
    from google import genai as _genai  # noqa: F401 — triggers ImportError early if missing
    from google.genai import types

    lang_name = LANGUAGE_NAMES.get(language, "English")
    return types.LiveConnectConfig(
        tools=tools or [],
        response_modalities=["AUDIO"],
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
                text=system_prompt + f"\n\nCRITICAL: Respond ONLY in {lang_name}."
            )]
        ),
    )


# ── TwiML webhook ─────────────────────────────────────────────────────────────

@router.post("/voice")
@router.get("/voice")
async def voice_webhook(request: Request):
    host = request.url.hostname
    ws_url = f"wss://{host}/api/twilio/stream"
    log.info("/twilio/voice → stream %s", ws_url)
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="{ws_url}" />
  </Connect>
</Response>"""
    return Response(content=twiml, media_type="application/xml")


# ── Config endpoint (URLs to paste into Twilio dashboard) ─────────────────────

@router.get("/config")
async def twilio_config(request: Request):
    host = request.url.hostname
    return JSONResponse({
        "public_host": host,
        "voice_webhook_url":  f"https://{host}/api/twilio/voice",
        "voice_webhook_method": "POST",
        "stream_ws_url":      f"wss://{host}/api/twilio/stream",
        "twiml_app_sid":      TWILIO_TWIML_APP_SID or None,
        "phone_number":       TWILIO_PHONE_NUMBER or None,
        "missing_env": [
            n for n, v in [
                ("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID),
                ("TWILIO_API_KEY", TWILIO_API_KEY),
                ("TWILIO_API_SECRET", TWILIO_API_SECRET),
                ("TWILIO_TWIML_APP_SID", TWILIO_TWIML_APP_SID),
            ] if not v
        ],
    })


# ── Twilio Voice SDK access token ─────────────────────────────────────────────

@router.get("/token")
async def twilio_token(identity: str = "browser-user"):
    missing = [
        name for name, val in [
            ("TWILIO_ACCOUNT_SID",    TWILIO_ACCOUNT_SID),
            ("TWILIO_API_KEY",        TWILIO_API_KEY),
            ("TWILIO_API_SECRET",     TWILIO_API_SECRET),
            ("TWILIO_TWIML_APP_SID",  TWILIO_TWIML_APP_SID),
        ] if not val
    ]
    if missing:
        raise HTTPException(status_code=500, detail=f"Missing Twilio env vars: {', '.join(missing)}")
    if not GOOGLE_API_KEY:
        raise HTTPException(status_code=500, detail="GOOGLE_API_KEY not configured on server.")

    from twilio.jwt.access_token import AccessToken
    from twilio.jwt.access_token.grants import VoiceGrant

    token = AccessToken(
        TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET,
        identity=identity, ttl=3600,
    )
    token.add_grant(VoiceGrant(
        outgoing_application_sid=TWILIO_TWIML_APP_SID,
        incoming_allow=False,
    ))
    return JSONResponse({"token": token.to_jwt(), "identity": identity})


# ── Audio transcoding helpers ─────────────────────────────────────────────────

def _mulaw8k_to_pcm16k(mulaw_bytes: bytes, state):
    pcm8k = audioop.ulaw2lin(mulaw_bytes, 2)
    pcm16k, state = audioop.ratecv(pcm8k, 2, 1, 8000, 16000, state)
    return pcm16k, state


def _pcm24k_to_mulaw8k(pcm24k_bytes: bytes, state):
    pcm8k, state = audioop.ratecv(pcm24k_bytes, 2, 1, 24000, 8000, state)
    return audioop.lin2ulaw(pcm8k, 2), state


# ── Twilio Media Streams WebSocket ────────────────────────────────────────────

@router.websocket("/stream")
async def twilio_stream(ws: WebSocket):
    await ws.accept()
    log.info("Twilio media stream connected")

    if not GOOGLE_API_KEY:
        await ws.close()
        return

    stream_sid: str | None = None
    twilio_call_sid: str | None = None
    in_state = None
    out_state = None
    call_id: int | None = None

    try:
        while stream_sid is None:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            if msg.get("event") == "start":
                stream_sid = msg["start"]["streamSid"]
                twilio_call_sid = (msg.get("start") or {}).get("callSid")
                log.info("Stream %s started (call %s)", stream_sid, twilio_call_sid)
                custom = (msg.get("start") or {}).get("customParameters") or {}
                # Resolve default agent from DB; fall back to the env/static prompt.
                _agent = await get_default_phone_agent()
                call_prompt   = _agent.system_prompt if _agent else PHONE_SYSTEM_PROMPT
                call_language = _agent.language      if _agent else PHONE_LANGUAGE
                call_voice    = _agent.voice         if _agent else "Aoede"
                call_tool_ids = list(_agent.tool_ids or []) if _agent else []
                call_kb_ids   = list(getattr(_agent, "kb_collection_ids", None) or []) if _agent else []
                call_tools    = await build_gemini_tools(call_tool_ids, call_kb_ids)
                _ambient_always_slug    = getattr(_agent, "ambient_always", None) if _agent else None
                _ambient_tool_call_slug = getattr(_agent, "ambient_tool_call", None) if _agent else None
                _ambient_vol            = getattr(_agent, "ambient_volume", 0.15) if _agent else 0.15
                # Mix into 24 kHz PCM (pre-resample); the existing 24→8 kHz
                # μ-law stage downstream stays untouched.
                always_mixer = AmbientMixer(_ambient_always_slug,    OUTPUT_SAMPLE_RATE, _ambient_vol)
                tool_mixer   = AmbientMixer(_ambient_tool_call_slug, OUTPUT_SAMPLE_RATE, _ambient_vol)
                call_id = await start_call(
                    call_type="twilio",
                    direction="inbound",
                    phone_number=custom.get("From") or custom.get("from"),
                    language=call_language,
                    voice=call_voice,
                    system_prompt=call_prompt,
                )
            elif msg.get("event") == "stop":
                return
    except WebSocketDisconnect:
        return

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=GOOGLE_API_KEY, http_options={"api_version": "v1alpha"})

    client_closed = False
    reconnect_count = 0

    try:
        while not client_closed:
            try:
                async with client.aio.live.connect(
                    model=MODEL,
                    config=_make_live_config(call_prompt, call_language, call_voice, tools=call_tools),
                ) as session:
                    if reconnect_count:
                        log.debug("Gemini Live reconnected (attempt %d)", reconnect_count)

                    async def twilio_to_gemini():
                        nonlocal in_state, client_closed
                        while True:
                            try:
                                raw = await ws.receive_text()
                            except WebSocketDisconnect:
                                client_closed = True
                                return
                            msg = json.loads(raw)
                            if msg.get("event") == "media":
                                mulaw = base64.b64decode(msg["media"]["payload"])
                                pcm16k, in_state = _mulaw8k_to_pcm16k(mulaw, in_state)
                                try:
                                    await session.send_realtime_input(
                                        audio=types.Blob(data=pcm16k, mime_type=f"audio/pcm;rate={INPUT_SAMPLE_RATE}")
                                    )
                                except Exception:
                                    return
                            elif msg.get("event") == "stop":
                                client_closed = True
                                return

                    async def gemini_to_twilio():
                        nonlocal out_state
                        _FILLER_BYTES = (OUTPUT_SAMPLE_RATE // 25) * 2  # 40 ms @ 24 kHz PCM16
                        _FILLER_SILENCE = b"\x00" * _FILLER_BYTES
                        filler_box: dict = {"task": None}

                        async def _send_mixed(pcm24k: bytes):
                            nonlocal out_state
                            if not stream_sid:
                                return
                            mulaw, out_state = _pcm24k_to_mulaw8k(pcm24k, out_state)
                            try:
                                await ws.send_text(json.dumps({
                                    "event": "media",
                                    "streamSid": stream_sid,
                                    "media": {"payload": base64.b64encode(mulaw).decode()},
                                }))
                            except Exception:
                                return

                        async def _filler_loop():
                            try:
                                while True:
                                    mixed = always_mixer.mix(tool_mixer.mix(_FILLER_SILENCE))
                                    await _send_mixed(mixed)
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
                                    # Tool calls from Gemini
                                    tc = getattr(response, "tool_call", None)
                                    if tc and tc.function_calls:
                                        if (
                                            (always_mixer.enabled or tool_mixer.enabled)
                                            and filler_box["task"] is None
                                        ):
                                            filler_box["task"] = asyncio.create_task(_filler_loop())
                                        tool_responses = []
                                        for fc in tc.function_calls:
                                            _args = dict(fc.args or {})
                                            if fc.name == "transfer_call":
                                                result = await twilio_transfer(
                                                    twilio_call_sid,
                                                    resolve_transfer_number(),
                                                    str(_args.get("reason") or ""),
                                                )
                                            else:
                                                result = await dispatch_tool_call(call_tool_ids, fc.name, _args, kb_collection_ids=call_kb_ids)
                                            log.info("🔧 tool %s(%s) → %s", fc.name, _args, result)
                                            await add_tool_event(call_id, fc.name, _args, result)
                                            tool_responses.append(
                                                types.FunctionResponse(id=fc.id, name=fc.name, response=result)
                                            )
                                        await session.send_tool_response(function_responses=tool_responses)
                                        continue

                                    sc = response.server_content
                                    if sc and sc.interrupted and stream_sid:
                                        await ws.send_text(json.dumps({"event": "clear", "streamSid": stream_sid}))
                                    if response.data and stream_sid:
                                        await _stop_filler()
                                        mixed = always_mixer.mix(response.data)
                                        await _send_mixed(mixed)
                                    if sc and sc.input_transcription and sc.input_transcription.text:
                                        log.info("👤 %s", sc.input_transcription.text)
                                        await add_transcript(call_id, "user", sc.input_transcription.text)
                                    if sc and sc.output_transcription and sc.output_transcription.text:
                                        log.info("🤖 %s", sc.output_transcription.text)
                                        await add_transcript(call_id, "model", sc.output_transcription.text)
                                await asyncio.sleep(0)
                        finally:
                            await _stop_filler()

                    done, pending = await asyncio.wait(
                        [
                            asyncio.create_task(twilio_to_gemini(), name="t2g"),
                            asyncio.create_task(gemini_to_twilio(), name="g2t"),
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

                if client_closed:
                    break

            except WebSocketDisconnect:
                client_closed = True
                break
            except Exception as exc:
                code = getattr(exc, "code", None)
                msg_s = str(exc)
                exc_type = type(exc).__name__
                if (
                    "APIError" in exc_type or
                    "ConnectionClosed" in exc_type or
                    isinstance(exc, (ConnectionResetError, BrokenPipeError)) or
                    (code in (1006, 1011)) or
                    "abnormal closure" in msg_s or
                    "1006" in msg_s or
                    "1011" in msg_s
                ):
                    reconnect_count += 1
                    log.debug("Gemini reset (%s: %s) — reconnecting (#%d)", exc_type, msg_s[:60], reconnect_count)
                    await asyncio.sleep(0.3)
                    continue
                raise

    except WebSocketDisconnect:
        log.info("Twilio stream disconnected (stream_sid=%s)", stream_sid)
    except Exception as exc:
        log.exception("Twilio bridge error")
        await end_call(call_id, status="error", error_message=str(exc))
        return
    finally:
        await end_call(call_id, api_key=GOOGLE_API_KEY or None)
