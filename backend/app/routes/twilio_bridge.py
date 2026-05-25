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

log = logging.getLogger("twilio_bridge")

router = APIRouter()

GOOGLE_API_KEY   = os.environ.get("GOOGLE_API_KEY", "")
PUBLIC_HOST      = os.environ.get("PUBLIC_HOST", "").strip()
PHONE_LANGUAGE   = os.environ.get("PHONE_LANGUAGE", "en")
TWILIO_ACCOUNT_SID  = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_API_KEY      = os.environ.get("TWILIO_API_KEY", "").strip()
TWILIO_API_SECRET   = os.environ.get("TWILIO_API_SECRET", "").strip()
TWILIO_TWIML_APP_SID = os.environ.get("TWILIO_TWIML_APP_SID", "").strip()

MODEL = "gemini-3.1-flash-live-preview"
INPUT_SAMPLE_RATE = 16000

PHONE_SYSTEM_PROMPT = os.environ.get("PHONE_SYSTEM_PROMPT") or (
    "You are a professional medical appointment booking assistant. "
    "Be concise and conversational. "
    "Greet the patient, collect name, doctor/department, date & time (9am-5pm), "
    "confirm availability, ask for remarks, confirm booking details, then say goodbye."
)

LANGUAGE_NAMES = {
    "en": "English", "hi": "Hindi", "bn": "Bengali", "ta": "Tamil",
    "te": "Telugu", "mr": "Marathi", "gu": "Gujarati", "es": "Spanish",
    "fr": "French", "de": "German", "ja": "Japanese", "ko": "Korean", "zh": "Chinese",
}


def _make_live_config(system_prompt: str, language: str):
    from google import genai as _genai  # noqa: F401 — triggers ImportError early if missing
    from google.genai import types

    lang_name = LANGUAGE_NAMES.get(language, "English")
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
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
    host = PUBLIC_HOST or request.url.hostname
    ws_url = f"wss://{host}/api/twilio/stream"
    log.info("/twilio/voice → stream %s", ws_url)
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="{ws_url}" />
  </Connect>
</Response>"""
    return Response(content=twiml, media_type="application/xml")


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
    in_state = None
    out_state = None

    try:
        while stream_sid is None:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            if msg.get("event") == "start":
                stream_sid = msg["start"]["streamSid"]
                log.info("Stream %s started", stream_sid)
            elif msg.get("event") == "stop":
                return
    except WebSocketDisconnect:
        return

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=GOOGLE_API_KEY, http_options={"api_version": "v1alpha"})

    try:
        async with client.aio.live.connect(
            model=MODEL,
            config=_make_live_config(PHONE_SYSTEM_PROMPT, PHONE_LANGUAGE),
        ) as session:

            async def twilio_to_gemini():
                nonlocal in_state
                while True:
                    raw = await ws.receive_text()
                    msg = json.loads(raw)
                    if msg.get("event") == "media":
                        mulaw = base64.b64decode(msg["media"]["payload"])
                        pcm16k, in_state = _mulaw8k_to_pcm16k(mulaw, in_state)
                        await session.send_realtime_input(
                            audio=types.Blob(data=pcm16k, mime_type=f"audio/pcm;rate={INPUT_SAMPLE_RATE}")
                        )
                    elif msg.get("event") == "stop":
                        return

            async def gemini_to_twilio():
                nonlocal out_state
                while True:
                    async for response in session.receive():
                        sc = response.server_content
                        if sc and sc.interrupted and stream_sid:
                            await ws.send_text(json.dumps({"event": "clear", "streamSid": stream_sid}))
                        if response.data and stream_sid:
                            mulaw, out_state = _pcm24k_to_mulaw8k(response.data, out_state)
                            await ws.send_text(json.dumps({
                                "event": "media",
                                "streamSid": stream_sid,
                                "media": {"payload": base64.b64encode(mulaw).decode()},
                            }))
                        if sc and sc.input_transcription and sc.input_transcription.text:
                            log.info("👤 %s", sc.input_transcription.text)
                        if sc and sc.output_transcription and sc.output_transcription.text:
                            log.info("🤖 %s", sc.output_transcription.text)
                    await asyncio.sleep(0)

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

    except WebSocketDisconnect:
        log.info("Twilio stream disconnected (stream_sid=%s)", stream_sid)
    except Exception:
        log.exception("Twilio bridge error")
