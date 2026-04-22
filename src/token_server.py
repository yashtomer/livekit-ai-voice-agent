"""FastAPI token server + web UI for the LiveKit voice agent.

Serves a single-page UI that lets users pick STT/LLM/TTS models,
generates a signed JWT with the chosen config embedded as participant metadata,
and the agent reads that metadata to dynamically configure its pipeline.
"""

import asyncio
import json
import logging
import os
import secrets
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from livekit import api
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=ROOT / ".env")

logger = logging.getLogger("token-server")

# Config — all URLs have env-var overrides so this module runs both natively
# (localhost defaults) and inside Docker (service-name URLs from compose).
# LIVEKIT_URL is the PUBLIC URL we hand to the browser — it must be reachable
# from the user's host (usually ws://localhost:7880 via port-mapping). The
# agent uses its own LIVEKIT_URL env var pointing at the internal service
# name (ws://livekit-server:7880) when running in docker.
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")
PIPER_URL = os.environ.get("PIPER_URL", "http://localhost:8200/v1")

# ─── Static option lists with pricing/speed metadata ───

# ═══════════════════════════════════════════════════════
# STT options — ordered best-first for voice agents.
# "Best" = lowest real-time latency with solid accuracy.
# ═══════════════════════════════════════════════════════

LOCAL_STT_OPTIONS = [
    # English-only variants (`.en`) are ~30% faster on CPU. Pick one of these
    # if you're confident the session will only be English.
    {"provider": "whisper_local", "size": "small", "label": "OpenAI Whisper · small.en — FREE | ~3s | EN only | local"},
    {"provider": "whisper_local", "size": "base",  "label": "OpenAI Whisper · base.en — FREE | ~1.5s | EN only | local"},
    {"provider": "whisper_local", "size": "tiny",  "label": "OpenAI Whisper · tiny.en — FREE | ~0.5s | EN only | local"},
    # Multilingual variants — required for Hindi, Spanish, Japanese, Mandarin,
    # and any other non-English language (Whisper supports 99). Measured on
    # a 5-sec Hindi clip with int8 quantization and OMP_NUM_THREADS=8:
    #   - base-multi:  ~5s warm — fast, but Hindi may appear in Urdu script
    #   - small-multi: ~14s warm — slow, but Devanagari script-accurate
    # The LLM understands both scripts, so base-multi is fine for the voice
    # experience; only switch to small-multi if you care about the visible
    # transcript being in native Devanagari.
    {"provider": "whisper_local", "size": "base-multi",  "label": "OpenAI Whisper · base (multilingual) — FREE | ~5s warm | 99 langs · fast, Hindi→Urdu script"},
    {"provider": "whisper_local", "size": "small-multi", "label": "OpenAI Whisper · small (multilingual) — FREE | ~14s warm | 99 langs · script-accurate Hindi"},
]

# Listed in priority order (best for voice first). Only shown if API key set.
CLOUD_STT_PRESETS = [
    # Deepgram — fastest, purpose-built for voice agents
    {"provider": "deepgram", "model": "nova-3-general", "key_env": "DEEPGRAM_API_KEY",
     "label": "Deepgram · Nova-3 — $0.0043/min | ~0.15s | best for voice"},
    {"provider": "deepgram", "model": "nova-2-general", "key_env": "DEEPGRAM_API_KEY",
     "label": "Deepgram · Nova-2 — $0.0043/min | ~0.2s | proven"},
    # Groq — cheapest cloud
    {"provider": "groq", "model": "whisper-large-v3-turbo", "key_env": "GROQ_API_KEY",
     "label": "Groq · Whisper Turbo — $0.04/hr | ~0.3s | cheap"},
    # OpenAI — reliable reference
    {"provider": "openai", "model": "whisper-1", "key_env": "OPENAI_API_KEY",
     "label": "OpenAI · Whisper-1 — $0.006/min | ~0.8s | reliable"},
    # Groq large — best accuracy, slower
    {"provider": "groq", "model": "whisper-large-v3", "key_env": "GROQ_API_KEY",
     "label": "Groq · Whisper Large V3 — $0.11/hr | ~0.5s | accurate"},
]

