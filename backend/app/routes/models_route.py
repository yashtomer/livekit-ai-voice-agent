import logging
import os
import re
import httpx
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from ..db import get_db
from ..models.model_entry import ModelEntry
from ..models.user import User, UserRole
from ..models.api_key import UserAPIKey
from .auth import get_current_user
from ..config import OLLAMA_URL, VOICEBOX_URL

router = APIRouter()
logger = logging.getLogger("models")

FREE_PROVIDERS = {"whisper_local", "piper_local", "edge", "voicebox", "ollama"}

MODEL_COMPANIES = {
    "gemma": "Google", "phi": "Microsoft", "llama": "Meta",
    "qwen": "Alibaba", "mistral": "Mistral AI", "tinyllama": "TinyLlama",
    "deepseek": "DeepSeek", "codellama": "Meta",
}

ENV_KEY_MAP = {
    "openai": "OPENAI_API_KEY",
    "groq": "GROQ_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_API_KEY",
    "deepgram": "DEEPGRAM_API_KEY",
    "elevenlabs": "ELEVENLABS_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "azure": "AZURE_SPEECH_KEY",
}


def _model_to_dict(m: ModelEntry) -> dict:
    d = {
        "provider": m.provider,
        "model": m.model_id,
        "label": m.label,
        "price_per_hour": m.price_per_hour,
        "compute_profile": m.compute_profile,
        "min_vram_gb": m.min_vram_gb,
    }
    if m.config:
        d.update(m.config)
    return d


def _ollama_profile(name: str) -> tuple[str, int]:
    m = re.search(r"(\d+(?:\.\d+)?)\s*b\b", name.lower())
    params_b = float(m.group(1)) if m else None
    if params_b is None:
        return "gpu_small", 12
    if params_b >= 65:
        return "gpu_large", 48
    if params_b >= 11:
        return "gpu_mid", 24
    return "gpu_small", 12


@router.get("/models")
async def list_models(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(UserAPIKey.provider).where(UserAPIKey.user_id == user.id)
    )
    user_providers = {row[0] for row in result.fetchall()}

    if user.role == UserRole.admin:
        env_providers = {
            provider
            for provider, env_var in ENV_KEY_MAP.items()
            if os.environ.get(env_var)
        }
        user_providers |= env_providers

    available = FREE_PROVIDERS | user_providers

    result = await db.execute(
        select(ModelEntry)
        .where(ModelEntry.enabled == True)
        .order_by(ModelEntry.sort_order)
    )
    db_models = result.scalars().all()

    stt = [_model_to_dict(m) for m in db_models if m.model_type == "stt" and m.provider in available]
    # LLMs are always returned in full so customers can see paid options. The
    # frontend uses requires_api_key to decide whether to gate the "Start Call"
    # button and prompt the user to add a key. Ollama entries are excluded here
    # because they're appended below via a live /api/tags fetch — the sync job
    # also persists them to the DB, which would otherwise produce duplicates.
    llm = [
        {**_model_to_dict(m), "requires_api_key": m.provider not in available}
        for m in db_models if m.model_type == "llm" and m.provider != "ollama"
    ]
    tts = [_model_to_dict(m) for m in db_models if m.model_type == "tts" and m.provider in available]

    ollama_models = []
    ollama_error = None
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"{OLLAMA_URL}/api/tags")
            for m in r.json().get("models", []):
                name = m["name"]
                size_gb = round(m.get("size", 0) / 1e9, 2)
                base = name.split(":")[0].split("/")[-1].lower()
                company = next(
                    (v for k, v in MODEL_COMPANIES.items() if base.startswith(k)),
                    "Open Source",
                )
                profile, vram = _ollama_profile(name)
                ollama_models.append({
                    "provider": "ollama",
                    "model": name,
                    "label": f"Ollama ({company}) · {name} — FREE | {size_gb}GB | local",
                    "price_per_hour": 0.0,
                    "compute_profile": profile,
                    "min_vram_gb": vram,
                    "requires_api_key": False,
                })
    except Exception as e:
        ollama_error = str(e)

    voicebox_profiles = []
    if "voicebox" in available:
        try:
            async with httpx.AsyncClient(timeout=2.0) as c:
                r = await c.get(f"{VOICEBOX_URL}/profiles")
                if r.status_code == 200:
                    for p in r.json():
                        pid = p.get("id")
                        if not pid:
                            continue
                        name = p.get("name") or pid[:8]
                        engine = (p.get("default_engine") or "kokoro").lower()
                        lang = p.get("language", "en")
                        vtype = "cloned" if p.get("voice_type") == "cloned" else "preset"
                        # Engine drives the profile: Kokoro is light enough for
                        # CPU-real-time; Chatterbox / LuxTTS / Qwen / TADA need
                        # a small GPU (≈ 8 GB) to keep up with live calls.
                        if engine in {"kokoro"}:
                            profile, vram = "cpu_heavy", None
                        else:
                            profile, vram = "gpu_small", 8
                        voicebox_profiles.append({
                            "provider": "voicebox",
                            "voice": pid,
                            "model": engine,
                            "language": lang,
                            "price_per_hour": 0.0,
                            "label": f"Voicebox ({engine}) · {name} — FREE | ~3-8s | local · {vtype}",
                            "compute_profile": profile,
                            "min_vram_gb": vram,
                        })
        except Exception:
            pass

    return {
        "llm": llm + ollama_models,
        "stt": stt,
        "tts": tts + voicebox_profiles,
        "ollama_error": ollama_error,
    }
