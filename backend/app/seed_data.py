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


# ─── Use-case descriptions ────────────────────────────────────────────────
# Keyed by (provider, model_id). Used by the seed script and admin UI.
USE_CASES: dict[tuple[str, str], str] = {
    # STT
    ("whisper_local", "tiny"):
        "Fastest local English transcription. Best for real-time EN-only voice agents on CPU, "
        "privacy-sensitive deployments, and zero API cost.",
    ("whisper_local", "base"):
        "Balanced local English STT. Good accuracy-speed tradeoff on CPU. "
        "Ideal for EN-only agents that need offline privacy without sacrificing quality.",
    ("whisper_local", "small"):
        "Most accurate local English transcription. Recommended for quality-conscious offline "
        "deployments where transcript correctness matters more than speed.",
    ("whisper_local", "base-multi"):
        "Multilingual local STT (99 languages). Best for non-English voice agents that require "
        "offline privacy and zero API cost.",
    ("whisper_local", "small-multi"):
        "Highest-accuracy local multilingual STT. Use when transcript quality is critical and "
        "the deployment must be fully offline or air-gapped.",
    ("deepgram", "nova-3-general"):
        "Production real-time STT with ultra-low latency (~150ms, 36+ languages). Best choice "
        "for live voice agents where transcript speed directly drives AI response time.",
    ("deepgram", "nova-2-general"):
        "Proven reliable real-time STT (36 languages, ~200ms). Great cost-optimised alternative "
        "to Nova-3 for stable production voice agents.",
    ("groq", "whisper-large-v3-turbo"):
        "Fast cloud Whisper via Groq hardware (99 languages, ~300ms). Ideal for multilingual "
        "voice agents that need cloud speed without running a local GPU.",
    ("groq", "whisper-large-v3"):
        "Highest-accuracy cloud STT via Groq (99 languages, ~500ms). Best when transcript "
        "quality is critical and slight extra latency is acceptable.",
    ("openai", "whisper-1"):
        "Stable OpenAI Whisper API (57 languages, ~800ms). Good for non-latency-critical "
        "transcription, batch processing, and as a reliable production fallback.",
    # LLM
    ("groq", "meta-llama/llama-4-scout-17b-16e-instruct"):
        "Ultra-fast lightweight LLM (TTFT ~200ms, 12 languages, 10M ctx). Best for simple FAQ "
        "bots, triage agents, and high-volume cost-sensitive deployments.",
    ("groq", "llama-3.3-70b-versatile"):
        "Smart general-purpose LLM (TTFT ~500ms, 8 languages, 128K ctx). Excellent for customer "
        "support, complex Q&A, and nuanced multi-turn voice conversations.",
    ("groq", "llama-3.1-8b-instant"):
        "Fastest Groq LLM (TTFT ~200ms, 128K ctx). Best for latency-critical agents where "
        "response speed matters more than reasoning depth.",
    ("groq", "qwen/qwen3-32b"):
        "Multilingual LLM supporting 29 languages (TTFT ~300ms, 32K ctx). Best choice for "
        "non-English voice agents and global customer support deployments.",
    ("openai", "gpt-4.1"):
        "OpenAI's latest flagship (TTFT ~500ms, 100+ languages, 1M ctx). Best for complex "
        "reasoning, document-grounded agents, and premium customer-facing deployments.",
    ("openai", "gpt-4.1-mini"):
        "Cost-efficient GPT-4.1 variant (TTFT ~300ms, 1M ctx). Great balance of quality and "
        "cost for everyday voice agent tasks and mid-tier production deployments.",
    ("openai", "gpt-4o"):
        "Multimodal OpenAI model (TTFT ~600ms, 128K ctx). Use when strong reasoning and "
        "excellent instruction-following are needed for complex voice interactions.",
    ("openai", "gpt-4o-mini"):
        "Most cost-efficient OpenAI model (TTFT ~400ms, 128K ctx). Ideal for high-volume simple "
        "agents, intent classification, and summary-style interactions.",
    ("google", "gemini-2.5-flash"):
        "Google's latest fast model (TTFT ~300ms, 100+ languages, 1M ctx). Excellent for "
        "multilingual agents, structured data extraction, and long-document Q&A.",
    ("google", "gemini-2.0-flash"):
        "Reliable Google model (TTFT ~300ms, 1M ctx). Strong all-rounder for production voice "
        "agents that benefit from Google's ecosystem and reliability.",
    ("google", "gemini-1.5-flash"):
        "Stable long-context Google model (TTFT ~300ms, 1M ctx). Good for well-tested production "
        "deployments where proven consistency matters.",
    ("anthropic", "claude-haiku-4-5-20251001"):
        "Fast Claude model (TTFT ~400ms, 200K ctx). Best for safety-conscious deployments "
        "needing quick responses with Anthropic's built-in guardrails.",
    ("anthropic", "claude-sonnet-4-6"):
        "Premium Claude model (TTFT ~500ms, 200K ctx). Ideal for nuanced conversations, "
        "policy-compliant agents, and complex multi-turn voice dialogues.",
    ("anthropic", "claude-opus-4-7"):
        "Most capable Claude model (TTFT ~1s, 200K ctx). Use for the most demanding reasoning "
        "tasks where output quality is more important than cost.",
    ("deepseek", "deepseek-chat"):
        "Cost-effective LLM with strong EN/ZH support (TTFT ~500ms, 128K ctx). Great for "
        "technical support agents, code-related queries, and Chinese-language deployments.",
    # TTS
    ("elevenlabs", "eleven_flash_v2_5:Rachel"):
        "Premium calm female voice (American English, ~75ms). Best for customer-facing agents "
        "where voice naturalness is a key differentiator.",
    ("elevenlabs", "eleven_flash_v2_5:Sarah"):
        "Premium confident female voice (American English, ~75ms). Ideal for professional "
        "assistants, sales agents, and brand-forward deployments.",
    ("elevenlabs", "eleven_flash_v2_5:Adam"):
        "Premium deep male voice (American English, ~75ms). Best for authoritative agents such "
        "as financial advisors, technical support, or executive assistants.",
    ("elevenlabs", "eleven_flash_v2_5:George"):
        "Premium warm male voice (British English, ~75ms). Ideal for conversational agents "
        "targeting UK audiences or premium brand positioning.",
    ("openai", "tts-1:alloy"):
        "Neutral OpenAI voice (~500ms). Good default for general-purpose agents where "
        "reliability and consistency matter more than voice character.",
    ("openai", "tts-1:nova"):
        "Warm female OpenAI voice (~500ms). Best for friendly customer service agents, "
        "virtual assistants, and approachable brand experiences.",
    ("openai", "tts-1:shimmer"):
        "Gentle female OpenAI voice (~500ms). Ideal for wellness, mental health support, "
        "or any soft-spoken assistant use case.",
    ("openai", "tts-1-hd:alloy"):
        "Studio-quality neutral OpenAI voice (~700ms). Use when audio quality is critical "
        "and the slight extra latency is acceptable.",
    ("azure", "en-US-AriaNeural"):
        "Natural conversational female voice (EN-US, ~200ms). Enterprise-grade TTS with "
        "Microsoft SLA — ideal for regulated industries and production IVR systems.",
    ("azure", "en-US-JennyNeural"):
        "Friendly assistant female voice (EN-US, ~200ms). Ideal for customer service, "
        "branded voice experiences, and Microsoft ecosystem deployments.",
    ("azure", "hi-IN-SwaraNeural"):
        "Natural expressive Hindi female voice (~200ms). Best for Indian-market voice agents "
        "and Hindi-language customer support with enterprise reliability.",
    ("azure", "hi-IN-MadhurNeural"):
        "Clear formal Hindi male voice (~200ms). Use for formal Indian-market deployments "
        "such as banking, government services, or enterprise IVR.",
    ("edge", "en-US-AriaNeural"):
        "Free Microsoft Aria voice (EN-US, ~300ms). Zero-cost TTS suitable for internal "
        "tools, demos, and cost-sensitive non-commercial deployments.",
    ("edge", "en-US-JennyNeural"):
        "Free Microsoft Jenny voice (EN-US, ~300ms). Good quality free TTS for prototyping "
        "and budget-conscious voice agent deployments.",
    ("edge", "en-US-GuyNeural"):
        "Free Microsoft Guy male voice (EN-US, ~300ms). Casual tone suitable for informal "
        "agents, internal tools, and demos without TTS cost.",
    ("edge", "en-US-BrianNeural"):
        "Free Microsoft Brian male voice (EN-US, ~300ms). Warm tone for informal customer "
        "interactions where TTS cost must be zero.",
    ("edge", "hi-IN-SwaraNeural"):
        "Free Hindi female voice (~1.5s). Best zero-cost option for Hindi-language voice "
        "agents and cost-sensitive Indian-market deployments.",
    ("edge", "hi-IN-MadhurNeural"):
        "Free Hindi male voice (~1.5s). Use for formal Hindi agents where TTS cost must "
        "be zero, accepting the higher latency tradeoff.",
    ("groq", "canopylabs/orpheus-v1-english:autumn"):
        "Expressive natural female TTS via Groq (~300ms). Great for engaging customer-facing "
        "agents where emotional warmth improves user experience.",
    ("groq", "canopylabs/orpheus-v1-english:diana"):
        "Professional clear female TTS via Groq (~300ms). Ideal for corporate agents, "
        "formal support, and clarity-first voice experiences.",
    ("groq", "canopylabs/orpheus-v1-english:austin"):
        "Confident male TTS via Groq (~300ms). Best for authoritative agents such as sales, "
        "technical support, or coaching assistants.",
    ("piper_local", "alloy"):
        "Free fully-local TTS, no internet required (~2.4s). Best for offline deployments, "
        "privacy-first agents, and zero-cost voice synthesis.",
    ("piper_local", "nova"):
        "Free local nova voice (~2.4s). Use for offline agents needing a distinct voice "
        "character without any API cost or internet dependency.",
    ("piper_local", "echo"):
        "Free local echo voice (~2.4s). Suitable for internal tools and demos running "
        "fully offline with no cloud dependency.",
    ("piper_local", "shimmer"):
        "Free local shimmer voice (~2.4s). Good for privacy-first offline voice agents "
        "that need a softer tone at zero cost.",
}


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