# ═══════════════════════════════════════════════════════
# TTS options — ordered best-first.
# ElevenLabs / Cartesia are the gold standard for voice agents.
# ═══════════════════════════════════════════════════════

# ElevenLabs popular voices (top 8 from their library)
ELEVENLABS_VOICES = [
    {"id": "21m00Tcm4TlvDq8ikWAM", "name": "Rachel",    "desc": "F · American · calm"},
    {"id": "EXAVITQu4vr4xnSDxMaL", "name": "Sarah",     "desc": "F · American · confident"},
    {"id": "pNInz6obpgDQGcFmaJgB", "name": "Adam",      "desc": "M · American · deep"},
    {"id": "JBFqnCBsd6RMkjVDRZzb", "name": "George",    "desc": "M · British · warm"},
    {"id": "bIHbv24MWmeRgasZH58o", "name": "Will",      "desc": "M · American · friendly"},
    {"id": "XB0fDUnXU5powFXDhCwa", "name": "Charlotte", "desc": "F · English · pleasant"},
    {"id": "cgSgspJ2msm6clMCkdW9", "name": "Jessica",   "desc": "F · American · expressive"},
    {"id": "nPczCjzI2devNBz1zQrb", "name": "Brian",     "desc": "M · American · deep rich"},
]

ELEVENLABS_TTS_PRESETS = [
    {"provider": "elevenlabs", "model": "eleven_flash_v2_5", "voice": v["id"],
     "voice_name": v["name"], "key_env": "ELEVENLABS_API_KEY",
     "label": f"ElevenLabs · {v['name']} (Flash) — $0.15/1K chars | ~75ms | {v['desc']}"}
    for v in ELEVENLABS_VOICES
] + [
    # Multilingual v2 — highest quality, slightly higher latency
    {"provider": "elevenlabs", "model": "eleven_multilingual_v2", "voice": ELEVENLABS_VOICES[0]["id"],
     "voice_name": "Rachel HD", "key_env": "ELEVENLABS_API_KEY",
     "label": "ElevenLabs · Rachel (Multilingual v2) — $0.30/1K chars | ~200ms | premium quality"},
]

OPENAI_TTS_PRESETS = [
    {"provider": "openai", "model": "tts-1", "voice": v, "key_env": "OPENAI_API_KEY",
     "label": f"OpenAI · {v.capitalize()} — $15/1M chars | ~0.5s | good quality"}
    for v in ["alloy", "nova", "shimmer", "echo", "fable", "onyx"]
] + [
    {"provider": "openai", "model": "tts-1-hd", "voice": v, "key_env": "OPENAI_API_KEY",
     "label": f"OpenAI · {v.capitalize()} HD — $30/1M chars | ~0.7s | studio quality"}
    for v in ["alloy", "nova", "onyx"]
]

# ═══════════════════════════════════════════════════════
# Azure Neural TTS — Microsoft's *official* production TTS API.
# Same neural models as `edge-tts` (voices are named identically: AriaNeural,
# SwaraNeural, etc.) but accessed via the enterprise Azure endpoint with
# proper streaming, ~3-5× lower latency, regional routing, and SLA backing.
# Free tier F0 = 500K characters/month (~50 min of speech).
# Requires:  AZURE_SPEECH_KEY  and  AZURE_SPEECH_REGION  in .env
# Sign up: https://portal.azure.com/  → Create → "Speech" → F0 (free) pricing
# ═══════════════════════════════════════════════════════

