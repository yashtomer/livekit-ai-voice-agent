"""
Default model seed data.

price_per_hour is estimated cost of running ONE agent for ONE wall-clock hour:
  • STT  — real-time audio, so 1 hr audio = 1 hr cost  (rate × 60 min)
  • LLM  — baseline 30 000 tokens/hr (15 K in + 15 K out, ~3 exchanges/min)
  • TTS  — baseline 50 000 chars/hr  (agent speaks ~50 % at 150 wpm × 5 chars/word)

Labels intentionally omit prices (shown in the Price column).
Include: latency · language(s) · gender/voice · key trait.
Admins can edit labels inline via the Models panel.
"""

from .models.model_entry import ModelType

# (model_type, provider, model_id, label, price_per_hour, config, sort_order)
SEED_MODELS = [
    # ─── STT ──────────────────────────────────────────────────────────────────
    # Local Whisper (OpenAI open-source) — runs on CPU, no API key needed
    (ModelType.stt, "whisper_local", "tiny",
        "Whisper · tiny.en | ~0.5s | EN only | fastest · local",
        0.000, {"size": "tiny"}, 10),
    (ModelType.stt, "whisper_local", "base",
        "Whisper · base.en | ~1.5s | EN only | balanced · local",
        0.000, {"size": "base"}, 11),
    (ModelType.stt, "whisper_local", "small",
        "Whisper · small.en | ~3s | EN only | accurate · local",
        0.000, {"size": "small"}, 12),
    (ModelType.stt, "whisper_local", "base-multi",
        "Whisper · base (multilingual) | ~5s | 99 languages | balanced · local",
        0.000, {"size": "base-multi"}, 13),
    (ModelType.stt, "whisper_local", "small-multi",
        "Whisper · small (multilingual) | ~14s | 99 languages | best local accuracy",
        0.000, {"size": "small-multi"}, 14),

    # Deepgram — $0.0059/min Nova-3 | $0.0043/min Nova-2
    (ModelType.stt, "deepgram", "nova-3-general",
        "Deepgram · Nova-3 | ~150ms | EN + 36 languages | newest · highest accuracy",
        0.462, {"model": "nova-3-general"}, 20),
    (ModelType.stt, "deepgram", "nova-2-general",
        "Deepgram · Nova-2 | ~200ms | 36 languages | proven · reliable",
        0.258, {"model": "nova-2-general"}, 21),

    # Groq STT — billed per audio-hour processed
    (ModelType.stt, "groq", "whisper-large-v3-turbo",
        "Groq · Whisper Large V3 Turbo | ~300ms | 99 languages | fast · cost-efficient",
        0.040, {"model": "whisper-large-v3-turbo"}, 22),
    (ModelType.stt, "groq", "whisper-large-v3",
        "Groq · Whisper Large V3 | ~500ms | 99 languages | highest cloud accuracy",
        0.111, {"model": "whisper-large-v3"}, 23),

    # OpenAI
    (ModelType.stt, "openai", "whisper-1",
        "OpenAI · Whisper-1 | ~800ms | 57 languages | stable · reliable",
        0.360, {"model": "whisper-1"}, 24),

    # ─── LLM ──────────────────────────────────────────────────────────────────
    # Groq — ultra-low TTFT via dedicated inference hardware
    (ModelType.llm, "groq", "meta-llama/llama-4-scout-17b-16e-instruct",
        "Llama 4 Scout 17B (Groq) | TTFT ~200ms | 12 languages | 10M ctx · lightning fast",
        0.007, {"model": "meta-llama/llama-4-scout-17b-16e-instruct"}, 30),
    (ModelType.llm, "groq", "llama-3.3-70b-versatile",
        "Llama 3.3 70B (Groq) | TTFT ~500ms | 8 languages | 128K ctx · smart + fast",
        0.021, {"model": "llama-3.3-70b-versatile"}, 31),
    (ModelType.llm, "groq", "llama-3.1-8b-instant",
        "Llama 3.1 8B (Groq) | TTFT ~200ms | 8 languages | 128K ctx · fastest",
        0.002, {"model": "llama-3.1-8b-instant"}, 32),
    (ModelType.llm, "groq", "qwen/qwen3-32b",
        "Qwen3 32B (Groq) | TTFT ~300ms | 29 languages | 32K ctx · capable",
        0.012, {"model": "qwen/qwen3-32b"}, 33),

    # OpenAI — GPT-4.1 series (April 2025) + GPT-4o
    (ModelType.llm, "openai", "gpt-4.1",
        "OpenAI · GPT-4.1 | TTFT ~500ms | 100+ languages | 1M ctx · latest flagship",
        0.150, {"model": "gpt-4.1"}, 40),
    (ModelType.llm, "openai", "gpt-4.1-mini",
        "OpenAI · GPT-4.1 mini | TTFT ~300ms | 100+ languages | 1M ctx · fast + smart",
        0.030, {"model": "gpt-4.1-mini"}, 41),
    (ModelType.llm, "openai", "gpt-4o",
        "OpenAI · GPT-4o | TTFT ~600ms | 100+ languages | 128K ctx · multimodal",
        0.188, {"model": "gpt-4o"}, 42),
    (ModelType.llm, "openai", "gpt-4o-mini",
        "OpenAI · GPT-4o mini | TTFT ~400ms | 100+ languages | 128K ctx · cost-efficient",
        0.011, {"model": "gpt-4o-mini"}, 43),

    # Google Gemini
    (ModelType.llm, "google", "gemini-2.5-flash",
        "Gemini 2.5 Flash (Google) | TTFT ~300ms | 100+ languages | 1M ctx · fast + smart",
        0.011, {"model": "gemini-2.5-flash"}, 50),
    (ModelType.llm, "google", "gemini-2.0-flash",
        "Gemini 2.0 Flash (Google) | TTFT ~300ms | 100+ languages | 1M ctx · reliable",
        0.008, {"model": "gemini-2.0-flash"}, 51),
    (ModelType.llm, "google", "gemini-1.5-flash",
        "Gemini 1.5 Flash (Google) | TTFT ~300ms | 100+ languages | 1M ctx · stable",
        0.006, {"model": "gemini-1.5-flash"}, 52),

    # Anthropic Claude — versioned model IDs required
    (ModelType.llm, "anthropic", "claude-haiku-4-5-20251001",
        "Claude Haiku 4.5 (Anthropic) | TTFT ~400ms | 100+ languages | 200K ctx · fast + smart",
        0.072, {"model": "claude-haiku-4-5-20251001"}, 60),
    (ModelType.llm, "anthropic", "claude-sonnet-4-6",
        "Claude Sonnet 4.6 (Anthropic) | TTFT ~500ms | 100+ languages | 200K ctx · premium",
        0.270, {"model": "claude-sonnet-4-6"}, 61),
    (ModelType.llm, "anthropic", "claude-opus-4-7",
        "Claude Opus 4.7 (Anthropic) | TTFT ~1s | 100+ languages | 200K ctx · most capable",
        1.350, {"model": "claude-opus-4-7"}, 62),

    # DeepSeek
    (ModelType.llm, "deepseek", "deepseek-chat",
        "DeepSeek · V3 Chat | TTFT ~500ms | EN + ZH | 128K ctx · great value",
        0.006, {"model": "deepseek-chat"}, 70),

    # ─── TTS ──────────────────────────────────────────────────────────────────
    # ElevenLabs Flash v2.5 — ultra-low latency · $0.15/1K chars · ~$7.50/hr
    (ModelType.tts, "elevenlabs", "eleven_flash_v2_5:Rachel",
        "ElevenLabs · Rachel | ~75ms | EN (American) | F · calm · natural",
        7.50, {"model": "eleven_flash_v2_5", "voice": "21m00Tcm4TlvDq8ikWAM", "voice_name": "Rachel"}, 80),
    (ModelType.tts, "elevenlabs", "eleven_flash_v2_5:Sarah",
        "ElevenLabs · Sarah | ~75ms | EN (American) | F · confident · clear",
        7.50, {"model": "eleven_flash_v2_5", "voice": "EXAVITQu4vr4xnSDxMaL", "voice_name": "Sarah"}, 81),
    (ModelType.tts, "elevenlabs", "eleven_flash_v2_5:Adam",
        "ElevenLabs · Adam | ~75ms | EN (American) | M · deep · authoritative",
        7.50, {"model": "eleven_flash_v2_5", "voice": "pNInz6obpgDQGcFmaJgB", "voice_name": "Adam"}, 82),
    (ModelType.tts, "elevenlabs", "eleven_flash_v2_5:George",
        "ElevenLabs · George | ~75ms | EN (British) | M · warm · conversational",
        7.50, {"model": "eleven_flash_v2_5", "voice": "JBFqnCBsd6RMkjVDRZzb", "voice_name": "George"}, 83),

    # OpenAI TTS — $15/1M chars (TTS-1) | $30/1M chars (TTS-1-HD)
    (ModelType.tts, "openai", "tts-1:alloy",
        "OpenAI · Alloy | ~500ms | EN | neutral · balanced",
        0.75, {"model": "tts-1", "voice": "alloy"}, 90),
    (ModelType.tts, "openai", "tts-1:nova",
        "OpenAI · Nova | ~500ms | EN | F · warm · natural",
        0.75, {"model": "tts-1", "voice": "nova"}, 91),
    (ModelType.tts, "openai", "tts-1:shimmer",
        "OpenAI · Shimmer | ~500ms | EN | F · gentle · soft",
        0.75, {"model": "tts-1", "voice": "shimmer"}, 92),
    (ModelType.tts, "openai", "tts-1-hd:alloy",
        "OpenAI · Alloy HD | ~700ms | EN | neutral · studio quality",
        1.50, {"model": "tts-1-hd", "voice": "alloy"}, 93),

    # Azure Neural TTS — $16/1M chars · ~$0.80/hr
    (ModelType.tts, "azure", "en-US-AriaNeural",
        "Azure · Aria (Neural) | ~200ms | EN (American) | F · natural · conversational",
        0.80, {"voice": "en-US-AriaNeural", "language": "en-US"}, 100),
    (ModelType.tts, "azure", "en-US-JennyNeural",
        "Azure · Jenny (Neural) | ~200ms | EN (American) | F · friendly · assistant",
        0.80, {"voice": "en-US-JennyNeural", "language": "en-US"}, 101),
    (ModelType.tts, "azure", "hi-IN-SwaraNeural",
        "Azure · Swara (Neural) | ~200ms | Hindi | F · natural · expressive",
        0.80, {"voice": "hi-IN-SwaraNeural", "language": "hi-IN"}, 102),
    (ModelType.tts, "azure", "hi-IN-MadhurNeural",
        "Azure · Madhur (Neural) | ~200ms | Hindi | M · clear · formal",
        0.80, {"voice": "hi-IN-MadhurNeural", "language": "hi-IN"}, 103),

    # Microsoft Edge TTS — free, server-side synthesis
    (ModelType.tts, "edge", "en-US-AriaNeural",
        "Edge TTS · Aria | ~300ms | EN (American) | F · natural · free",
        0.00, {"voice": "en-US-AriaNeural", "language": "en"}, 110),
    (ModelType.tts, "edge", "en-US-JennyNeural",
        "Edge TTS · Jenny | ~300ms | EN (American) | F · friendly · free",
        0.00, {"voice": "en-US-JennyNeural", "language": "en"}, 111),
    (ModelType.tts, "edge", "en-US-GuyNeural",
        "Edge TTS · Guy | ~300ms | EN (American) | M · casual · free",
        0.00, {"voice": "en-US-GuyNeural", "language": "en"}, 112),
    (ModelType.tts, "edge", "en-US-BrianNeural",
        "Edge TTS · Brian | ~300ms | EN (American) | M · warm · free",
        0.00, {"voice": "en-US-BrianNeural", "language": "en"}, 113),
    (ModelType.tts, "edge", "hi-IN-SwaraNeural",
        "Edge TTS · Swara | ~1.5s | Hindi | F · natural · free",
        0.00, {"voice": "hi-IN-SwaraNeural", "language": "hi"}, 114),
    (ModelType.tts, "edge", "hi-IN-MadhurNeural",
        "Edge TTS · Madhur | ~1.5s | Hindi | M · clear · free",
        0.00, {"voice": "hi-IN-MadhurNeural", "language": "hi"}, 115),

    # Groq Orpheus TTS — $0.05/1K chars · ~$2.50/hr
    (ModelType.tts, "groq", "canopylabs/orpheus-v1-english:autumn",
        "Groq · Orpheus · Autumn | ~300ms | EN | F · expressive · natural",
        1.10, {"model": "canopylabs/orpheus-v1-english", "voice": "autumn"}, 120),
    (ModelType.tts, "groq", "canopylabs/orpheus-v1-english:diana",
        "Groq · Orpheus · Diana | ~300ms | EN | F · clear · professional",
        1.10, {"model": "canopylabs/orpheus-v1-english", "voice": "diana"}, 121),
    (ModelType.tts, "groq", "canopylabs/orpheus-v1-english:austin",
        "Groq · Orpheus · Austin | ~300ms | EN | M · confident · clear",
        1.10, {"model": "canopylabs/orpheus-v1-english", "voice": "austin"}, 122),

    # Piper — local TTS, free
    (ModelType.tts, "piper_local", "alloy",
        "Piper · alloy | ~2.4s | EN | local · free",
        0.00, {"voice": "alloy"}, 130),
    (ModelType.tts, "piper_local", "nova",
        "Piper · nova | ~2.4s | EN | local · free",
        0.00, {"voice": "nova"}, 131),
    (ModelType.tts, "piper_local", "echo",
        "Piper · echo | ~2.4s | EN | local · free",
        0.00, {"voice": "echo"}, 132),
    (ModelType.tts, "piper_local", "shimmer",
        "Piper · shimmer | ~2.4s | EN | local · free",
        0.00, {"voice": "shimmer"}, 133),
]


