"""
On-demand Gemini Live voice samples with disk caching.

GET /api/voice-samples/{voice}.wav
  - If cached: serves backend/voice_samples/{voice}.wav
  - Otherwise: opens a brief Gemini Live session, asks the model to read a
    short sample line, captures PCM16 @ 24 kHz, wraps in WAV, caches, returns.

Concurrency: a per-voice asyncio lock prevents two concurrent first-time hits
from launching two Gemini sessions for the same voice.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import struct
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

log = logging.getLogger("voice_samples")
router = APIRouter()

GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
MODEL = os.environ.get("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-001")
API_VERSION = os.environ.get("GEMINI_API_VERSION", "v1beta")

SAMPLE_DIR = Path(__file__).resolve().parents[3] / "voice_samples"
SAMPLE_DIR.mkdir(parents=True, exist_ok=True)

_VOICE_NAME = re.compile(r"^[A-Za-z]{2,40}$")
_locks: dict[str, asyncio.Lock] = {}


def _wav_pcm16(pcm_bytes: bytes, sample_rate: int = 24000) -> bytes:
    """Wrap raw PCM16 mono in a WAV container."""
    byte_rate = sample_rate * 2
    block_align = 2
    data_size = len(pcm_bytes)
    return (
        b"RIFF" + struct.pack("<I", 36 + data_size) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, byte_rate, block_align, 16)
        + b"data" + struct.pack("<I", data_size) + pcm_bytes
    )


async def _generate_sample(voice: str) -> bytes:
    """Run a brief Gemini Live session to synthesize a sample for `voice`."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=GOOGLE_API_KEY, http_options={"api_version": API_VERSION})

    cfg = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
        system_instruction=types.Content(
            parts=[types.Part(text=(
                f"You are demonstrating the {voice} voice. "
                "When given a prompt, respond with EXACTLY the sentence you are asked to say, "
                "in a natural conversational tone. Do not add anything else."
            ))]
        ),
    )

    pcm_chunks: list[bytes] = []
    async with client.aio.live.connect(model=MODEL, config=cfg) as session:
        await session.send_client_content(
            turns=types.Content(
                role="user",
                parts=[types.Part(text=(
                    f"Say exactly: Hello, I'm {voice}. This is a sample of how I sound."
                ))]
            ),
            turn_complete=True,
        )

        try:
            async with asyncio.timeout(15):
                async for response in session.receive():
                    if response.data:
                        pcm_chunks.append(response.data)
                    sc = response.server_content
                    if sc and sc.turn_complete:
                        break
        except asyncio.TimeoutError:
            log.warning("Gemini sample generation timed out for voice %s", voice)

    if not pcm_chunks:
        raise HTTPException(502, f"No audio returned for voice {voice}")

    return _wav_pcm16(b"".join(pcm_chunks))


@router.get("/{voice}.wav")
async def get_sample(voice: str):
    if not _VOICE_NAME.match(voice):
        raise HTTPException(400, "Invalid voice name")
    if not GOOGLE_API_KEY:
        raise HTTPException(500, "GOOGLE_API_KEY not configured")

    path = SAMPLE_DIR / f"{voice}.wav"
    if path.exists() and path.stat().st_size > 0:
        return FileResponse(path, media_type="audio/wav")

    lock = _locks.setdefault(voice, asyncio.Lock())
    async with lock:
        if path.exists() and path.stat().st_size > 0:
            return FileResponse(path, media_type="audio/wav")
        try:
            wav = await _generate_sample(voice)
        except HTTPException:
            raise
        except Exception as e:
            log.exception("Sample generation failed for %s", voice)
            raise HTTPException(502, f"Sample generation failed: {e}")

        path.write_bytes(wav)

    return FileResponse(path, media_type="audio/wav")