AZURE_TTS_VOICES = [
    # English (US) — most popular neural voices
    {"voice": "en-US-AriaNeural",       "language": "en-US", "desc": "F · US · natural"},
    {"voice": "en-US-JennyNeural",      "language": "en-US", "desc": "F · US · friendly"},
    {"voice": "en-US-GuyNeural",        "language": "en-US", "desc": "M · US · casual"},
    {"voice": "en-US-BrianNeural",      "language": "en-US", "desc": "M · US · warm"},
    {"voice": "en-US-DavisNeural",      "language": "en-US", "desc": "M · US · confident"},
    # Multilingual — one voice that speaks 70+ languages (auto-detect)
    {"voice": "en-US-AndrewMultilingualNeural", "language": "en-US", "desc": "M · multilingual"},
    {"voice": "en-US-EmmaMultilingualNeural",   "language": "en-US", "desc": "F · multilingual"},
    # English (UK)
    {"voice": "en-GB-SoniaNeural",      "language": "en-GB", "desc": "F · UK · pleasant"},
    {"voice": "en-GB-RyanNeural",       "language": "en-GB", "desc": "M · UK · professional"},
    # English (India) — for Indian-accented English voice agents
    {"voice": "en-IN-NeerjaNeural",     "language": "en-IN", "desc": "F · Indian English"},
    {"voice": "en-IN-PrabhatNeural",    "language": "en-IN", "desc": "M · Indian English"},
    # Hindi — the reason this was worth wiring up
    {"voice": "hi-IN-SwaraNeural",      "language": "hi-IN", "desc": "F · Hindi"},
    {"voice": "hi-IN-MadhurNeural",     "language": "hi-IN", "desc": "M · Hindi"},
    {"voice": "hi-IN-AnanyaNeural",     "language": "hi-IN", "desc": "F · Hindi (younger)"},
    {"voice": "hi-IN-AaravNeural",      "language": "hi-IN", "desc": "M · Hindi (younger)"},
]

AZURE_TTS_PRESETS = [
    {"provider": "azure", "voice": v["voice"], "language": v["language"],
     "key_env": "AZURE_SPEECH_KEY",
     "label": f"Azure · {v['voice'].split('-')[-1].replace('Neural','').replace('Multilingual','')} — ~$16/1M chars | ~200ms | {v['desc']}"}
    for v in AZURE_TTS_VOICES
]


EDGE_TTS_OPTIONS = [
    # English
    {"provider": "edge", "voice": "en-US-AriaNeural",        "language": "en", "label": "Microsoft Edge · Aria (F) — FREE | ~0.3s | natural"},
    {"provider": "edge", "voice": "en-US-JennyNeural",       "language": "en", "label": "Microsoft Edge · Jenny (F) — FREE | ~0.3s | friendly"},
    {"provider": "edge", "voice": "en-US-GuyNeural",         "language": "en", "label": "Microsoft Edge · Guy (M) — FREE | ~0.3s | casual"},
    {"provider": "edge", "voice": "en-US-BrianNeural",       "language": "en", "label": "Microsoft Edge · Brian (M) — FREE | ~0.3s | warm"},
    {"provider": "edge", "voice": "en-US-ChristopherNeural", "language": "en", "label": "Microsoft Edge · Christopher (M) — FREE | ~0.3s | deep"},
    {"provider": "edge", "voice": "en-US-EmmaNeural",        "language": "en", "label": "Microsoft Edge · Emma (F) — FREE | ~0.3s | clear"},
    # Hindi — natural Microsoft neural voices, free, ~1.5s on CPU (much
    # faster than local Kokoro Hindi in Docker which takes 3-8s).
    {"provider": "edge", "voice": "hi-IN-SwaraNeural",       "language": "hi", "label": "Microsoft Edge · Swara (F, HI) — FREE | ~1.5s | fast Hindi"},
    {"provider": "edge", "voice": "hi-IN-MadhurNeural",      "language": "hi", "label": "Microsoft Edge · Madhur (M, HI) — FREE | ~1.5s | fast Hindi"},
]

