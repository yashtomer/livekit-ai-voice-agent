"""
Gemini Live Voice Agent — FastAPI WebSocket Bridge

WebSocket endpoint: /gemini/ws?token=<jwt>
  Browser → Backend : binary frames = raw Int16 PCM @ 16 kHz
                      text frames   = JSON {"type":"config","system_prompt":"...","language":"en"}
  Backend → Browser : binary frames = raw Int16 PCM @ 24 kHz
                      text frames   = JSON control messages
"""

import asyncio
import json
import logging
import os
import time

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from ..db import SessionLocal
from ..models.user import User, UserRole
from ..models.api_key import UserAPIKey
from ..services.auth import decode_token
from ..services.encryption import decrypt_key

log = logging.getLogger("gemini_call")

router = APIRouter()

SERVER_GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
MODEL = "gemini-3.1-flash-live-preview"
INPUT_SAMPLE_RATE = 16000

LANGUAGE_NAMES = {
    "en": "English", "hi": "Hindi", "bn": "Bengali", "ta": "Tamil",
    "te": "Telugu", "mr": "Marathi", "gu": "Gujarati", "es": "Spanish",
    "fr": "French", "de": "German", "ja": "Japanese", "ko": "Korean", "zh": "Chinese",
}

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful, friendly voice assistant. "
    "Keep answers concise and conversational — this is a real-time voice call."
)


async def _resolve_api_key(token: str) -> tuple[str | None, bool]:
    """
    Returns (api_key, is_admin).
    - Authenticates the JWT token.
    - Fetches the user's stored Google API key.
    - Admins fall back to the server key if they haven't set one.
    - Regular users get None if no key is configured.
    """
    try:
        payload = decode_token(token)
        user_id = int(payload["sub"])
    except Exception:
        return None, False

    async with SessionLocal() as db:
        result = await db.execute(
            select(User).where(User.id == user_id, User.is_active == True)  # noqa: E712
        )
        user = result.scalar_one_or_none()
        if not user:
            return None, False

        is_admin = user.role == UserRole.admin

        result = await db.execute(
            select(UserAPIKey).where(
                UserAPIKey.user_id == user_id,
                UserAPIKey.provider == "google",
            )
        )
        key_row = result.scalar_one_or_none()

        if key_row:
            return decrypt_key(key_row.encrypted_key), is_admin

        # Admin without personal key: use server key
        if is_admin and SERVER_GOOGLE_API_KEY:
            return SERVER_GOOGLE_API_KEY, True

        return None, is_admin


def _make_live_config(system_prompt: str, language: str, voice: str = "Aoede"):
    from google.genai import types

    lang_name = LANGUAGE_NAMES.get(language, "English")
    lang_note = f"\n\nCRITICAL: Respond ONLY in {lang_name}. Every word must be in {lang_name}."
    return types.LiveConnectConfig(
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
            parts=[types.Part(text=system_prompt + lang_note)]
        ),
    )


async def _send(ws: WebSocket, obj: dict) -> None:
    try:
        await ws.send_text(json.dumps(obj))
    except Exception:
        pass


@router.websocket("/ws")
async def gemini_ws(websocket: WebSocket, token: str = Query(default="")):
    await websocket.accept()

    # Resolve API key from the user's stored Google key
    api_key, _is_admin = await _resolve_api_key(token)

    if not api_key:
        await _send(websocket, {
            "type": "error",
            "code": "no_api_key",
            "message": "Google (Gemini) API key not configured. Please add it in Config → Google (Gemini).",
        })
        await websocket.close()
        return

    # Receive initial config message
    system_prompt = DEFAULT_SYSTEM_PROMPT
    language = "en"
    voice = "Aoede"
    try:
        msg = await asyncio.wait_for(websocket.receive(), timeout=5.0)
        raw = msg.get("text") or ""
        if raw:
            cfg = json.loads(raw)
            if cfg.get("type") == "config":
                system_prompt = cfg.get("system_prompt", "").strip() or DEFAULT_SYSTEM_PROMPT
                language = cfg.get("language", "en").strip()
                voice = cfg.get("voice", "Aoede").strip() or "Aoede"
    except (asyncio.TimeoutError, json.JSONDecodeError):
        pass

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key, http_options={"api_version": "v1alpha"})

        async with client.aio.live.connect(model=MODEL, config=_make_live_config(system_prompt, language, voice)) as session:
            await _send(websocket, {"type": "status", "state": "idle"})

            async def frontend_to_gemini():
                while True:
                    try:
                        msg = await websocket.receive()
                    except WebSocketDisconnect:
                        return
                    raw_bytes = msg.get("bytes")
                    if raw_bytes:
                        await session.send_realtime_input(
                            audio=types.Blob(
                                data=bytes(raw_bytes),
                                mime_type=f"audio/pcm;rate={INPUT_SAMPLE_RATE}",
                            )
                        )

            async def gemini_to_frontend():
                while True:
                    user_chunks: list[str] = []
                    model_chunks: list[str] = []
                    sent_speaking = False
                    user_end_ts = None
                    first_audio_ts = None

                    async for response in session.receive():
                        if response.data:
                            if first_audio_ts is None:
                                first_audio_ts = time.monotonic()
                                if user_end_ts is not None:
                                    log.info("⏱ user→first audio: %.0f ms", (first_audio_ts - user_end_ts) * 1000)
                            try:
                                await websocket.send_bytes(response.data)
                            except Exception:
                                return
                            if not sent_speaking:
                                await _send(websocket, {"type": "status", "state": "speaking"})
                                sent_speaking = True

                        sc = response.server_content
                        if sc is None:
                            continue

                        if sc.interrupted:
                            await _send(websocket, {"type": "interrupted"})
                            await _send(websocket, {"type": "status", "state": "listening"})
                            model_chunks = []
                            sent_speaking = False
                            first_audio_ts = None
                            user_end_ts = None

                        if sc.input_transcription and sc.input_transcription.text:
                            user_chunks.append(sc.input_transcription.text)
                            if user_end_ts is None:
                                user_end_ts = time.monotonic()
                        if sc.output_transcription and sc.output_transcription.text:
                            model_chunks.append(sc.output_transcription.text)

                        if sc.turn_complete:
                            if user_chunks:
                                text = "".join(user_chunks).strip()
                                if text:
                                    await _send(websocket, {"type": "transcript", "role": "user", "text": text})
                            if model_chunks:
                                text = "".join(model_chunks).strip()
                                if text:
                                    await _send(websocket, {"type": "transcript", "role": "model", "text": text})
                            await _send(websocket, {"type": "status", "state": "listening"})

                    await asyncio.sleep(0)

            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(frontend_to_gemini(), name="f2g"),
                    asyncio.create_task(gemini_to_frontend(), name="g2f"),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            for task in done:
                exc = task.exception()
                if exc and not isinstance(exc, WebSocketDisconnect):
                    raise exc

    except WebSocketDisconnect:
        log.info("Gemini WS: client disconnected")
    except Exception as exc:
        log.exception("Gemini WS error: %s", exc)
        await _send(websocket, {"type": "error", "message": str(exc)})
