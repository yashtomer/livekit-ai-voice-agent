"""
ElevenLabs Conversational AI — WebSocket Bridge

Two endpoints:

  GET  /ivr/signed-url
    Returns a one-time signed WebSocket URL from ElevenLabs.
    Use this when the client can connect directly to ElevenLabs (browser / WebRTC).

  WebSocket  /ivr/ws
    Full server-side bridge: client connects here, server opens a WebSocket
    to ElevenLabs and relays all messages bidirectionally in real-time.
    Use this for telephony / server-controlled clients (Sarv IVR, SIP, etc.)
    that cannot connect directly to ElevenLabs.

ElevenLabs WebSocket API:
  https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket

Signed URL API:
  https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-signed-url

Client ↔ Bridge ↔ ElevenLabs message protocol (transparent pass-through):
  Client → Bridge → ElevenLabs:
    {"user_audio_chunk": "<base64>"}                         — user audio
    {"type": "pong", "event_id": <int>}                      — ping reply
    {"type": "conversation_initiation_client_data", ...}     — optional config

  ElevenLabs → Bridge → Client:
    {"type": "audio",   "audio_event": {"audio_base_64": "<base64>", "event_id": <int>}}
    {"type": "ping",    "ping_event":  {"event_id": <int>, "ping_ms": <int>}}
    {"type": "agent_response",   "agent_response_event":   {"agent_response": "<text>"}}
    {"type": "user_transcript",  "user_transcription_event": {"user_transcript": "<text>"}}
    {"type": "interruption",     "interruption_event":     {"event_id": <int>}}
    {"type": "conversation_initiation_metadata", "conversation_initiation_metadata_event": {...}}
    {"type": "error", ...}
"""

import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
import functools
import json
import logging
import os

import httpx
import numpy as np
import websockets
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

import models
from database import db as _db
from agent_tools import register_call_record

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ivr", tags=["ElevenLabs Voice Agent"])


async def _fetch_caller_context(caller_id: str) -> dict:
    """Pre-fetch lead record so the agent has caller context from the first message.

    Replaces the in-call `lookup_customer` tool — saves one round-trip and gives
    the agent caller identity before it speaks. Returns stringified values
    suitable for ElevenLabs dynamic variables. Never raises: on any error,
    returns safe defaults so a DB outage cannot block a call from starting.
    """
    defaults = {
        "caller_name":              "",
        "caller_email":             "",
        "is_returning_caller":      "false",
        "previous_classification":  "",
        "previous_enquiries_count": "0",
        "last_enquiry_summary":     "",
    }
    if not caller_id:
        return defaults
    try:
        lead = await _db[models.LEADS_COLLECTION].find_one({"phone": caller_id})
    except Exception as exc:
        logger.warning("[caller_context] lookup failed | phone=%s | err=%s", caller_id, exc)
        return defaults
    if not lead:
        return defaults

    prior = lead.get("previous_enquiries") or []
    # Take the most recent summary. Trim to keep the dynamic variable short
    # so it doesn't bloat the prompt or first turn.
    last_summary = prior[-1] if prior else ""
    if isinstance(last_summary, str) and len(last_summary) > 240:
        last_summary = last_summary[:240].rstrip() + "..."
    elif not isinstance(last_summary, str):
        last_summary = ""

    return {
        "caller_name":              lead.get("name") or "",
        "caller_email":             lead.get("email") or "",
        "is_returning_caller":      "true",
        "previous_classification":  lead.get("classification") or "",
        "previous_enquiries_count": str(len(prior)),
        "last_enquiry_summary":     last_summary,
    }


def _compose_first_message(caller_ctx: dict) -> str:
    """Pick a per-call first_message that names returning callers and
    acknowledges their prior search when one exists."""
    is_returning = caller_ctx.get("is_returning_caller") == "true"
    name = (caller_ctx.get("caller_name") or "").strip()
    has_prior = bool((caller_ctx.get("last_enquiry_summary") or "").strip())

    if is_returning and name and has_prior:
        # Returning caller with a known last requirement — invite continuation
        # without re-stating the summary (the agent has it in dynamic vars).
        return (
            f"{name} ji, namaskar! Mein Kanika hu, Rate-per-square-feet se. "
            "Wapas baat karke khushi hui. Wahi search continue karein jo pichli baar dekha tha, ya aaj kuch alag dhoondh rahe hain?"
        )
    if is_returning and name:
        return (
            f"{name} ji, namaskar! Mein Kanika hu, Rate-per-square-feet se. "
            "Bataiye, aaj main aapki kya help kar sakti hoon?"
        )
    return (
        "Namaskar, mein Kanika hu, Rate-per-square-feet se. "
        "Aap kis sheher mein property dhund rahe hain?"
    )

# Thread pool for CPU-bound audio transcoding.
# Allows both WebSocket directions to transcode in parallel without blocking
# the asyncio event loop (numpy releases the GIL for array operations).
_audio_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="audio")


# ---------------------------------------------------------------------------
# Audio transcoding — Tata sends G.711 μ-law 8kHz, ElevenLabs uses PCM 16kHz
#
# Codec:     numpy — correct G.711 integer algorithm
# Resampler: numpy linear interpolation / averaging decimation
#   • 6× faster than scipy.signal.resample_poly
#   • Sufficient quality for 8kHz telephone speech (300Hz–3.4kHz band)
#   • No scipy dependency
# ---------------------------------------------------------------------------

# G.711 μ-law constants (ITU-T G.711 / audioop-compatible)
_ULAW_BIAS    = 132        # additive bias applied before segment lookup
_ULAW_CLIP    = 32635      # max |sample| before bias (32635 + 132 = 32767)
_ULAW_EXP_LUT = np.array([0, 132, 396, 924, 1980, 4092, 8316, 16764], dtype=np.int32)


def _ulaw_decode(data: bytes) -> np.ndarray:
    """G.711 μ-law byte array → int16 PCM samples."""
    b    = (~np.frombuffer(data, dtype=np.uint8)).astype(np.int32) & 0xFF
    sign = b & 0x80
    exp  = (b >> 4) & 0x07
    mant = b & 0x0F
    sample = _ULAW_EXP_LUT[exp] + (mant << (exp + 3))
    return np.where(sign, -sample, sample).astype(np.int16)