CLOUD_TTS_PRESETS = [
    {"provider": "groq", "model": "canopylabs/orpheus-v1-english", "voice": "autumn",  "key_env": "GROQ_API_KEY", "label": "Groq (Canopy) · Autumn (F) — $0.05/1K | ~0.3s"},
    {"provider": "groq", "model": "canopylabs/orpheus-v1-english", "voice": "diana",   "key_env": "GROQ_API_KEY", "label": "Groq (Canopy) · Diana (F) — $0.05/1K | ~0.3s"},
    {"provider": "groq", "model": "canopylabs/orpheus-v1-english", "voice": "hannah",  "key_env": "GROQ_API_KEY", "label": "Groq (Canopy) · Hannah (F) — $0.05/1K | ~0.3s"},
    {"provider": "groq", "model": "canopylabs/orpheus-v1-english", "voice": "austin",  "key_env": "GROQ_API_KEY", "label": "Groq (Canopy) · Austin (M) — $0.05/1K | ~0.3s"},
    {"provider": "groq", "model": "canopylabs/orpheus-v1-english", "voice": "daniel",  "key_env": "GROQ_API_KEY", "label": "Groq (Canopy) · Daniel (M) — $0.05/1K | ~0.3s"},
    {"provider": "groq", "model": "canopylabs/orpheus-v1-english", "voice": "troy",    "key_env": "GROQ_API_KEY", "label": "Groq (Canopy) · Troy (M) — $0.05/1K | ~0.3s"},
]

LOCAL_TTS_OPTIONS = [
    {"provider": "piper_local", "voice": "alloy",   "label": "Piper · alloy — FREE | ~2.4s | local"},
    {"provider": "piper_local", "voice": "nova",    "label": "Piper · nova — FREE | ~2.4s | local"},
    {"provider": "piper_local", "voice": "echo",    "label": "Piper · echo — FREE | ~2.4s | local"},
    {"provider": "piper_local", "voice": "fable",   "label": "Piper · fable — FREE | ~2.4s | local"},
    {"provider": "piper_local", "voice": "onyx",    "label": "Piper · onyx — FREE | ~2.4s | local"},
    {"provider": "piper_local", "voice": "shimmer", "label": "Piper · shimmer — FREE | ~2.4s | local"},
]

# Voicebox (https://voicebox.sh) — local ElevenLabs alternative.
# Voice profiles are created by the user in the Voicebox app; we fetch
# them dynamically via GET /profiles in get_available_models().
VOICEBOX_URL = os.environ.get("VOICEBOX_URL", "http://localhost:17493")

# ═══════════════════════════════════════════════════════
# LLM options — ordered best-first for voice agents.
# Priority: low latency + decent quality + low cost.
# ═══════════════════════════════════════════════════════

CLOUD_LLM_PRESETS = [
    # TOP tier — the standard choices for production voice agents
    {"provider": "openai",    "model": "gpt-4o-mini",             "key_env": "OPENAI_API_KEY",
     "label": "OpenAI · GPT-4o mini — $0.15/1M tok | ~0.4s | fast + smart + cheap"},
    {"provider": "google",    "model": "gemini-2.0-flash",        "key_env": "GOOGLE_API_KEY",
     "label": "Google · Gemini 2.0 Flash — $0.10/1M tok | ~0.3s | fast + cheap"},
    {"provider": "groq",      "model": "llama-3.3-70b-versatile", "key_env": "GROQ_API_KEY",
     "label": "Groq (Meta) · Llama 3.3 70B — $0.59/1M tok | ~0.5s | fast + smart"},
    {"provider": "anthropic", "model": "claude-haiku-4-5",        "key_env": "ANTHROPIC_API_KEY",
     "label": "Anthropic · Claude Haiku 4.5 — $1/1M tok | ~0.5s | smart + fast"},
    # MID tier
    {"provider": "groq",      "model": "llama-3.1-8b-instant",    "key_env": "GROQ_API_KEY",
     "label": "Groq (Meta) · Llama 3.1 8B — $0.05/1M tok | ~0.2s | fastest"},
    {"provider": "google",    "model": "gemini-1.5-flash",        "key_env": "GOOGLE_API_KEY",
     "label": "Google · Gemini 1.5 Flash — $0.075/1M tok | ~0.3s | stable"},
    {"provider": "openai",    "model": "gpt-4o",                  "key_env": "OPENAI_API_KEY",
     "label": "OpenAI · GPT-4o — $2.50/1M tok | ~0.6s | flagship"},
    {"provider": "groq",      "model": "qwen/qwen3-32b",          "key_env": "GROQ_API_KEY",
     "label": "Groq (Alibaba) · Qwen3 32B — $0.40/1M tok | ~0.3s | capable"},
    {"provider": "deepseek",  "model": "deepseek-chat",           "key_env": "DEEPSEEK_API_KEY",
     "label": "DeepSeek · Chat — $0.14/1M tok | ~0.5s | value"},
    # PREMIUM tier — for quality-over-cost scenarios
    {"provider": "anthropic", "model": "claude-sonnet-4-5",       "key_env": "ANTHROPIC_API_KEY",
     "label": "Anthropic · Claude Sonnet 4.5 — $15/1M tok | ~0.8s | premium"},
]


