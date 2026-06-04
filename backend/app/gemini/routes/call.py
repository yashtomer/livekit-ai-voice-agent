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

from ...db import SessionLocal
from ...models.user import User, UserRole
from ...models.api_key import UserAPIKey
from ...services.auth import decode_token
from ...services.encryption import decrypt_key
from ..services.logger import start_call, add_transcript, add_tool_event, end_call
from ..services.sentiment import score_text
from ..ambience import AmbientMixer

OUTPUT_SAMPLE_RATE = 24000

log = logging.getLogger("gemini_call")

router = APIRouter()

SERVER_GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
MODEL = os.environ.get("GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview")
API_VERSION = os.environ.get("GEMINI_API_VERSION", "v1alpha")
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


def _make_live_config(system_prompt: str, language: str, voice: str = "Aoede", tools=None):
    from google.genai import types

    lang_name = LANGUAGE_NAMES.get(language, "English")
    lang_note = f"\n\nCRITICAL: Respond ONLY in {lang_name}. Every word must be in {lang_name}."
    cfg = types.LiveConnectConfig(
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
        tools=tools or [],
        system_instruction=types.Content(
            parts=[types.Part(text=system_prompt + lang_note)]
        ),
    )
    return cfg


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
    first_message: str | None = None
    language = "en"
    voice = "Aoede"
    tool_ids: list[int] = []
    kb_collection_ids: list[int] = []
    ambient_always: str | None = None
    ambient_tool_call: str | None = None
    ambient_volume = 0.15
    try:
        msg = await asyncio.wait_for(websocket.receive(), timeout=5.0)
        raw = msg.get("text") or ""
        if raw:
            cfg = json.loads(raw)
            if cfg.get("type") == "config":
                system_prompt = cfg.get("system_prompt", "").strip() or DEFAULT_SYSTEM_PROMPT
                first_message = (cfg.get("first_message") or "").strip() or None
                language = cfg.get("language", "en").strip()
                voice = cfg.get("voice", "Aoede").strip() or "Aoede"
                raw_ids = cfg.get("tool_ids") or []
                if isinstance(raw_ids, list):
                    tool_ids = [int(t) for t in raw_ids if isinstance(t, (int, str)) and str(t).isdigit()]
                raw_kb = cfg.get("kb_collection_ids") or []
                if isinstance(raw_kb, list):
                    kb_collection_ids = [int(t) for t in raw_kb if isinstance(t, (int, str)) and str(t).isdigit()]
                ambient_always = (cfg.get("ambient_always") or None) or None
                ambient_tool_call = (cfg.get("ambient_tool_call") or None) or None
                try:
                    ambient_volume = float(cfg.get("ambient_volume", ambient_volume))
                except (TypeError, ValueError):
                    pass
    except (asyncio.TimeoutError, json.JSONDecodeError):
        pass

    # Outgoing ambient mixers. Both can be active simultaneously: `always` plays
    # at low volume continuously, `tool_call` adds typing/clicking only while a
    # tool call is in flight (filler frames bridge the silent gap).
    always_mixer = AmbientMixer(ambient_always, OUTPUT_SAMPLE_RATE, ambient_volume)
    tool_mixer   = AmbientMixer(ambient_tool_call, OUTPUT_SAMPLE_RATE, ambient_volume)
    # 40 ms ambient-filler frame at 24 kHz PCM16 mono.
    _FILLER_BYTES = (OUTPUT_SAMPLE_RATE // 25) * 2
    _FILLER_SILENCE = b"\x00" * _FILLER_BYTES

    async def _ambient_filler():
        """Stream ambient-only frames while Gemini is silent (tool-call gap)."""
        try:
            while True:
                with_tool = tool_mixer.mix(_FILLER_SILENCE)
                mixed = always_mixer.mix(with_tool)
                try:
                    await websocket.send_bytes(mixed)
                except Exception:
                    return
                await asyncio.sleep(0.04)
        except asyncio.CancelledError:
            return

    # Resolve the agent's tools (if any)
    from ..services.tools_runtime import build_call_context, build_gemini_tools, dispatch_tool_call as _dispatch, render_template
    gemini_tools = await build_gemini_tools(tool_ids, kb_collection_ids)

    call_id = await start_call(
        call_type="browser",
        direction=None,
        language=language,
        voice=voice,
        system_prompt=system_prompt,
    )

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key, http_options={"api_version": API_VERSION})

        # Preview Live models (e.g. gemini-3.1-flash-live-preview) often get
        # reaped by the server after ~1 turn with a 1006 abnormal closure.
        # We loop here and silently reconnect Gemini while keeping the
        # browser WebSocket open, so the user experiences a continuous call.
        client_closed = False
        reconnect_count = 0

        await _send(websocket, {"type": "status", "state": "idle"})

        while not client_closed:
            try:
                async with client.aio.live.connect(
                    model=MODEL,
                    config=_make_live_config(system_prompt, language, voice, tools=gemini_tools),
                ) as session:
                    if reconnect_count:
                        log.info("Gemini Live reconnected (attempt %d)", reconnect_count)

                    # Greeting: speak the configured first message on the initial
                    # connect only (not on silent reconnects).
                    if first_message and reconnect_count == 0:
                        greeting = render_template(first_message, build_call_context(conversation_id=call_id))
                        try:
                            await session.send_client_content(
                                turns=types.Content(role="user", parts=[types.Part(
                                    text=(
                                        "[system] The call just connected. Begin now by saying the "
                                        "following greeting verbatim, then stop and wait for the caller:\n"
                                        f"\"{greeting}\""
                                    )
                                )]),
                                turn_complete=True,
                            )
                        except Exception:
                            log.exception("Failed to send greeting")

                    async def frontend_to_gemini():
                        nonlocal client_closed
                        while True:
                            try:
                                msg = await websocket.receive()
                            except (WebSocketDisconnect, RuntimeError):
                                client_closed = True
                                return
                            raw_bytes = msg.get("bytes")
                            if raw_bytes:
                                try:
                                    await session.send_realtime_input(
                                        audio=types.Blob(
                                            data=bytes(raw_bytes),
                                            mime_type=f"audio/pcm;rate={INPUT_SAMPLE_RATE}",
                                        )
                                    )
                                except Exception:
                                    # Gemini side died; let gemini_to_frontend's
                                    # receive() raise the real error and trigger reconnect.
                                    return

                    async def gemini_to_frontend():
                        nonlocal_filler: dict = {"task": None}

                        async def stop_filler():
                            t = nonlocal_filler["task"]
                            if t is not None:
                                t.cancel()
                                try:
                                    await t
                                except asyncio.CancelledError:
                                    pass
                                nonlocal_filler["task"] = None

                        try:
                            while True:
                                user_chunks: list[str] = []
                                model_chunks: list[str] = []
                                sent_speaking = False
                                user_end_ts = None
                                first_audio_ts = None

                                async for response in session.receive():
                                    # Tool calls from Gemini
                                    tc = getattr(response, "tool_call", None)
                                    if tc and tc.function_calls:
                                        # Begin ambient filler so the user hears typing/clicks
                                        # during the otherwise-silent dispatch gap.
                                        if (
                                            (always_mixer.enabled or tool_mixer.enabled)
                                            and nonlocal_filler["task"] is None
                                        ):
                                            nonlocal_filler["task"] = asyncio.create_task(_ambient_filler())
                                        tool_responses = []
                                        for fc in tc.function_calls:
                                            args = dict(fc.args or {})
                                            tool_meta: dict = {}
                                            result = await _dispatch(
                                                tool_ids, fc.name, args,
                                                kb_collection_ids=kb_collection_ids,
                                                context=build_call_context(conversation_id=call_id),
                                                meta_out=tool_meta,
                                            )
                                            log.info("🔧 tool %s(%s) → %s", fc.name, args, result)
                                            # Surface the tool call in the live UI timeline and persist it.
                                            await _send(websocket, {
                                                "type": "tool",
                                                "name": fc.name,
                                                "args": args,
                                                "request": tool_meta or None,
                                                "status": (result or {}).get("status") if isinstance(result, dict) else None,
                                                "result": result,
                                            })
                                            await add_tool_event(call_id, fc.name, args, result, request=tool_meta or None)
                                            tool_responses.append(
                                                types.FunctionResponse(id=fc.id, name=fc.name, response=result)
                                            )
                                        await session.send_tool_response(function_responses=tool_responses)
                                        continue

                                    if response.data:
                                        # First real audio after a tool call: stop the filler
                                        # (and let the always-mixer continue seamlessly).
                                        await stop_filler()
                                        if first_audio_ts is None:
                                            first_audio_ts = time.monotonic()
                                            if user_end_ts is not None:
                                                latency_ms = (first_audio_ts - user_end_ts) * 1000
                                                log.info("⏱ user→first audio: %.0f ms", latency_ms)
                                                await _send(websocket, {"type": "metric", "latency_ms": round(latency_ms)})
                                        mixed = always_mixer.mix(response.data)
                                        try:
                                            await websocket.send_bytes(mixed)
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
                                                await add_transcript(call_id, "user", text)
                                                # Live sentiment cue (lexicon heuristic, no extra LLM call).
                                                s = score_text(text)
                                                await _send(websocket, {"type": "sentiment", **s})
                                        if model_chunks:
                                            text = "".join(model_chunks).strip()
                                            if text:
                                                await _send(websocket, {"type": "transcript", "role": "model", "text": text})
                                                await add_transcript(call_id, "model", text)
                                        await _send(websocket, {"type": "status", "state": "listening"})

                                await asyncio.sleep(0)
                        finally:
                            await stop_filler()

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
                    # Re-raise the first non-disconnect exception so the outer
                    # try/except can decide whether to reconnect or bail.
                    for task in done:
                        exc = task.exception()
                        if exc and not isinstance(exc, WebSocketDisconnect):
                            raise exc

                # Either side completed cleanly. If browser is still open,
                # treat it as an unexpected end and reconnect.
                if client_closed:
                    break

            except WebSocketDisconnect:
                client_closed = True
                break
            except Exception as exc:
                # Handle APIError 1006/1011, ConnectionClosedError, ConnectionResetError, etc.
                code = getattr(exc, "code", None)
                msg = str(exc)
                exc_type = type(exc).__name__
                if (
                    "APIError" in exc_type or
                    "ConnectionClosed" in exc_type or
                    isinstance(exc, (ConnectionResetError, BrokenPipeError)) or
                    (code in (1006, 1011)) or
                    "abnormal closure" in msg or
                    "1006" in msg or
                    "1011" in msg
                ):
                    reconnect_count += 1
                    log.debug("Gemini reset (%s: %s) — reconnecting (#%d)", exc_type, msg[:60], reconnect_count)
                    await asyncio.sleep(0.3)
                    continue
                raise

    except WebSocketDisconnect:
        log.info("Gemini WS: client disconnected")
    except Exception as exc:
        log.exception("Gemini WS error: %s", exc)
        await _send(websocket, {"type": "error", "message": str(exc)})
        await end_call(call_id, status="error", error_message=str(exc))
        return
    finally:
        await end_call(call_id, api_key=api_key)