def _ulaw_encode(samples: np.ndarray) -> bytes:
    """int16 PCM samples → G.711 μ-law byte array."""
    s     = np.clip(samples.astype(np.int32), -_ULAW_CLIP, _ULAW_CLIP)
    sign  = (s < 0).astype(np.int32) * 0x80
    abs_s = np.abs(s) + _ULAW_BIAS
    # Exponent: highest-set-bit position minus 7, clamped to [0, 7]
    # abs_s >= _ULAW_BIAS (132) so log2 is always valid
    exp  = np.clip(np.floor(np.log2(abs_s)).astype(np.int32) - 7, 0, 7)
    mant = (abs_s >> (exp + 3)) & 0x0F
    return ((~(sign | (exp << 4) | mant)) & 0xFF).astype(np.uint8).tobytes()


def ulaw8k_to_pcm16k(mulaw_b64: str) -> str:
    """Tata μ-law 8 kHz → ElevenLabs PCM 16 kHz (base64 int16-LE).

    2× linear interpolation: insert a midpoint between every pair of samples.
    Equivalent to a first-order FIR lowpass — sufficient for 8kHz telephone
    speech where the signal band is 300Hz–3.4kHz.
    """
    s = _ulaw_decode(base64.b64decode(mulaw_b64)).astype(np.int32)
    n = len(s)
    out = np.empty(n * 2, dtype=np.int32)
    out[0::2]  = s                          # original samples at even positions
    out[1:-1:2] = (s[:-1] + s[1:]) >> 1    # midpoints at odd positions
    out[-1]    = s[-1]                      # last odd position has no successor
    return base64.b64encode(
        np.clip(out, -32768, 32767).astype(np.int16).tobytes()
    ).decode()


def pcm16k_to_ulaw8k(pcm_b64: str) -> str:
    """ElevenLabs PCM 16 kHz → Tata μ-law 8 kHz (base64).

    2:1 averaging decimation: average each consecutive pair of 16kHz samples
    into one 8kHz sample.  The averaging acts as a simple anti-aliasing
    lowpass filter (−3dB at 4kHz) before the 2× decimation.
    """
    s = np.frombuffer(base64.b64decode(pcm_b64), dtype=np.int16).astype(np.int32)
    if len(s) % 2:
        s = s[:-1]                          # ensure even length
    samples_8k = ((s[0::2] + s[1::2]) >> 1).astype(np.int16)
    return base64.b64encode(_ulaw_encode(samples_8k)).decode()

def resample_pcm(samples: np.ndarray, in_rate: int, out_rate: int) -> np.ndarray:
    if in_rate == out_rate:
        return samples
    out_len = int(round(len(samples) * out_rate / in_rate))
    x_in  = np.arange(len(samples), dtype=np.float64)
    x_out = np.linspace(0, len(samples) - 1, out_len)
    return np.interp(x_out, x_in, samples.astype(np.float64)).astype(np.int16)


def exotel_to_pcm16k(b64: str, exotel_rate: int) -> str:
    samples = np.frombuffer(base64.b64decode(b64), dtype=np.int16)
    return base64.b64encode(resample_pcm(samples, exotel_rate, 16000).tobytes()).decode()


def pcm16k_to_exotel(b64: str, exotel_rate: int) -> str:
    samples = np.frombuffer(base64.b64decode(b64), dtype=np.int16)
    return base64.b64encode(resample_pcm(samples, 16000, exotel_rate).tobytes()).decode()


ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_AGENT_ID = os.getenv("ELEVENLABS_AGENT_ID", "")
IVR_PROVIDER = os.getenv("IVR_PROVIDER", "exotel").lower()  # "tata" or "exotel"

# DTMF gate — play a prompt and require the caller to press '1' before ElevenLabs opens.
# Set DTMF_GATE_AUDIO_PATH to a μ-law 8kHz WAV (or raw μ-law) file containing the
# gate prompt (e.g. "Press 1 to speak with a property advisor").
# The gate is skipped silently if the file path is unset or the file is missing.
DTMF_GATE_ENABLED      = os.getenv("DTMF_GATE_ENABLED", "true").lower() == "true"
DTMF_GATE_AUDIO_PATH   = os.getenv("DTMF_GATE_AUDIO_PATH", "")
DTMF_GATE_TIMEOUT_SECS = int(os.getenv("DTMF_GATE_TIMEOUT_SECS", "8"))

# Hard cap on conversation length and per-turn silence before ElevenLabs auto-ends.
ELEVENLABS_MAX_DURATION_SECS = int(os.getenv("ELEVENLABS_MAX_DURATION_SECS", "600"))  # 10 min default
ELEVENLABS_TURN_TIMEOUT_SECS = int(os.getenv("ELEVENLABS_TURN_TIMEOUT_SECS", "15"))  # 15 s silence cap

# Timezone for {{system__time}} / {{system__timezone}} dynamic variables injected into the agent.
# Default: Asia/Kolkata (IST) — the primary operating timezone for Rate per Square Feet.
AGENT_TIMEZONE = os.getenv("AGENT_TIMEZONE", "Asia/Kolkata")


def _load_gate_audio_ulaw() -> bytes:
    """Load raw μ-law 8 kHz gate audio from file.

    generate_gate_audio.py produces this file using the ElevenLabs TTS API with
    output_format=ulaw_8000, which returns raw μ-law bytes (no WAV container).
    """
    if not DTMF_GATE_AUDIO_PATH or not os.path.exists(DTMF_GATE_AUDIO_PATH):
        return b""
    with open(DTMF_GATE_AUDIO_PATH, "rb") as f:
        return f.read()