def _filter_by_env(presets):
    """Drop presets whose required API key env var isn't set."""
    return [
        {k: v for k, v in p.items() if k != "key_env"}
        for p in presets
        if not p.get("key_env") or os.environ.get(p["key_env"])
    ]

# Ollama cache
_models_cache = {"data": None, "expires_at": 0}
_CACHE_TTL = 30  # seconds

# Live FX rate cache — 1 hour
_fx_cache = {"data": None, "expires_at": 0}


app = FastAPI(title="Voice Agent Config UI")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class NoCacheMiddleware(BaseHTTPMiddleware):
    """Prevent browsers from caching ANYTHING served by this dev server —
    HTML page, JS, CSS, and API responses. Ensures users always see the
    latest code and that tokens/model lists are never served from disk cache."""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

app.add_middleware(NoCacheMiddleware)

web_dir = ROOT / "web"
app.mount("/static", StaticFiles(directory=web_dir), name="static")


@app.get("/")
def index():
    return FileResponse(web_dir / "index.html")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/models")
async def list_models():
    """List available STT, LLM, and TTS options."""
    now = time.time()
    if _models_cache["data"] and _models_cache["expires_at"] > now:
        return _models_cache["data"]

    # Query Ollama for locally installed models
    ollama_models = []
    ollama_error = None
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"{OLLAMA_URL}/api/tags")
            # Map Ollama model names to their creator companies
            MODEL_COMPANIES = {
                "gemma": "Google", "phi": "Microsoft", "llama": "Meta",
                "qwen": "Alibaba", "mistral": "Mistral AI", "tinyllama": "TinyLlama",
                "deepseek": "DeepSeek", "codellama": "Meta", "vicuna": "LMSYS",
                "orca": "Microsoft", "starcoder": "BigCode",
            }
            for m in r.json().get("models", []):
                name = m["name"]
                size_gb = round(m.get("size", 0) / 1e9, 2)
                base = name.split(":")[0].split("/")[-1].lower()
                company = next((v for k, v in MODEL_COMPANIES.items() if base.startswith(k)), "Open Source")
                ollama_models.append({
                    "provider": "ollama",
                    "model": name,
                    "label": f"Ollama ({company}) · {name} — FREE | {size_gb}GB | local",
                })
    except Exception as e:
        ollama_error = str(e)
        logger.warning(f"Ollama unreachable: {e}")

    # Query Voicebox (https://voicebox.sh) for user-created voice profiles.
    # Shape of each profile (see backend/models.py VoiceProfileResponse):
    #   {id, name, language, default_engine, preset_engine, voice_type, ...}
    # Fails silently if Voicebox isn't running — profiles just won't appear.
    voicebox_profiles = []
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(f"{VOICEBOX_URL}/profiles")
            if r.status_code == 200:
                for p in r.json():
                    pid = p.get("id")
                    if not pid:
                        continue
                    name   = p.get("name") or pid[:8]
                    engine = (p.get("default_engine") or p.get("preset_engine") or "kokoro").lower()
                    lang   = p.get("language", "en")
                    vtype  = p.get("voice_type", "preset")  # "cloned" or "preset"
                    tag    = "cloned" if vtype == "cloned" else "preset"
                    voicebox_profiles.append({
                        "provider": "voicebox",
                        "voice": pid,
                        "model": engine,
                        "language": lang,
                        # Realistic latency on Intel-Mac + Docker CPU inference
                        # is 3-8 s/utterance. On Apple Silicon or native Python
                        # the same voice is 0.5-2s. Adjust label to set the
                        # right expectation so users don't pick Voicebox for
                        # live calls without knowing what they're signing up for.
                        "label": f"Voicebox ({engine}) · {name} — FREE | ~3-8s on CPU | local · {tag}",
                    })
                logger.info(f"Voicebox: {len(voicebox_profiles)} profile(s) loaded from {VOICEBOX_URL}")
    except Exception as e:
        logger.debug(f"Voicebox unreachable at {VOICEBOX_URL}: {e}")

    # Filter cloud presets by available API keys — preserves best-first order
    cloud_llms = _filter_by_env(CLOUD_LLM_PRESETS)
    cloud_stts = _filter_by_env(CLOUD_STT_PRESETS)
    cloud_groq_tts = _filter_by_env(CLOUD_TTS_PRESETS)
    elevenlabs_tts = _filter_by_env(ELEVENLABS_TTS_PRESETS)
    openai_tts     = _filter_by_env(OPENAI_TTS_PRESETS)
    azure_tts      = _filter_by_env(AZURE_TTS_PRESETS)

    data = {
        # LLM: cloud (best-first) → Ollama local (at end)
        "llm": cloud_llms + ollama_models,
        # STT: cloud (best-first) → Whisper local
        "stt": cloud_stts + LOCAL_STT_OPTIONS,
        # TTS: ElevenLabs (gold, ~75ms) → OpenAI → Azure Neural (~200ms, same
        #      voices as Edge but ~4× faster) → Voicebox local → Edge (free
        #      unofficial) → Groq Orpheus → Piper local
        "tts": elevenlabs_tts + openai_tts + azure_tts + voicebox_profiles
               + EDGE_TTS_OPTIONS + cloud_groq_tts + LOCAL_TTS_OPTIONS,
        "ollama_error": ollama_error,
    }
    _models_cache["data"] = data
    _models_cache["expires_at"] = now + _CACHE_TTL
    return data


