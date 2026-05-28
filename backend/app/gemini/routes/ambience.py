"""
Ambience catalogue + preview endpoint.

GET  /api/ambience/                — list registered ambient sounds
GET  /api/ambience/preview/{slug}.wav  — short WAV preview for the agent editor
"""

from __future__ import annotations

import io
import logging
import wave

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ..ambience import list_ambience
from ..ambience.mixer import _load_buffer
from ..ambience.registry import by_slug

log = logging.getLogger("ambience")

router = APIRouter()

PREVIEW_RATE = 24000
PREVIEW_DURATION_S = 5


@router.get("/")
async def list_sounds():
    """Catalogue used by the agent-editor pickers."""
    return {"items": list_ambience()}


@router.get("/preview/{slug}.wav")
async def preview_wav(slug: str):
    """Return a short WAV preview of the chosen ambient slug.

    Streams ``PREVIEW_DURATION_S`` seconds of looped audio at full volume so
    the operator can clearly hear the sound before saving the agent.
    """
    if not by_slug(slug):
        raise HTTPException(404, f"Unknown ambient slug: {slug}")

    pcm = _load_buffer(slug, PREVIEW_RATE)
    if not pcm:
        raise HTTPException(500, "Failed to load ambient buffer")

    need_bytes = PREVIEW_RATE * 2 * PREVIEW_DURATION_S
    if len(pcm) >= need_bytes:
        clip = pcm[:need_bytes]
    else:
        reps = need_bytes // len(pcm) + 1
        clip = (pcm * reps)[:need_bytes]

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(PREVIEW_RATE)
        w.writeframes(clip)

    return Response(
        content=buf.getvalue(),
        media_type="audio/wav",
        headers={"Cache-Control": "no-cache"},
    )