# ─── Compute-profile inference ───────────────────────────────────────────
# Drives the Cost Estimator's "Cloud Infrastructure" recommendation.
# Profiles (ordered by weight): none < cpu_light < cpu_heavy <
#                               gpu_small < gpu_mid < gpu_large.
# none means no server is needed (fully cloud); anything else implies a
# server with the corresponding minimum compute.

CLOUD_PROVIDERS = {
    "deepgram", "groq", "openai", "google", "anthropic",
    "deepseek", "elevenlabs", "azure", "edge",
}


def compute_profile_for(provider: str, config: dict | None) -> tuple[str, int | None]:
    """Returns (compute_profile, min_vram_gb) for a seed row."""
    if provider in CLOUD_PROVIDERS:
        return "none", None
    if provider == "whisper_local":
        size = (config or {}).get("size", "")
        # Heavier multilingual + small variants need ~CPU bound but slow on CPU;
        # mark cpu_heavy so the recommendation surfaces a beefier instance.
        if size in ("small", "small-multi"):
            return "cpu_heavy", None
        return "cpu_light", None
    if provider == "piper_local":
        return "cpu_light", None
    if provider == "voicebox":
        # XTTS-style — needs ~6-8 GB VRAM for real-time synthesis.
        return "gpu_small", 8
    if provider == "ollama":
        # Sized later by /api/models from the actual model name (param count).
        return "gpu_small", 12
    return "none", None