async def _run_dtmf_gate(client_ws: WebSocket, gate_audio: bytes) -> dict | None:
    """
    Spam/bot filter: play a prompt over the Tata WebSocket and require the caller
    to press DTMF digit '1' within DTMF_GATE_TIMEOUT_SECS seconds.

    Consumes Tata 'connected', 'start', audio, and DTMF events.

    Returns {'stream_sid': ..., 'call_sid': ..., 'caller_id': ...} on success (digit '1'
    received), or None if the caller did not respond (bot / dead air / wrong number).
    ElevenLabs is NOT opened when None is returned.
    """
    TATA_CHUNK    = 160
    ULAW_SILENCE  = 0x7F   # μ-law encoding of zero-amplitude silence
    MAX_ATTEMPTS  = 2       # replay prompt once on wrong digit before giving up
    # μ-law 8kHz = 8000 bytes/second — calculate playback duration from file size
    AUDIO_PLAY_SECS = len(gate_audio) / 8000.0

    async def _play_audio(sid: str) -> None:
        """Stream gate audio chunks to the caller."""
        remainder = len(gate_audio) % TATA_CHUNK
        padded    = gate_audio + bytes([ULAW_SILENCE] * (TATA_CHUNK - remainder)) if remainder else gate_audio
        for i in range(0, len(padded), TATA_CHUNK):
            await client_ws.send_text(json.dumps({
                "event":     "media",
                "streamSid": sid,
                "media":     {"payload": base64.b64encode(padded[i:i + TATA_CHUNK]).decode()},
            }))

    try:
        # ── Step 1: wait for the Tata 'start' event ──────────────────────────
        stream_sid = call_sid = caller_id = None
        while stream_sid is None:
            try:
                msg = await asyncio.wait_for(client_ws.receive(), timeout=30.0)
            except asyncio.TimeoutError:
                logger.warning("[DTMF Gate] Timed out waiting for start event")
                return None

            if msg.get("type") == "websocket.disconnect":
                return None
            if not msg.get("text"):
                continue
            try:
                parsed = json.loads(msg["text"])
            except json.JSONDecodeError:
                continue

            evt = parsed.get("event")
            if evt == "start":
                stream_sid = parsed.get("streamSid")
                start      = parsed.get("start", {})
                call_sid   = start.get("callSid", "")
                caller_id  = start.get("from", "")
                logger.info("[DTMF Gate] start | streamSid=%s | from=%s", stream_sid, caller_id)
            elif evt == "stop":
                return None

        # ── Steps 2+3: play prompt then wait for DTMF '1' (up to MAX_ATTEMPTS) ──
        for attempt in range(1, MAX_ATTEMPTS + 1):
            await _play_audio(stream_sid)

            # Wait for audio to finish playing on the caller's handset before
            # starting the response countdown. Without this, the caller only has
            # (DTMF_GATE_TIMEOUT_SECS - AUDIO_PLAY_SECS) to react.
            await asyncio.sleep(AUDIO_PLAY_SECS)

            deadline = asyncio.get_running_loop().time() + DTMF_GATE_TIMEOUT_SECS
            logger.info("[DTMF Gate] attempt %d/%d — waiting %ds for digit | from=%s",
                        attempt, MAX_ATTEMPTS, DTMF_GATE_TIMEOUT_SECS, caller_id)

            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    if attempt < MAX_ATTEMPTS:
                        logger.info("[DTMF Gate] No digit on attempt %d — replaying prompt for %s",
                                    attempt, caller_id)
                    else:
                        logger.info("[DTMF Gate] No digit after %d attempts — blocking %s",
                                    MAX_ATTEMPTS, caller_id)
                    break  # move to next attempt or exit loop

                try:
                    msg = await asyncio.wait_for(client_ws.receive(), timeout=remaining)
                except asyncio.TimeoutError:
                    break

                if msg.get("type") == "websocket.disconnect":
                    return None
                if not msg.get("text"):
                    continue
                try:
                    parsed = json.loads(msg["text"])
                except json.JSONDecodeError:
                    continue

                evt = parsed.get("event")
                if evt == "dtmf":
                    digit = parsed.get("dtmf", {}).get("digit", "")
                    logger.info("[DTMF Gate] digit=%s | attempt=%d | from=%s", digit, attempt, caller_id)
                    if digit == "1":
                        logger.info("[DTMF Gate] Passed — opening ElevenLabs for %s", caller_id)
                        return {"stream_sid": stream_sid, "call_sid": call_sid, "caller_id": caller_id}
                    # Wrong digit — replay the prompt immediately (break inner loop)
                    logger.info("[DTMF Gate] Wrong digit '%s' — replaying prompt for %s", digit, caller_id)
                    break
                elif evt == "stop":
                    logger.info("[DTMF Gate] Call stopped during gate — %s", caller_id)
                    return None

        return None  # exhausted all attempts

    except WebSocketDisconnect:
        return None
    except Exception as exc:
        logger.error("[DTMF Gate] Unexpected error: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Helper — fetch signed URL from ElevenLabs
# ---------------------------------------------------------------------------

async def _get_signed_url() -> str:
    """
    GET /v1/convai/conversation/get-signed-url?agent_id=<id>
    Returns a one-time signed WebSocket URL valid for a single conversation.
    Ref: https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-signed-url
    """
    url = (
        "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url"
        f"?agent_id={ELEVENLABS_AGENT_ID}"
    )
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url, headers={"xi-api-key": ELEVENLABS_API_KEY})
        resp.raise_for_status()
        return resp.json()["signed_url"]


# ---------------------------------------------------------------------------
# Endpoint 1 — return signed URL for direct client connection
# ---------------------------------------------------------------------------

@router.get("/signed-url")
async def get_signed_url():
    """
    Returns a one-time ElevenLabs signed WebSocket URL.

    The client uses this URL to open a WebSocket directly to ElevenLabs —
    no server bridge needed. Suitable for browsers and WebRTC clients.

    Usage:
      1. GET /ivr/signed-url  → {"signed_url": "wss://api.elevenlabs.io/...?token=..."}
      2. Client opens WebSocket to that URL.
      3. Client sends/receives ElevenLabs protocol messages directly.
    """
    if not ELEVENLABS_API_KEY or not ELEVENLABS_AGENT_ID:
        raise HTTPException(status_code=400, detail="ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID not configured")
    try:
        signed_url = await _get_signed_url()
        return {"signed_url": signed_url}
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=exc.response.text)
    except Exception as exc:
        logger.error("Failed to get ElevenLabs signed URL: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to fetch signed URL from ElevenLabs")