class TokenRequest(BaseModel):
    stt: dict
    llm: dict
    tts: dict
    identity: str | None = None


class TTSSampleRequest(BaseModel):
    """Request to synthesize a short sample for voice comparison."""
    text: str
    provider: str
    voice: str | None = None
    model: str | None = None


@app.post("/api/tts-sample")
async def tts_sample(req: TTSSampleRequest):
    """Synthesize a text sample using the chosen TTS provider. Used by the
    browser's voice-comparison panel so users can hear how different TTS
    engines would speak the conversation without restarting the call."""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")
    # Cap length — samples should be short to keep things snappy
    if len(text) > 400:
        text = text[:400].rsplit(" ", 1)[0] + "…"

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
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise HTTPException(status_code=400, detail="GROQ_API_KEY not set in .env")
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
            raise HTTPException(status_code=e.response.status_code,
                                detail=f"Groq error: {e.response.text[:200]}")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Groq TTS failed: {e}")

    if req.provider == "elevenlabs":
        api_key = os.environ.get("ELEVENLABS_API_KEY")
        if not api_key:
            raise HTTPException(status_code=400, detail="ELEVENLABS_API_KEY not set in .env")
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
            raise HTTPException(status_code=e.response.status_code,
                                detail=f"ElevenLabs error: {e.response.text[:200]}")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"ElevenLabs TTS failed: {e}")

    if req.provider == "openai":
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise HTTPException(status_code=400, detail="OPENAI_API_KEY not set in .env")
        try:
            async with httpx.AsyncClient(timeout=30.0) as c:
                r = await c.post(
                    "https://api.openai.com/v1/audio/speech",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "model": req.model or "tts-1",
                        "voice": req.voice or "alloy",
                        "input": text,
                    },
                )
                r.raise_for_status()
                return Response(content=r.content, media_type="audio/mpeg")
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code,
                                detail=f"OpenAI error: {e.response.text[:200]}")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"OpenAI TTS failed: {e}")

    if req.provider == "azure":
        # Azure Neural TTS — SSML REST API. Same voices as edge-tts but via
        # the official enterprise endpoint (faster, SLA-backed, paid).
        # Docs: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
        api_key = os.environ.get("AZURE_SPEECH_KEY")
        region = os.environ.get("AZURE_SPEECH_REGION", "eastus")
        if not api_key:
            raise HTTPException(status_code=400, detail="AZURE_SPEECH_KEY not set in .env")
        voice = req.voice or "en-US-AriaNeural"
        # Derive language tag from voice name, e.g. "hi-IN-SwaraNeural" → "hi-IN"
        lang = "-".join(voice.split("-")[:2]) if voice.count("-") >= 2 else "en-US"
        ssml = (
            f"<speak version='1.0' xml:lang='{lang}'>"
            f"<voice xml:lang='{lang}' name='{voice}'>"
            f"{text}"
            f"</voice></speak>"
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
            raise HTTPException(status_code=e.response.status_code,
                                detail=f"Azure error: {e.response.text[:200]}")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Azure TTS failed: {e}")

    if req.provider == "voicebox":
        # Voicebox one-shot flow: POST /generate/stream returns the full WAV
        # when generation completes. Replaces the older 3-step flow
        # (POST /generate → SSE /status → GET /audio) which added up to ~1s
        # of round-trip and heartbeat-grace overhead with zero benefit —
        # Kokoro doesn't actually stream audio progressively, it buffers.
        profile_id = req.voice
        engine = req.model or "kokoro"
        if not profile_id:
            raise HTTPException(status_code=400, detail="Voicebox requires a profile_id (voice field)")
        try:
            # 60s timeout: Kokoro on CPU/Docker can take 10-20s for longer texts
            async with httpx.AsyncClient(timeout=60.0) as c:
                r = await c.post(
                    f"{VOICEBOX_URL}/generate/stream",
                    json={
                        "profile_id": profile_id,
                        "text": text,
                        "language": "en",
                        "engine": engine,
                        "normalize": True,
                    },
                )
                r.raise_for_status()
                ct = r.headers.get("content-type", "audio/wav")
                return Response(content=r.content, media_type=ct)

        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code,
                                detail=f"Voicebox error: {e.response.text[:200]}")
        except httpx.ConnectError:
            raise HTTPException(status_code=502,
                                detail=f"Voicebox not running at {VOICEBOX_URL}. Start it with: cd voicebox && docker compose up -d")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Voicebox TTS failed: {e}")

    raise HTTPException(status_code=400, detail=f"Unknown TTS provider: {req.provider}")


