import os
import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from ..db import get_db
from ..models.user import User
from ..models.api_key import UserAPIKey
from ..services.encryption import decrypt_key
from ..config import PIPER_URL, VOICEBOX_URL
from .auth import get_current_user

router = APIRouter()


class TTSSampleRequest(BaseModel):
    text: str
    provider: str
    voice: str | None = None
    model: str | None = None


async def _get_key(provider: str, user: User, db: AsyncSession) -> str | None:
    result = await db.execute(
        select(UserAPIKey).where(
            UserAPIKey.user_id == user.id, UserAPIKey.provider == provider
        )
    )
    row = result.scalar_one_or_none()
    if row:
        return decrypt_key(row.encrypted_key)
    if user.role == "admin":
        env_map = {
            "groq": "GROQ_API_KEY",
            "elevenlabs": "ELEVENLABS_API_KEY",
            "openai": "OPENAI_API_KEY",
            "azure": "AZURE_SPEECH_KEY",
        }
        env_var = env_map.get(provider)
        if env_var:
            return os.environ.get(env_var)
    return None


@router.post("/tts-sample")
async def tts_sample(
    req: TTSSampleRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")
    if len(text) > 200:
        text = text[:200].rsplit(" ", 1)[0] + "…"

    if req.provider == "piper_local":
        try:
            async with httpx.AsyncClient(timeout=30.0) as c:
                r = await c.post(
                    f"{PIPER_URL}/audio/speech",
                    headers={"Authorization": "Bearer local"},
                    json={"model": "tts-1", "voice": req.voice or "alloy", "input": text},
                )
                r.raise_for_status()
                return Response(content=r.content, media_type="audio/mpeg")
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"Piper TTS unreachable: {e}")

    if req.provider == "edge":
        try:
            import edge_tts
            communicate = edge_tts.Communicate(text, req.voice or "en-US-AriaNeural")
            buf = b""
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    buf += chunk["data"]
            return Response(content=buf, media_type="audio/mpeg")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Edge TTS failed: {e}")

    if req.provider == "groq":
        api_key = await _get_key("groq", user, db)
        if not api_key:
            raise HTTPException(status_code=400, detail="Groq API key not configured")
        try:
            async with httpx.AsyncClient(timeout=30.0) as c:
                r = await c.post(
                    "https://api.groq.com/openai/v1/audio/speech",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "model": req.model or "canopylabs/orpheus-v1-english",
                        "voice": req.voice or "autumn",
                        "input": text,
                        "response_format": "wav",
                    },
                )
                r.raise_for_status()
                return Response(content=r.content, media_type="audio/wav")
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail="Groq TTS request failed")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Groq TTS failed: {e}")

    if req.provider == "elevenlabs":
        api_key = await _get_key("elevenlabs", user, db)
        if not api_key:
            raise HTTPException(status_code=400, detail="ElevenLabs API key not configured")
        try:
            async with httpx.AsyncClient(timeout=30.0) as c:
                r = await c.post(
                    f"https://api.elevenlabs.io/v1/text-to-speech/{req.voice or '21m00Tcm4TlvDq8ikWAM'}",
                    headers={"xi-api-key": api_key, "accept": "audio/mpeg"},
                    json={
                        "text": text,
                        "model_id": req.model or "eleven_flash_v2_5",
                        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
                    },
                )
                r.raise_for_status()
                return Response(content=r.content, media_type="audio/mpeg")
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail="ElevenLabs request failed")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"ElevenLabs TTS failed: {e}")

    if req.provider == "openai":
        api_key = await _get_key("openai", user, db)
        if not api_key:
            raise HTTPException(status_code=400, detail="OpenAI API key not configured")
        try:
            async with httpx.AsyncClient(timeout=30.0) as c:
                r = await c.post(
                    "https://api.openai.com/v1/audio/speech",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={"model": req.model or "tts-1", "voice": req.voice or "alloy", "input": text},
                )
                r.raise_for_status()
                return Response(content=r.content, media_type="audio/mpeg")
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail="OpenAI request failed")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"OpenAI TTS failed: {e}")

    if req.provider == "azure":
        api_key = await _get_key("azure", user, db)
        region = os.environ.get("AZURE_SPEECH_REGION", "eastus")
        if not api_key:
            raise HTTPException(status_code=400, detail="Azure Speech API key not configured")
        voice = req.voice or "en-US-AriaNeural"
        lang = "-".join(voice.split("-")[:2]) if voice.count("-") >= 2 else "en-US"
        ssml = (
            f"<speak version='1.0' xml:lang='{lang}'>"
            f"<voice xml:lang='{lang}' name='{voice}'>{text}</voice></speak>"
        )
        try:
            async with httpx.AsyncClient(timeout=30.0) as c:
                r = await c.post(
                    f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
                    headers={
                        "Ocp-Apim-Subscription-Key": api_key,
                        "Content-Type": "application/ssml+xml",
                        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
                        "User-Agent": "livekit-ai-voice-agent",
                    },
                    content=ssml.encode("utf-8"),
                )
                r.raise_for_status()
                return Response(content=r.content, media_type="audio/mpeg")
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail="Azure request failed")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Azure TTS failed: {e}")

    if req.provider == "voicebox":
        profile_id = req.voice
        if not profile_id:
            raise HTTPException(status_code=400, detail="Voicebox requires a profile_id")
        try:
            async with httpx.AsyncClient(timeout=60.0) as c:
                r = await c.post(
                    f"{VOICEBOX_URL}/generate/stream",
                    json={
                        "profile_id": profile_id,
                        "text": text,
                        "language": "en",
                        "engine": req.model or "kokoro",
                        "normalize": True,
                    },
                )
                r.raise_for_status()
                ct = r.headers.get("content-type", "audio/wav")
                return Response(content=r.content, media_type=ct)
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail="Voicebox request failed")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Voicebox TTS failed: {e}")

    raise HTTPException(status_code=400, detail=f"Unknown TTS provider: {req.provider}")