# ---------------------------------------------------------------------------
# Endpoint 2 — server-side WebSocket bridge to ElevenLabs
# ---------------------------------------------------------------------------

async def _tata_bridge(client_ws: WebSocket):
    await client_ws.accept()
    logger.info("[Tata] Client connected")

    if not ELEVENLABS_API_KEY or not ELEVENLABS_AGENT_ID:
        await client_ws.close(code=1008, reason="ElevenLabs credentials not configured")
        return

    # ── DTMF gate ────────────────────────────────────────────────────────────
    # Run BEFORE fetching a signed URL so spam calls never touch ElevenLabs.
    gate_metadata: dict | None = None   # {stream_sid, call_sid, caller_id}
    if DTMF_GATE_ENABLED:
        gate_audio = _load_gate_audio_ulaw()
        if gate_audio:
            gate_metadata = await _run_dtmf_gate(client_ws, gate_audio)
            if gate_metadata is None:
                logger.info("[Tata] DTMF gate rejected — ElevenLabs not opened")
                try:
                    await client_ws.close()
                except Exception:
                    pass
                return
        else:
            logger.warning("[Tata] DTMF_GATE_ENABLED but DTMF_GATE_AUDIO_PATH not set or file missing — gate skipped")

    try:
        signed_url = await _get_signed_url()
    except Exception as exc:
        logger.error("[Tata] Could not get ElevenLabs signed URL: %s", exc)
        await client_ws.close(code=1011, reason="Failed to reach ElevenLabs")
        return

    transfer_initiated: list[bool] = [False]
    call_disconnected: list[bool] = [False]
    # Shared holders so elevenlabs_to_client() can bind conversation_id back to
    # the call_sid registered by client_to_elevenlabs().
    call_sid_holder: list[str | None] = [None]
    phone_holder:    list[str | None] = [None]

    try:
        async with websockets.connect(signed_url, ping_interval=None) as el_ws:
            logger.info("[Tata] Connected to ElevenLabs WebSocket")

            # Pre-populate stream_sid if the DTMF gate already captured the start event
            stream_sid: list[str] = [gate_metadata["stream_sid"] if gate_metadata else None]
            TATA_CHUNK = 160
            mulaw_buf  = bytearray()

            async def flush_mulaw_buf():
                while len(mulaw_buf) >= TATA_CHUNK:
                    chunk = bytes(mulaw_buf[:TATA_CHUNK])
                    del mulaw_buf[:TATA_CHUNK]
                    await client_ws.send_text(json.dumps({
                        "event": "media",
                        "streamSid": stream_sid[0],
                        "media": {"payload": base64.b64encode(chunk).decode()},
                    }))

            async def client_to_elevenlabs():
                frame_count = 0
                initiation_sent = False
                audio_queue: list[str] = []

                # Gate already consumed the 'start' event — send initiation immediately
                if gate_metadata:
                    caller_ctx = await _fetch_caller_context(gate_metadata["caller_id"])
                    logger.info("[Tata] caller_context | phone=%s | %s", gate_metadata["caller_id"], caller_ctx)
                    phone_holder[0]    = gate_metadata["caller_id"]
                    call_sid_holder[0] = gate_metadata["call_sid"]
                    try:
                        reg = await register_call_record(
                            _db, gate_metadata["caller_id"], gate_metadata["call_sid"]
                        )
                        logger.info("[Tata] register_call_record (bridge) | %s", reg)
                    except Exception as exc:
                        logger.error("[Tata] register_call_record failed | err=%s", exc)
                    first_message = _compose_first_message(caller_ctx)
                    await el_ws.send(json.dumps({
                        "type": "conversation_initiation_client_data",
                        "conversation_config_override": {
                            "conversation": {
                                "max_duration_secs": ELEVENLABS_MAX_DURATION_SECS,
                                "turn_timeout":      ELEVENLABS_TURN_TIMEOUT_SECS,
                            },
                            "agent": {
                                "first_message": first_message,
                            },
                        },
                        "dynamic_variables": {
                            "caller_id": gate_metadata["caller_id"],
                            "call_sid":  gate_metadata["call_sid"],
                            **caller_ctx,
                        },
                    }))
                    initiation_sent = True

                try:
                    while True:
                        msg = await client_ws.receive()
                        if msg.get("type") == "websocket.disconnect":
                            call_disconnected[0] = True
                            break
                        if msg.get("bytes"):
                            data = msg["bytes"]
                            frame_count += 1
                            if frame_count == 1 or frame_count % 50 == 0:
                                header_hex = data[:8].hex() if len(data) >= 8 else data.hex()
                                logger.info(
                                    "[Tata→EL] frame #%d | type=BINARY | size=%d bytes | first_bytes=%s",
                                    frame_count, len(data), header_hex,
                                )
                            await el_ws.send(data)
                        elif msg.get("text"):
                            text = msg["text"]
                            try:
                                parsed = json.loads(text)
                            except json.JSONDecodeError:
                                frame_count += 1
                                logger.info("[Tata→EL] frame #%d | non-JSON | preview=%r", frame_count, text[:80])
                                await el_ws.send(text)
                                continue

                            event = parsed.get("event")

                            if event == "connected":
                                logger.info("[Tata→EL] connected | protocol=%s", parsed.get("protocol"))
                                continue

                            elif event == "start":
                                if gate_metadata:
                                    # Already handled by DTMF gate — skip
                                    continue
                                start = parsed.get("start", {})
                                stream_sid[0] = parsed.get("streamSid")
                                call_sid  = start.get("callSid", "")
                                caller_id = start.get("from", "")
                                logger.info(
                                    "[Tata] call started | streamSid=%s | callSid=%s | from=%s",
                                    stream_sid[0], call_sid, caller_id,
                                )
                                caller_ctx = await _fetch_caller_context(caller_id)
                                logger.info("[Tata] caller_context | phone=%s | %s", caller_id, caller_ctx)
                                phone_holder[0]    = caller_id
                                call_sid_holder[0] = call_sid
                                try:
                                    reg = await register_call_record(_db, caller_id, call_sid)
                                    logger.info("[Tata] register_call_record (bridge) | %s", reg)
                                except Exception as exc:
                                    logger.error("[Tata] register_call_record failed | err=%s", exc)
                                first_message = _compose_first_message(caller_ctx)
                                await el_ws.send(json.dumps({
                                    "type": "conversation_initiation_client_data",
                                    "conversation_config_override": {
                                        "conversation": {
                                            "max_duration_secs": ELEVENLABS_MAX_DURATION_SECS,
                                            "turn_timeout":      ELEVENLABS_TURN_TIMEOUT_SECS,
                                        },
                                        "agent": {
                                            "first_message": first_message,
                                        },
                                    },
                                    "dynamic_variables": {
                                        "caller_id": caller_id,
                                        "call_sid":  call_sid,
                                        **caller_ctx,
                                    },
                                }))
                                initiation_sent = True
                                for queued in audio_queue:
                                    await el_ws.send(queued)
                                audio_queue.clear()
                                continue

                            elif event == "media":
                                payload = parsed.get("media", {}).get("payload", "")
                                frame_count += 1
                                if payload:
                                    loop = asyncio.get_running_loop()
                                    pcm_b64 = await loop.run_in_executor(
                                        _audio_pool, ulaw8k_to_pcm16k, payload
                                    )
                                    audio_msg = json.dumps({"user_audio_chunk": pcm_b64})
                                    if initiation_sent:
                                        await el_ws.send(audio_msg)
                                    else:
                                        audio_queue.append(audio_msg)
                                continue

                            elif event == "dtmf":
                                digit = parsed.get("dtmf", {}).get("digit", "?")
                                logger.info("[Tata→EL] DTMF digit=%s | streamSid=%s", digit, parsed.get("streamSid"))
                                continue

                            elif event == "mark":
                                name = parsed.get("mark", {}).get("name", "?")
                                logger.info("[Tata→EL] mark acknowledged | name=%s", name)
                                continue

                            elif event == "stop":
                                reason = parsed.get("stop", {}).get("reason", "unknown")
                                logger.info(
                                    "[Tata→EL] stop | streamSid=%s | reason=%s",
                                    parsed.get("streamSid"),
                                    reason,
                                )
                                if reason == "call_disconnected":
                                    call_disconnected[0] = True
                                break

                            else:
                                logger.info("[Tata→EL] unknown event=%s | keys=%s", event, list(parsed.keys()))

                except WebSocketDisconnect:
                    logger.info("[Tata→EL] Client disconnected after %d frames", frame_count)
                    call_disconnected[0] = True
                except websockets.exceptions.ConnectionClosedOK as exc:
                    logger.info("[Tata→EL] ElevenLabs closed connection normally after %d frames: %s", frame_count, exc)
                except Exception as exc:
                    logger.error("[Tata→EL] error after %d frames: %s", frame_count, exc)

                # Transfer path: short flush window so the in-flight initiate_transfer
                # response settles before we close EL.
                if transfer_initiated[0]:
                    logger.info("[Tata→EL] Transfer complete — closing ElevenLabs WS in 2s")
                    await asyncio.sleep(2)
                    try:
                        await el_ws.close()
                    except Exception:
                        pass
                elif call_disconnected[0]:
                    # Caller hung up — close EL immediately. mark_call_outcome and
                    # classify_caller are unbound; outcome + classification are
                    # derived server-side by post_call_webhook. Any delay here
                    # just lets EL generate phantom "Hello?" turns that bill us
                    # and never reach the caller (audio is dropped above).
                    logger.info("[Tata→EL] Caller disconnected — closing ElevenLabs connection")
                    try:
                        await el_ws.close()
                    except Exception:
                        pass

            async def elevenlabs_to_client():
                try:
                    async for raw in el_ws:
                        try:
                            msg = json.loads(raw)
                            msg_type = msg.get("type", "unknown")

                            if msg_type == "ping":
                                event_id = msg.get("ping_event", {}).get("event_id")
                                if event_id is not None:
                                    await el_ws.send(json.dumps({"type": "pong", "event_id": event_id}))

                            elif msg_type == "conversation_initiation_metadata":
                                meta = msg.get("conversation_initiation_metadata_event", {})
                                conv_id = meta.get("conversation_id")
                                logger.info(
                                    "[EL→Tata] conversation started | conversation_id=%s | agent_output_audio_format=%s",
                                    conv_id, meta.get("agent_output_audio_format"),
                                )
                                # Patch the calls row with conversation_id once it's known.
                                if conv_id and call_sid_holder[0] and phone_holder[0]:
                                    try:
                                        reg = await register_call_record(
                                            _db, phone_holder[0], call_sid_holder[0], conv_id,
                                        )
                                        logger.info(
                                            "[Tata] bind conversation_id | call_sid=%s | conversation_id=%s | %s",
                                            call_sid_holder[0], conv_id, reg,
                                        )
                                    except Exception as exc:
                                        logger.error(
                                            "[Tata] bind conversation_id failed | call_sid=%s | err=%s",
                                            call_sid_holder[0], exc,
                                        )
                                elif conv_id:
                                    # Pre-init race: EL emits conversation_initiation_metadata
                                    # before our gate handler populates phone/call_sid.
                                    # post_call_webhook recovers via call_sid fallback.
                                    logger.debug(
                                        "[Tata] deferring conversation_id bind=%s — call_sid=%s phone=%s not yet set",
                                        conv_id, call_sid_holder[0], phone_holder[0],
                                    )

                            elif msg_type == "audio":
                                if transfer_initiated[0] or call_disconnected[0]:
                                    continue
                                audio_b64 = msg.get("audio_event", {}).get("audio_base_64", "")
                                event_id  = msg.get("audio_event", {}).get("event_id")
                                if audio_b64:
                                    loop = asyncio.get_running_loop()
                                    mulaw_bytes = base64.b64decode(
                                        await loop.run_in_executor(
                                            _audio_pool, pcm16k_to_ulaw8k, audio_b64
                                        )
                                    )
                                    mulaw_buf.extend(mulaw_bytes)
                                    await flush_mulaw_buf()
                                    logger.debug(
                                        "[EL→Tata] audio | event_id=%s | pcm_b64_len=%d → mulaw=%d bytes (buf=%d remaining)",
                                        event_id, len(audio_b64), len(mulaw_bytes), len(mulaw_buf),
                                    )

                            elif msg_type == "interruption":
                                if transfer_initiated[0] or call_disconnected[0]:
                                    continue
                                event_id = msg.get("interruption_event", {}).get("event_id")
                                logger.info("[EL→Tata] interruption | event_id=%s | discarding %d buffered mulaw bytes", event_id, len(mulaw_buf))
                                mulaw_buf.clear()
                                await client_ws.send_text(json.dumps({
                                    "event": "clear",
                                    "streamSid": stream_sid[0],
                                }))

                            elif msg_type == "agent_response":
                                text = msg.get("agent_response_event", {}).get("agent_response", "")
                                logger.info("[EL→Tata] agent_response | text=%r", text)

                            elif msg_type == "agent_response_correction":
                                evt = msg.get("agent_response_correction_event", {})
                                logger.info(
                                    "[EL→Tata] agent_response_correction | original=%r | corrected=%r",
                                    evt.get("original_agent_response", "")[:80],
                                    evt.get("corrected_agent_response", "")[:80],
                                )

                            elif msg_type == "user_transcript":
                                text = msg.get("user_transcription_event", {}).get("user_transcript", "")
                                logger.info("[EL→Tata] user_transcript | text=%r", text)

                            elif msg_type == "agent_tool_request":
                                event = msg.get("agent_tool_request", {})
                                tool_name = event.get("tool_name")
                                tool_type = event.get("tool_type")
                                call_id   = event.get("tool_call_id")
                                params    = event.get("parameters")
                                logger.info(
                                    "[EL→Tata] tool_request | tool=%s | type=%s | call_id=%s | params=%s",
                                    tool_name, tool_type, call_id, params,
                                )
                                if tool_name == "initiate_transfer":
                                    transfer_initiated[0] = True
                                    logger.info("[EL→Tata] transfer detected — bridge will not close Tata WebSocket after EL disconnects")

                            elif msg_type == "agent_tool_response":
                                event = msg.get("agent_tool_response", {})
                                logger.info(
                                    "[EL→Tata] tool_response | tool=%s | type=%s | call_id=%s | is_error=%s | is_called=%s",
                                    event.get("tool_name"), event.get("tool_type"),
                                    event.get("tool_call_id"), event.get("is_error"), event.get("is_called"),
                                )

                            elif msg_type == "error":
                                logger.error("[EL→Tata] error from ElevenLabs | %s", msg)

                            elif msg_type in ("vad_score", "internal_tentative_agent_response"):
                                pass  # high-frequency internal events — not actionable in a telephony bridge

                            else:
                                logger.info("[EL→Tata] unhandled msg_type=%s", msg_type)

                        except (json.JSONDecodeError, KeyError):
                            if isinstance(raw, bytes):
                                logger.info("[EL→Tata] binary frame | size=%d bytes", len(raw))

                except websockets.exceptions.ConnectionClosedOK:
                    logger.info("[EL→Tata] ElevenLabs closed connection normally (post-transfer)")
                except websockets.exceptions.ConnectionClosedError as exc:
                    logger.info("[EL→Tata] ElevenLabs connection closed: %s", exc)
                except Exception as exc:
                    logger.error("[EL→Tata] elevenlabs_to_client error: %s", exc)

            await asyncio.gather(
                client_to_elevenlabs(),
                elevenlabs_to_client(),
                return_exceptions=True,
            )

    except Exception as exc:
        logger.error("[Tata] Bridge error: %s", exc)
    finally:
        logger.info("[Tata] Bridge closed")
        if transfer_initiated[0]:
            logger.info("[Tata] Transfer was initiated — leaving Tata WebSocket open for Tata to complete bridging")
        else:
            try:
                await client_ws.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Exotel bridge — PCM linear16 at configurable sample rate