@app.get("/api/fx-rate")
async def fx_rate():
    """Live USD → INR exchange rate, cached for 1 hour. Uses Frankfurter
    (ECB data, free, no API key). Falls back gracefully if unreachable."""
    now = time.time()
    cached = _fx_cache.get("data")
    if cached and _fx_cache["expires_at"] > now:
        return cached
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get("https://api.frankfurter.app/latest?from=USD&to=INR")
            r.raise_for_status()
            data = r.json()
            result = {
                "rate": data["rates"]["INR"],
                "date": data.get("date"),
                "source": "frankfurter.app (ECB)",
                "fetched_at": now,
            }
            _fx_cache["data"] = result
            _fx_cache["expires_at"] = now + 3600  # 1 hour
            return result
    except Exception as e:
        logger.warning(f"FX rate fetch failed: {e}")
        # Fall back to previously-cached value if any, else a sane default
        if cached:
            return cached
        return {"rate": 84.0, "date": None, "source": "fallback", "fetched_at": now}


@app.post("/api/token")
def create_token(req: TokenRequest):
    """Generate a LiveKit access token with config embedded as participant metadata."""
    identity = req.identity or f"user-{secrets.token_hex(4)}"
    room_name = f"voice-{secrets.token_hex(4)}"
    metadata_json = json.dumps({
        "stt": req.stt,
        "llm": req.llm,
        "tts": req.tts,
    })

    try:
        token = (
            api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
            .with_identity(identity)
            .with_name(identity)
            .with_metadata(metadata_json)
            .with_grants(api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            ))
            .to_jwt()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Token generation failed: {e}")

    return {
        "token": token,
        "url": LIVEKIT_URL,
        "room": room_name,
        "identity": identity,
    }