# ---------------------------------------------------------------------------

async def _exotel_bridge(client_ws: WebSocket, sample_rate: int):
    await client_ws.accept()
    logger.info("[Exotel] Client connected | sample_rate=%d", sample_rate)

    if not ELEVENLABS_API_KEY or not ELEVENLABS_AGENT_ID:
        await client_ws.close(code=1008, reason="ElevenLabs credentials not configured")
        return

    try:
        signed_url = await _get_signed_url()
    except Exception as exc:
        logger.error("[Exotel] Could not get ElevenLabs signed URL: %s", exc)
        await client_ws.close(code=1011, reason="Failed to reach ElevenLabs")
        return

    transfer_initiated: list[bool] = [False]
    call_disconnected: list[bool] = [False]

    # 100ms PCM frames — Exotel minimum chunk is 3200 bytes (100ms @ 16kHz),
    # must be multiples of 320 bytes.
    EXOTEL_CHUNK = (sample_rate // 10) * 2

    try:
        async with websockets.connect(signed_url, ping_interval=None) as el_ws:
            logger.info("[Exotel] Connected to ElevenLabs WebSocket")

            stream_sid: list[str] = [None]
            pcm_buf = bytearray()

            async def flush_pcm_buf():
                while len(pcm_buf) >= EXOTEL_CHUNK:
                    chunk = bytes(pcm_buf[:EXOTEL_CHUNK])
                    del pcm_buf[:EXOTEL_CHUNK]
                    await client_ws.send_text(json.dumps({
                        "event": "media",
                        "stream_sid": stream_sid[0],
                        "media": {"payload": base64.b64encode(chunk).decode()},
                    }))

            async def client_to_elevenlabs():
                frame_count = 0
                initiation_sent = False
                audio_queue: list[str] = []
                try:
                    while True:
                        msg = await client_ws.receive()
                        if msg.get("type") == "websocket.disconnect":
                            call_disconnected[0] = True
                            break
                        if msg.get("bytes"):
                            data = msg["bytes"]
                            frame_count += 1
                            if frame_count == 1 or frame_count % 50 == 0:
                                logger.info(
                                    "[Exotel→EL] frame #%d | type=BINARY | size=%d bytes",
                                    frame_count, len(data),
                                )
                            await el_ws.send(data)
                        elif msg.get("text"):
                            text = msg["text"]
                            try:
                                parsed = json.loads(text)
                            except json.JSONDecodeError:
                                frame_count += 1
                                logger.info("[Exotel→EL] frame #%d | non-JSON | preview=%r", frame_count, text[:80])
                                await el_ws.send(text)
                                continue

                            event = parsed.get("event")

                            if event == "connected":
                                logger.info("[Exotel→EL] connected | protocol=%s", parsed.get("protocol"))
                                continue

                            elif event == "start":
                                start = parsed.get("start", {})
                                stream_sid[0] = parsed.get("stream_sid")
                                call_sid  = start.get("call_sid", "")
                                caller_id = start.get("from", "")
                                logger.info(
                                    "[Exotel] call started | stream_sid=%s | call_sid=%s | from=%s",
                                    stream_sid[0], call_sid, caller_id,
                                )
                                caller_ctx = await _fetch_caller_context(caller_id)
                                logger.info("[Exotel] caller_context | phone=%s | %s", caller_id, caller_ctx)
                                await el_ws.send(json.dumps({
                                    "type": "conversation_initiation_client_data",
                                    "conversation_config_override": {
                                        "conversation": {
                                            "max_duration_secs": ELEVENLABS_MAX_DURATION_SECS,
                                            "turn_timeout":      ELEVENLABS_TURN_TIMEOUT_SECS,
                                        },
                                    },
                                    "dynamic_variables": {
                                        "caller_id": caller_id,
                                        "call_sid":  call_sid,
                                        **caller_ctx,
                                    },
                                }))
                                initiation_sent = True
                                for queued in audio_queue:
                                    await el_ws.send(queued)
                                audio_queue.clear()
                                continue

                            elif event == "media":
                                payload = parsed.get("media", {}).get("payload", "")
                                frame_count += 1
                                if payload:
                                    loop = asyncio.get_running_loop()
                                    pcm_b64 = await loop.run_in_executor(
                                        _audio_pool,
                                        functools.partial(exotel_to_pcm16k, payload, sample_rate),
                                    )
                                    audio_msg = json.dumps({"user_audio_chunk": pcm_b64})
                                    if initiation_sent:
                                        await el_ws.send(audio_msg)
                                    else:
                                        audio_queue.append(audio_msg)
                                continue

                            elif event == "dtmf":
                                digit = parsed.get("dtmf", {}).get("digit", "?")
                                logger.info("[Exotel→EL] DTMF digit=%s | stream_sid=%s", digit, parsed.get("stream_sid"))
                                continue

                            elif event == "mark":
                                name = parsed.get("mark", {}).get("name", "?")
                                logger.info("[Exotel→EL] mark acknowledged | name=%s", name)
                                continue

                            elif event == "stop":
                                reason = parsed.get("stop", {}).get("reason", "unknown")
                                logger.info(
                                    "[Exotel→EL] stop | stream_sid=%s | reason=%s",
                                    parsed.get("stream_sid"),
                                    reason,
                                )
                                if reason == "call_disconnected":
                                    call_disconnected[0] = True
                                break

                            else:
                                logger.info("[Exotel→EL] unknown event=%s | keys=%s", event, list(parsed.keys()))

                except WebSocketDisconnect:
                    logger.info("[Exotel→EL] Client disconnected after %d frames", frame_count)
                    call_disconnected[0] = True
                except Exception as exc:
                    logger.error("[Exotel→EL] error after %d frames: %s", frame_count, exc)

                if transfer_initiated[0]:
                    logger.info("[Exotel→EL] Transfer complete — closing ElevenLabs WS in 2s")
                    await asyncio.sleep(2)
                    try:
                        await el_ws.close()
                    except Exception:
                        pass
                elif call_disconnected[0]:
                    # Caller hung up — close EL immediately. See Tata bridge note
                    # above; cleanup tools are server-managed, no grace needed.
                    logger.info("[Exotel→EL] Caller disconnected — closing ElevenLabs connection")
                    try:
                        await el_ws.close()
                    except Exception:
                        pass

            async def elevenlabs_to_client():
                try:
                    async for raw in el_ws:
                        try:
                            msg = json.loads(raw)
                            msg_type = msg.get("type", "unknown")

                            if msg_type == "ping":
                                event_id = msg.get("ping_event", {}).get("event_id")
                                if event_id is not None:
                                    await el_ws.send(json.dumps({"type": "pong", "event_id": event_id}))

                            elif msg_type == "conversation_initiation_metadata":
                                meta = msg.get("conversation_initiation_metadata_event", {})
                                logger.info(
                                    "[EL→Exotel] conversation started | conversation_id=%s | agent_output_audio_format=%s",
                                    meta.get("conversation_id"), meta.get("agent_output_audio_format"),
                                )

                            elif msg_type == "audio":
                                if transfer_initiated[0] or call_disconnected[0]:
                                    continue
                                audio_b64 = msg.get("audio_event", {}).get("audio_base_64", "")
                                event_id  = msg.get("audio_event", {}).get("event_id")
                                if audio_b64:
                                    loop = asyncio.get_running_loop()
                                    exotel_bytes = base64.b64decode(
                                        await loop.run_in_executor(
                                            _audio_pool,
                                            functools.partial(pcm16k_to_exotel, audio_b64, sample_rate),
                                        )
                                    )
                                    pcm_buf.extend(exotel_bytes)
                                    await flush_pcm_buf()
                                    logger.debug(
                                        "[EL→Exotel] audio | event_id=%s | pcm_b64_len=%d → exotel=%d bytes (buf=%d remaining)",
                                        event_id, len(audio_b64), len(exotel_bytes), len(pcm_buf),
                                    )

                            elif msg_type == "interruption":
                                if transfer_initiated[0] or call_disconnected[0]:
                                    continue
                                event_id = msg.get("interruption_event", {}).get("event_id")
                                logger.info("[EL→Exotel] interruption | event_id=%s | discarding %d buffered bytes", event_id, len(pcm_buf))
                                pcm_buf.clear()
                                await client_ws.send_text(json.dumps({
                                    "event": "clear",
                                    "stream_sid": stream_sid[0],
                                }))

                            elif msg_type == "agent_response":
                                text = msg.get("agent_response_event", {}).get("agent_response", "")
                                logger.info("[EL→Exotel] agent_response | text=%r", text)

                            elif msg_type == "agent_response_correction":
                                evt = msg.get("agent_response_correction_event", {})
                                logger.info(
                                    "[EL→Exotel] agent_response_correction | original=%r | corrected=%r",
                                    evt.get("original_agent_response", "")[:80],
                                    evt.get("corrected_agent_response", "")[:80],
                                )

                            elif msg_type == "user_transcript":
                                text = msg.get("user_transcription_event", {}).get("user_transcript", "")
                                logger.info("[EL→Exotel] user_transcript | text=%r", text)

                            elif msg_type == "agent_tool_request":
                                event = msg.get("agent_tool_request", {})
                                tool_name = event.get("tool_name")
                                logger.info(
                                    "[EL→Exotel] tool_request | tool=%s | type=%s | call_id=%s | params=%s",
                                    tool_name, event.get("tool_type"), event.get("tool_call_id"), event.get("parameters"),
                                )
                                if tool_name == "initiate_transfer":
                                    transfer_initiated[0] = True
                                    logger.info("[EL→Exotel] transfer detected — audio forwarding stopped")

                            elif msg_type == "agent_tool_response":
                                event = msg.get("agent_tool_response", {})
                                logger.info(
                                    "[EL→Exotel] tool_response | tool=%s | type=%s | call_id=%s | is_error=%s | is_called=%s",
                                    event.get("tool_name"), event.get("tool_type"),
                                    event.get("tool_call_id"), event.get("is_error"), event.get("is_called"),
                                )

                            elif msg_type == "error":
                                logger.error("[EL→Exotel] error from ElevenLabs | %s", msg)

                            elif msg_type in ("vad_score", "internal_tentative_agent_response"):
                                pass  # high-frequency internal events — not actionable in a telephony bridge

                            else:
                                logger.info("[EL→Exotel] unhandled msg_type=%s", msg_type)

                        except (json.JSONDecodeError, KeyError):
                            if isinstance(raw, bytes):
                                logger.info("[EL→Exotel] binary frame | size=%d bytes", len(raw))

                except Exception as exc:
                    logger.error("[EL→Exotel] elevenlabs_to_client error: %s", exc)

            await asyncio.gather(
                client_to_elevenlabs(),
                elevenlabs_to_client(),
                return_exceptions=True,
            )

    except Exception as exc:
        logger.error("[Exotel] Bridge error: %s", exc)
    finally:
        logger.info("[Exotel] Bridge closed")
        try:
            await client_ws.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Endpoint 2 — dispatcher: routes /ws to Tata or Exotel bridge
# ---------------------------------------------------------------------------

@router.websocket("/ws")
async def elevenlabs_ws_bridge(
    client_ws: WebSocket,
    sample_rate: int = Query(default=8000, alias="sample-rate"),
):
    if IVR_PROVIDER == "tata":
        await _tata_bridge(client_ws)
    else:
        if sample_rate not in (8000, 16000, 24000):
            await client_ws.accept()
            await client_ws.close(code=1008, reason="sample-rate must be 8000, 16000 or 24000")
            return
        await _exotel_bridge(client_ws, sample_rate)


# ---------------------------------------------------------------------------
# Endpoint 3 — browser bridge (no transcoding, PCM 16kHz passthrough)
# ---------------------------------------------------------------------------

@router.websocket("/ws/browser")
async def _browser_bridge(client_ws: WebSocket):
    await client_ws.accept()
    try:
        signed_url = await _get_signed_url()
    except Exception as exc:
        logger.error("[Browser] Could not get ElevenLabs signed URL: %s", exc)
        await client_ws.close(code=1011, reason="Failed to reach ElevenLabs")
        return

    browser_disconnected: list[bool] = [False]

    try:
        async with websockets.connect(signed_url, ping_interval=None) as el_ws:
            logger.info("[Browser] Client connected")

            async def browser_to_el():
                try:
                    while True:
                        msg = await client_ws.receive()
                        if msg.get("type") == "websocket.disconnect":
                            browser_disconnected[0] = True
                            break
                        if msg.get("text"):
                            await el_ws.send(msg["text"])
                        elif msg.get("bytes"):
                            await el_ws.send(msg["bytes"])
                except WebSocketDisconnect:
                    browser_disconnected[0] = True
                    logger.info("[Browser] Client disconnected")
                except Exception as exc:
                    logger.error("[Browser] browser_to_el error: %s", exc)
                # Close EL promptly so it stops billing
                try:
                    await el_ws.close()
                except Exception:
                    pass

            async def el_to_browser():
                try:
                    async for raw in el_ws:
                        if browser_disconnected[0]:
                            continue
                        try:
                            parsed = json.loads(raw)
                            t = parsed.get("type", "")
                            if t == "ping":
                                eid = parsed.get("ping_event", {}).get("event_id")
                                if eid is not None:
                                    await el_ws.send(json.dumps({"type": "pong", "event_id": eid}))
                            elif t in ("agent_response", "user_transcript"):
                                logger.info("[Browser] %s: %s", t, raw[:120])
                        except (json.JSONDecodeError, TypeError):
                            pass
                        if isinstance(raw, bytes):
                            await client_ws.send_bytes(raw)
                        else:
                            await client_ws.send_text(raw)
                except websockets.exceptions.ConnectionClosedOK:
                    logger.info("[Browser] ElevenLabs closed connection normally")
                except Exception as exc:
                    logger.error("[Browser] el_to_browser error: %s", exc)

            await asyncio.gather(browser_to_el(), el_to_browser(), return_exceptions=True)
            logger.info("[Browser] Session ended")

    except Exception as exc:
        logger.error("[Browser] Bridge error: %s", exc)
    finally:
        try:
            await client_ws.close()
        except Exception:
            pass
