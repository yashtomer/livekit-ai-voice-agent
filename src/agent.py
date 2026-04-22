import asyncio
import json
import logging
import os
import threading
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    JobProcess,
    WorkerOptions,
    cli,
)
from livekit.agents import stt as stt_base
from livekit.agents import tts as tts_base
from livekit.agents import llm as llm_base
from livekit.agents._exceptions import APIStatusError, APITimeoutError, APIConnectionError
from livekit.agents.voice.turn import EndpointingOptions, InterruptionOptions, TurnHandlingOptions
from livekit.plugins import openai, silero
from livekit.plugins.turn_detector.english import EnglishModel
from livekit.plugins.turn_detector.multilingual import MultilingualModel

load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")

logger = logging.getLogger("voice-agent")

# ─── Infra endpoints ───
# Every URL below has an env-var override so the same code runs natively
# (defaults to localhost ports) AND inside Docker where services reach each
# other by compose service name (e.g. ``http://whisper-base:8000/v1``).
# See docker-compose.yml for the Docker-internal values.
OLLAMA_NATIVE_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_BASE_URL = f"{OLLAMA_NATIVE_URL.rstrip('/')}/v1"
TTS_BASE_URL = os.environ.get("TTS_BASE_URL", "http://localhost:8200/v1")

# Whisper containers — one per model size.
# The `.en` models are English-only and ~30% faster on CPU. The "-multi"
# variants use the multilingual Whisper and are required for any non-English
# language (Hindi, Spanish, Japanese, Mandarin, …). build_stt() picks the
# multilingual container whenever cfg.language != "en".
WHISPER_URLS = {
    "tiny":        os.environ.get("WHISPER_TINY_URL",        "http://localhost:8102/v1"),
    "base":        os.environ.get("WHISPER_BASE_URL",        "http://localhost:8100/v1"),
    "small":       os.environ.get("WHISPER_SMALL_URL",       "http://localhost:8101/v1"),
    "base-multi":  os.environ.get("WHISPER_BASE_MULTI_URL",  "http://localhost:8103/v1"),
    "small-multi": os.environ.get("WHISPER_SMALL_MULTI_URL", "http://localhost:8104/v1"),
}
WHISPER_MODEL_NAMES = {
    "tiny":        "Systran/faster-whisper-tiny.en",
    "base":        "Systran/faster-whisper-base.en",
    "small":       "Systran/faster-whisper-small.en",
    "base-multi":  "Systran/faster-whisper-base",
    "small-multi": "Systran/faster-whisper-small",
}
# Sizes for non-English languages (English-only models can't transcribe them)
WHISPER_MULTILINGUAL_SIZES = {"base-multi", "small-multi"}

# LLM behavior constants
LLM_KEEP_ALIVE = "30m"
LLM_MAX_TOKENS = 150

# Default config used when metadata missing/malformed
DEFAULT_CONFIG = {
    "stt": {"provider": "whisper_local", "size": "base"},
    "llm": {"provider": "ollama", "model": "gemma4:e2b"},
    "tts": {"provider": "piper_local", "voice": "alloy"},
}


class VadFilteredSTT(openai.STT):
    async def _recognize_impl(self, buffer, *, language=None, conn_options=None):
        data = rtc.combine_audio_frames(buffer).to_wav_bytes()
        resp = await self._client.audio.transcriptions.create(
            file=("file.wav", data, "audio/wav"),
            model=self._opts.model,
            language=self._opts.language.language if self._opts.language else "en",
            response_format="json",
            extra_body={"vad_filter": True},
            timeout=httpx.Timeout(30, connect=conn_options.timeout if conn_options else 10),
        )
        return stt_base.SpeechEvent(
            type=stt_base.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives=[stt_base.SpeechData(text=resp.text, language=self._opts.language)],
        )


class EdgeTTS(tts_base.TTS):
    """Free Microsoft Edge TTS — no API key needed."""

    def __init__(self, *, voice: str = "en-US-AriaNeural"):
        super().__init__(
            capabilities=tts_base.TTSCapabilities(streaming=False),
            sample_rate=24000,
            num_channels=1,
        )
        self._voice = voice

    def synthesize(self, text: str, *, conn_options=None) -> "EdgeTTSStream":
        return EdgeTTSStream(tts=self, input_text=text, conn_options=conn_options)


class EdgeTTSStream(tts_base.ChunkedStream):
    def __init__(self, *, tts: EdgeTTS, input_text: str, conn_options):
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._edge_tts = tts

    async def _run(self, output_emitter: tts_base.AudioEmitter) -> None:
        import edge_tts

        # Stream chunks straight from Microsoft's service into the emitter
        # as they arrive, instead of buffering the whole utterance first.
        # Drops time-to-first-byte by the full synthesis duration (≈ 1-2 s
        # on Hindi, even more on long English sentences).
        try:
            communicate = edge_tts.Communicate(self.input_text, self._edge_tts._voice)
            initialized = False
            async for chunk in communicate.stream():
                if chunk["type"] != "audio":
                    continue
                data = chunk.get("data")
                if not data:
                    continue
                if not initialized:
                    output_emitter.initialize(
                        request_id="",
                        sample_rate=24000,
                        num_channels=1,
                        mime_type="audio/mpeg",
                    )
                    initialized = True
                output_emitter.push(data)

            if not initialized:
                # No audio came back — shouldn't happen, but surface it
                raise APIConnectionError(message="Edge TTS returned no audio chunks")
            output_emitter.flush()

        except Exception as e:
            raise APIConnectionError() from e


class GroqTTS(tts_base.TTS):
    """Custom TTS for Groq API — uses Orpheus model (wav format only)."""

    def __init__(self, *, model: str = "canopylabs/orpheus-v1-english", voice: str = "autumn", api_key: str):
        super().__init__(
            capabilities=tts_base.TTSCapabilities(streaming=False),
            sample_rate=24000,
            num_channels=1,
        )
        self._model = model
        self._voice = voice
        self._client = httpx.AsyncClient(
            base_url="https://api.groq.com/openai/v1",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=httpx.Timeout(30.0),
        )

    def synthesize(self, text: str, *, conn_options=None) -> "GroqTTSStream":
        return GroqTTSStream(tts=self, input_text=text, conn_options=conn_options)


class GroqTTSStream(tts_base.ChunkedStream):
    def __init__(self, *, tts: GroqTTS, input_text: str, conn_options):
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._groq_tts = tts

    async def _run(self, output_emitter: tts_base.AudioEmitter) -> None:
        import wave
        import io

        try:
            resp = await self._groq_tts._client.post(
                "/audio/speech",
                json={
                    "model": self._groq_tts._model,
                    "voice": self._groq_tts._voice,
                    "input": self.input_text,
                    "response_format": "wav",
                },
            )
            resp.raise_for_status()

            # Parse WAV to extract raw PCM and sample rate
            wav_buf = io.BytesIO(resp.content)
            with wave.open(wav_buf, "rb") as wf:
                sample_rate = wf.getframerate()
                num_channels = wf.getnchannels()
                pcm_data = wf.readframes(wf.getnframes())

            output_emitter.initialize(
                request_id=resp.headers.get("x-request-id", ""),
                sample_rate=sample_rate,
                num_channels=num_channels,
                mime_type="audio/raw",
            )
            output_emitter.push(pcm_data)
            output_emitter.flush()

        except httpx.TimeoutException:
            raise APITimeoutError() from None
        except httpx.HTTPStatusError as e:
            raise APIStatusError(
                str(e), status_code=e.response.status_code, request_id="", body=e.response.text
            ) from None
        except Exception as e:
            raise APIConnectionError() from e


class ElevenLabsTTS(tts_base.TTS):
    """ElevenLabs TTS via their REST API. Supports all standard ElevenLabs
    models (eleven_flash_v2_5, eleven_multilingual_v2, eleven_turbo_v2_5)
    and any voice ID from the user's ElevenLabs voice library."""

    def __init__(
        self,
        *,
        voice_id: str = "21m00Tcm4TlvDq8ikWAM",   # Rachel — default popular voice
        model: str = "eleven_flash_v2_5",          # fastest model, ~75ms TTFB
        api_key: str,
        stability: float = 0.5,
        similarity_boost: float = 0.75,
    ):
        super().__init__(
            capabilities=tts_base.TTSCapabilities(streaming=False),
            sample_rate=44100,
            num_channels=1,
        )
        self._voice_id = voice_id
        self._model = model
        self._stability = stability
        self._similarity_boost = similarity_boost
        self._client = httpx.AsyncClient(
            base_url="https://api.elevenlabs.io/v1",
            headers={"xi-api-key": api_key, "accept": "audio/mpeg"},
            timeout=httpx.Timeout(30.0),
        )

    def synthesize(self, text: str, *, conn_options=None) -> "ElevenLabsTTSStream":
        return ElevenLabsTTSStream(tts=self, input_text=text, conn_options=conn_options)


class ElevenLabsTTSStream(tts_base.ChunkedStream):
    def __init__(self, *, tts: ElevenLabsTTS, input_text: str, conn_options):
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._el_tts = tts

    async def _run(self, output_emitter: tts_base.AudioEmitter) -> None:
        try:
            resp = await self._el_tts._client.post(
                f"/text-to-speech/{self._el_tts._voice_id}",
                json={
                    "text": self.input_text,
                    "model_id": self._el_tts._model,
                    "voice_settings": {
                        "stability": self._el_tts._stability,
                        "similarity_boost": self._el_tts._similarity_boost,
                    },
                },
            )
            resp.raise_for_status()

            output_emitter.initialize(
                request_id=resp.headers.get("x-request-id", ""),
                sample_rate=44100,
                num_channels=1,
                mime_type="audio/mpeg",
            )
            output_emitter.push(resp.content)
            output_emitter.flush()

        except httpx.TimeoutException:
            raise APITimeoutError() from None
        except httpx.HTTPStatusError as e:
            raise APIStatusError(
                str(e), status_code=e.response.status_code, request_id="", body=e.response.text
            ) from None
        except Exception as e:
            raise APIConnectionError() from e


class VoiceboxTTS(tts_base.TTS):
    """Voicebox (https://voicebox.sh) TTS via its REST API. Voicebox is a
    free, open-source, local-first ElevenLabs alternative with voice cloning.

    The Voicebox desktop app exposes a REST server on http://localhost:17493
    by default (override with VOICEBOX_URL). Each "profile" in Voicebox maps
    to one of its built-in voices, cloned voices, or preset voices.

    Voicebox's /generate is async: it returns a generation_id immediately,
    then audio becomes available at /audio/{id} once the task finishes.
    We poll the audio endpoint with a short interval until it's ready.
    """

    def __init__(
        self,
        *,
        profile_id: str,
        engine: str = "kokoro",          # fastest CPU engine — ~0.5-1s on Intel Mac
        language: str = "en",
        base_url: str = "http://localhost:17493",
        poll_interval: float = 0.25,     # seconds between /audio/{id} polls
        max_wait: float = 30.0,          # give up after this many seconds
    ):
        super().__init__(
            capabilities=tts_base.TTSCapabilities(streaming=False),
            sample_rate=24000,   # Voicebox default; adjustable per engine
            num_channels=1,
        )
        self._profile_id = profile_id
        self._engine = engine
        self._language = language
        self._poll_interval = poll_interval
        self._max_wait = max_wait
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(max_wait + 10.0),
        )

    def synthesize(self, text: str, *, conn_options=None) -> "VoiceboxTTSStream":
        return VoiceboxTTSStream(tts=self, input_text=text, conn_options=conn_options)


class VoiceboxTTSStream(tts_base.ChunkedStream):
    def __init__(self, *, tts: VoiceboxTTS, input_text: str, conn_options):
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._vb_tts = tts

    async def _run(self, output_emitter: tts_base.AudioEmitter) -> None:
        # One-shot request against /generate/stream — the server holds the
        # connection open for the full inference duration and returns the
        # WAV when ready. This replaces the older 3-step flow (POST /generate
        # → SSE /status → GET /audio/{id}), which added ~1s of overhead per
        # utterance with no benefit: Kokoro generates the full buffer before
        # returning, it doesn't chunk progressively. If a future engine adds
        # true progressive streaming, this single call will naturally stream
        # chunks to the emitter without any code change.
        try:
            request_id = ""
            initialized = False
            async with self._vb_tts._client.stream(
                "POST",
                "/generate/stream",
                json={
                    "profile_id": self._vb_tts._profile_id,
                    "text": self.input_text,
                    "language": self._vb_tts._language,
                    "engine": self._vb_tts._engine,
                    "normalize": True,
                },
            ) as resp:
                # Manual status-code check BEFORE consuming the stream body.
                # Calling resp.raise_for_status() here would fail inside the
                # stream context, and the subsequent attempt to read
                # e.response.text would crash with httpx.ResponseNotRead —
                # masking the actual error message from Voicebox. Reading
                # the body first lets us propagate a useful diagnostic
                # (e.g. "kokoro model is not downloaded yet").
                if resp.status_code >= 400:
                    body_bytes = await resp.aread()
                    try:
                        detail = body_bytes.decode("utf-8", errors="replace")[:500]
                    except Exception:
                        detail = f"<{len(body_bytes)} bytes>"
                    raise APIStatusError(
                        f"Voicebox {resp.status_code}: {detail}",
                        status_code=resp.status_code,
                        request_id="",
                        body=detail,
                    )

                # Voicebox sets a generation-id header we can reuse as request_id
                request_id = (
                    resp.headers.get("x-generation-id")
                    or resp.headers.get("x-request-id")
                    or ""
                )
                mime = resp.headers.get("content-type", "audio/wav").split(";")[0].strip()
                async for chunk in resp.aiter_bytes():
                    if not chunk:
                        continue
                    if not initialized:
                        output_emitter.initialize(
                            request_id=request_id,
                            sample_rate=self._vb_tts.sample_rate,
                            num_channels=self._vb_tts.num_channels,
                            mime_type=mime,
                        )
                        initialized = True
                    output_emitter.push(chunk)

            if initialized:
                output_emitter.flush()
            else:
                raise APIConnectionError(message="Voicebox returned empty stream")

        except APIStatusError:
            raise  # Already well-formed, don't double-wrap
        except httpx.TimeoutException:
            raise APITimeoutError() from None
        except Exception as e:
            raise APIConnectionError(message=f"Voicebox TTS failed: {e}") from e


# System prompts per language. Each one tells the model:
#  - behavior (friendly voice assistant)
#  - format (1-2 short sentences, no markdown, spoken style)
#  - WHICH SCRIPT/LANGUAGE to respond in — critical so Hindi replies come
#    back in Devanagari rather than transliterated English, otherwise TTS
#    pronounces the transliteration instead of the actual Hindi words.
LANGUAGE_PROMPTS = {
    "en": (
        "You are a friendly voice assistant. "
        "Reply in one or two short sentences, plain spoken English, no markdown."
    ),
    "hi": (
        "आप एक दोस्ताना आवाज़ सहायक हैं। "
        "सिर्फ़ हिंदी में, देवनागरी लिपि में उत्तर दें — अंग्रेज़ी शब्द या रोमन लिपि का इस्तेमाल न करें। "
        "एक या दो छोटे वाक्यों में, बोलचाल की भाषा में जवाब दें। कोई मार्कडाउन नहीं। "
        # The user's speech is transcribed by Whisper, which sometimes emits
        # Hindi in Perso-Arabic (Urdu) script when the base model is used.
        # Treat both scripts as the SAME language and respond in Devanagari.
        "नोट: उपयोगकर्ता के शब्द कभी-कभी उर्दू लिपि में लिखे मिल सकते हैं (जैसे 'نمستی'); "
        "इन्हें हिंदी के बराबर समझें और देवनागरी में जवाब दें।"
    ),
    "es": (
        "Eres un asistente de voz amigable. "
        "Responde solo en español, en una o dos frases cortas, estilo hablado, sin markdown."
    ),
    "fr": (
        "Tu es un assistant vocal amical. "
        "Réponds uniquement en français, en une ou deux phrases courtes, style oral, sans markdown."
    ),
    "it": (
        "Sei un assistente vocale amichevole. "
        "Rispondi solo in italiano, in una o due frasi brevi, stile parlato, senza markdown."
    ),
    "pt": (
        "Você é um assistente de voz amigável. "
        "Responda apenas em português, em uma ou duas frases curtas, estilo falado, sem markdown."
    ),
    "ja": (
        "あなたは親しみやすい音声アシスタントです。"
        "日本語のみで、1〜2文の短い話し言葉で答えてください。マークダウンは使わないでください。"
    ),
    "zh": (
        "你是一个友好的语音助手。"
        "请只用中文回答，用一两句口语化的短句回复，不要使用Markdown。"
    ),
}


def system_prompt_for(language: str) -> str:
    """Pick the right system prompt for the session language. Falls back to
    a generic template for any language we don't have a hand-tuned prompt for."""
    if language in LANGUAGE_PROMPTS:
        return LANGUAGE_PROMPTS[language]
    return (
        f"You are a friendly voice assistant. Reply ONLY in {language} "
        "(use its native script, not transliteration). Reply in one or two "
        "short sentences, spoken style, no markdown."
    )


class VoiceAgent(Agent):
    def __init__(self, language: str = "en") -> None:
        super().__init__(instructions=system_prompt_for(language))


# ─── Factories ───

def build_stt(cfg: dict, language: str = "en"):
    """Build an STT instance from config dict.

    ``language`` is the ISO-639-1 code of the conversation language. It comes
    from the session config (derived from the TTS voice's language) and is
    threaded into Whisper so the model decodes the right phoneme set. For
    English-only Whisper (`base`, `small`, `tiny`), a non-English language
    forces a silent upgrade to the multilingual variant.
    """
    provider = cfg.get("provider", "whisper_local")

    if provider == "whisper_local":
        size = cfg.get("size", "base")
        # If the user picked an English-only model but the session language
        # is not English, transparently upgrade to the multilingual variant.
        if language != "en" and size in ("base", "small") and size not in WHISPER_MULTILINGUAL_SIZES:
            upgraded = f"{size}-multi"
            logger.info(f"Non-English language '{language}' — upgrading Whisper {size} → {upgraded}")
            size = upgraded
        elif language != "en" and size == "tiny":
            # No multilingual `tiny-multi` shipped — force base-multi instead
            logger.info(f"Non-English language '{language}' — upgrading Whisper tiny → base-multi (no tiny-multi)")
            size = "base-multi"

        # Hindi note: the `base` multilingual model is too small to reliably
        # distinguish Hindi from Urdu and often emits Perso-Arabic script
        # (e.g. "नमस्ते" → "نمستی") even when the language hint is "hi".
        # The LLM understands both scripts as Hindi thanks to the updated
        # system prompt, so we no longer force-upgrade to small-multi.
        # Users who want Devanagari in the transcript should pick
        # `small-multi` themselves — it's 3× slower but script-correct.
        if size not in WHISPER_URLS:
            raise ValueError(f"unknown whisper size: {size}")
        return VadFilteredSTT(
            model=WHISPER_MODEL_NAMES[size],
            base_url=WHISPER_URLS[size],
            api_key="local",
            language=language,
        )

    if provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY not set in .env")
        model = cfg.get("model", "whisper-large-v3-turbo")
        return openai.STT(
            model=model,
            base_url="https://api.groq.com/openai/v1",
            api_key=api_key,
            language=language,
        )

    if provider == "openai":
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY not set in .env")
        return openai.STT(
            model=cfg.get("model", "whisper-1"),
            api_key=api_key,
            language=language,
        )

    if provider == "deepgram":
        try:
            from livekit.plugins import deepgram as deepgram_plugin
        except ImportError:
            raise RuntimeError(
                "livekit-plugins-deepgram not installed. Run `uv sync --extra cloud`."
            )
        api_key = os.environ.get("DEEPGRAM_API_KEY")
        if not api_key:
            raise RuntimeError("DEEPGRAM_API_KEY not set in .env")
        # Deepgram uses "hi" for Hindi, "es" for Spanish — matches our code
        return deepgram_plugin.STT(
            model=cfg.get("model", "nova-3-general"),
            language=language,
            api_key=api_key,
        )

    raise ValueError(f"unknown stt provider: {provider}")


def build_llm(cfg: dict):
    """Build an LLM instance from config dict."""
    provider = cfg.get("provider", "ollama")
    model = cfg.get("model", "gemma4:e2b")

    if provider == "ollama":
        return openai.LLM(
            model=model,
            base_url=OLLAMA_BASE_URL,
            api_key="ollama",
            temperature=0.6,
            max_completion_tokens=LLM_MAX_TOKENS,
            extra_body={"keep_alive": LLM_KEEP_ALIVE},
            timeout=httpx.Timeout(connect=5, read=60, write=5, pool=5),
        )

    if provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY not set in .env")
        return openai.LLM(
            model=model,
            base_url="https://api.groq.com/openai/v1",
            api_key=api_key,
            temperature=0.6,
            max_completion_tokens=LLM_MAX_TOKENS,
        )

    if provider == "anthropic":
        try:
            from livekit.plugins import anthropic as anthropic_plugin
        except ImportError:
            raise RuntimeError(
                "livekit-plugins-anthropic not installed. Run `uv sync --extra cloud`."
            )
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY not set in .env")
        return anthropic_plugin.LLM(model=model, api_key=api_key)

    if provider == "openai":
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY not set in .env")
        return openai.LLM(
            model=model,
            api_key=api_key,
            temperature=0.6,
            max_completion_tokens=LLM_MAX_TOKENS,
        )

    if provider == "google":
        # Google Gemini via their OpenAI-compatible endpoint — no extra plugin needed.
        api_key = os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            raise RuntimeError("GOOGLE_API_KEY not set in .env")
        return openai.LLM(
            model=model,
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
            api_key=api_key,
            temperature=0.6,
            max_completion_tokens=LLM_MAX_TOKENS,
        )

    if provider == "deepseek":
        # DeepSeek is OpenAI-compatible.
        api_key = os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            raise RuntimeError("DEEPSEEK_API_KEY not set in .env")
        return openai.LLM(
            model=model,
            base_url="https://api.deepseek.com/v1",
            api_key=api_key,
            temperature=0.6,
            max_completion_tokens=LLM_MAX_TOKENS,
        )

    raise ValueError(f"unknown llm provider: {provider}")


def build_tts(cfg: dict):
    """Build a TTS instance from config dict."""
    provider = cfg.get("provider", "piper_local")

    if provider == "piper_local":
        voice = cfg.get("voice", "alloy")
        return openai.TTS(
            model="tts-1",
            voice=voice,
            base_url=TTS_BASE_URL,
            api_key="local",
        )

    if provider == "edge":
        voice = cfg.get("voice", "en-US-AriaNeural")
        return EdgeTTS(voice=voice)

    if provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY not set in .env")
        model = cfg.get("model", "canopylabs/orpheus-v1-english")
        voice = cfg.get("voice", "autumn")
        return GroqTTS(model=model, voice=voice, api_key=api_key)

    if provider == "elevenlabs":
        api_key = os.environ.get("ELEVENLABS_API_KEY")
        if not api_key:
            raise RuntimeError("ELEVENLABS_API_KEY not set in .env")
        return ElevenLabsTTS(
            voice_id=cfg.get("voice", "21m00Tcm4TlvDq8ikWAM"),
            model=cfg.get("model", "eleven_flash_v2_5"),
            api_key=api_key,
        )

    if provider == "openai":
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY not set in .env")
        return openai.TTS(
            model=cfg.get("model", "tts-1"),
            voice=cfg.get("voice", "alloy"),
            api_key=api_key,
        )

    if provider == "voicebox":
        # Local Voicebox server (https://voicebox.sh) — free ElevenLabs alternative.
        # profile_id is the Voicebox profile/voice identifier; voice field carries it.
        # engine picks which TTS model Voicebox uses (qwen/kokoro/luxtts/chatterbox/tada).
        base_url = os.environ.get("VOICEBOX_URL", "http://localhost:17493")
        profile_id = cfg.get("voice")
        if not profile_id:
            raise RuntimeError("voicebox TTS requires a profile_id (via cfg.voice)")
        return VoiceboxTTS(
            profile_id=profile_id,
            engine=cfg.get("model", "kokoro"),   # default to Kokoro for CPU speed
            language=cfg.get("language", "en"),
            base_url=base_url,
        )

    if provider == "azure":
        # Azure Cognitive Services Neural TTS — the official enterprise API.
        # Same voices as edge-tts (AriaNeural, SwaraNeural, etc.) but routed
        # via your Azure subscription's regional endpoint → ~3-5× faster TTFB,
        # true streaming, SLA-backed. Voice naming: "{lang}-{region}-{name}Neural"
        try:
            from livekit.plugins import azure as azure_plugin
        except ImportError:
            raise RuntimeError(
                "livekit-plugins-azure not installed. Run `uv sync --extra cloud`."
            )
        api_key = os.environ.get("AZURE_SPEECH_KEY")
        region = os.environ.get("AZURE_SPEECH_REGION", "eastus")
        if not api_key:
            raise RuntimeError("AZURE_SPEECH_KEY not set in .env")
        voice = cfg.get("voice", "en-US-AriaNeural")
        # Derive language-region tag from voice name. Examples:
        #   "en-US-AriaNeural"  → "en-US"
        #   "hi-IN-SwaraNeural" → "hi-IN"
        lang = "-".join(voice.split("-")[:2]) if voice.count("-") >= 2 else "en-US"
        return azure_plugin.TTS(
            voice=voice,
            language=lang,
            speech_key=api_key,
            speech_region=region,
        )

    raise ValueError(f"unknown tts provider: {provider}")


def _parse_config(metadata_str: str | None) -> dict:
    """Parse participant metadata JSON, falling back to defaults."""
    if not metadata_str:
        return DEFAULT_CONFIG
    try:
        incoming = json.loads(metadata_str)
    except json.JSONDecodeError:
        logger.warning("invalid metadata JSON, using defaults")
        return DEFAULT_CONFIG
    return {
        "stt": {**DEFAULT_CONFIG["stt"], **incoming.get("stt", {})},
        "llm": {**DEFAULT_CONFIG["llm"], **incoming.get("llm", {})},
        "tts": {**DEFAULT_CONFIG["tts"], **incoming.get("tts", {})},
    }


async def _send_to_browser(ctx: JobContext, data: dict):
    """Send a JSON message to all browser participants via data channel."""
    payload = json.dumps(data).encode()
    try:
        await ctx.room.local_participant.publish_data(payload, reliable=True)
    except Exception as e:
        logger.debug(f"Failed to send data to browser: {e}")


async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    # Wait for the browser participant so we can read their metadata
    participant = await ctx.wait_for_participant()
    cfg = _parse_config(participant.metadata)
    logger.info(f"Starting session with config: {cfg}")

    # ─── Derive conversation language ───
    # The TTS voice carries the authoritative language. For Voicebox profiles
    # this comes from the profile record; for ElevenLabs/OpenAI/Edge we look
    # at an explicit `language` override if the UI set one (else default "en").
    language = (cfg.get("tts") or {}).get("language") or cfg.get("language") or "en"
    logger.info(f"Session language: {language}")

    fallback_used = False
    error_detail = ""
    try:
        stt = build_stt(cfg["stt"], language=language)
        llm = build_llm(cfg["llm"])
        tts = build_tts(cfg["tts"])
    except Exception as e:
        error_detail = str(e)
        logger.error(f"Failed to build pipeline: {e}. Falling back to defaults.")
        fallback_used = True
        # Fallback forces English — the defaults (Piper EN + Whisper .en) can't
        # speak Hindi anyway, so degrading the language is the correct behaviour.
        language = "en"
        stt = build_stt(DEFAULT_CONFIG["stt"], language="en")
        llm = build_llm(DEFAULT_CONFIG["llm"])
        tts = build_tts(DEFAULT_CONFIG["tts"])

    # Notify browser if we had to fall back
    if fallback_used:
        await _send_to_browser(ctx, {
            "type": "error",
            "message": f"Pipeline error: {error_detail}. Fell back to local defaults (Whisper + Ollama + Piper).",
        })

    agent = VoiceAgent(language=language)

    # Turn-detector: use the English-only model for English (fastest, most
    # accurate), or the multilingual model for any other language. The
    # multilingual model is slightly larger/slower but understands when a
    # speaker has finished a thought in Hindi / Spanish / Japanese etc.
    turn_model = EnglishModel() if language == "en" else MultilingualModel()

    session = AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        vad=ctx.proc.userdata["vad"],
        turn_handling=TurnHandlingOptions(
            turn_detection=turn_model,
            endpointing=EndpointingOptions(mode="dynamic", min_delay=0.2, max_delay=3.0),
            interruption=InterruptionOptions(min_words=3, min_duration=0.6),
        ),
        preemptive_generation=True,
    )

    # ─── Real-time metrics via LiveKit's built-in metrics_collected event ───
    async def send_metrics_to_browser(data: dict):
        """Send timing metrics to browser participants via data channel."""
        payload = json.dumps({"type": "metrics", **data}).encode()
        try:
            await ctx.room.local_participant.publish_data(payload, reliable=True)
        except Exception as e:
            logger.debug(f"Failed to send metrics: {e}")

    @session.on("metrics_collected")
    def on_metrics(ev):
        m = ev.metrics
        if m.type == "stt_metrics":
            asyncio.ensure_future(send_metrics_to_browser({
                "stage": "stt",
                "duration_ms": round(m.duration * 1000),
                "audio_duration_ms": round(m.audio_duration * 1000),
            }))
        elif m.type == "llm_metrics":
            asyncio.ensure_future(send_metrics_to_browser({
                "stage": "llm",
                "duration_ms": round(m.duration * 1000),
                "ttft_ms": round(m.ttft * 1000),
                "tokens_per_second": round(m.tokens_per_second, 1),
                "total_tokens": m.total_tokens,
            }))
        elif m.type == "tts_metrics":
            asyncio.ensure_future(send_metrics_to_browser({
                "stage": "tts",
                "duration_ms": round(m.duration * 1000),
                "ttfb_ms": round(m.ttfb * 1000),
                "characters": m.characters_count,
            }))

    @session.on("error")
    def on_session_error(ev):
        raw = str(ev)
        logger.error(f"Session error: {raw}")

        # Extract a clean user-friendly message
        msg = "Unknown error"
        if "terms acceptance" in raw or "model_terms_required" in raw:
            msg = "Groq TTS failed: model requires terms acceptance. Accept at console.groq.com/playground, or switch to Microsoft Edge TTS (free)."
        elif "decommissioned" in raw:
            msg = "Model has been decommissioned by the provider. Please select a different model."
        elif "API key" in raw or "api_key" in raw or "401" in raw:
            msg = "Invalid or missing API key. Check your .env configuration."
        elif "tts_error" in raw or "TTSError" in raw:
            msg = "Text-to-Speech failed. Try switching to Microsoft Edge TTS (free) or Piper (local)."
        elif "stt_error" in raw or "STTError" in raw:
            msg = "Speech-to-Text failed. Try switching to a local Whisper model."
        elif "llm_error" in raw or "LLMError" in raw:
            msg = "Language Model failed. Try switching to a local Ollama model."
        elif "timeout" in raw.lower():
            msg = "Request timed out. The model may be too slow for your hardware."

        asyncio.ensure_future(_send_to_browser(ctx, {
            "type": "error",
            "message": msg,
        }))

    await session.start(agent=agent, room=ctx.room)

    await session.generate_reply(
        instructions="Greet the user briefly and ask how you can help."
    )


def _background_warmup():
    """Run Ollama + TTS warmup in a background thread so prewarm stays under LiveKit's 10s budget."""
    try:
        httpx.post(
            f"{OLLAMA_NATIVE_URL}/api/generate",
            json={
                "model": DEFAULT_CONFIG["llm"]["model"],
                "prompt": "hi",
                "keep_alive": LLM_KEEP_ALIVE,
                "stream": False,
                "options": {"num_predict": 1},
            },
            timeout=120.0,
        )
        logger.info("ollama model warmed")
    except Exception as e:
        logger.warning(f"ollama warmup failed: {e}")

    try:
        httpx.post(
            f"{TTS_BASE_URL}/audio/speech",
            headers={"Authorization": "Bearer local"},
            json={
                "model": "tts-1",
                "voice": DEFAULT_CONFIG["tts"]["voice"],
                "input": ".",
            },
            timeout=60.0,
        )
        logger.info("tts warmed")
    except Exception as e:
        logger.warning(f"tts warmup failed: {e}")

    # Pre-warm the multilingual Whisper (small-multi) so the first Hindi
    # utterance doesn't pay the model-load cost at session start.
    # Cold first-time load (model download + CT2 conversion) is up to ~90s;
    # subsequent warm loads are ~5s. 180s budget covers both.
    try:
        import io, wave
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 16000)  # 1s of silence
        httpx.post(
            f"{WHISPER_URLS['small-multi']}/audio/transcriptions",
            files={"file": ("warmup.wav", buf.getvalue(), "audio/wav")},
            data={
                "model": WHISPER_MODEL_NAMES["small-multi"],
                "language": "hi",
                "response_format": "json",
            },
            timeout=180.0,
        )
        logger.info("multilingual whisper (small-multi) warmed for Hindi")
    except Exception as e:
        logger.warning(f"multilingual whisper warmup failed: {e}")


def prewarm(proc: JobProcess):
    """Must complete under 10s — LiveKit kills the worker if initialize times out."""
    load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env", override=True)

    # VAD load is fast (~200ms), safe to block on
    proc.userdata["vad"] = silero.VAD.load(
        activation_threshold=0.7,
        min_speech_duration=0.25,
        min_silence_duration=0.55,
    )

    # Ollama + TTS warmup runs in background so we don't exceed the 10s budget
    threading.Thread(target=_background_warmup, daemon=True).start()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            # Keep one idle pre-warmed process ready at all times so the
            # first user to click Start Call doesn't pay the ~17s cold-start
            # cost (fork + Ollama load + TTS load). Additional concurrent
            # jobs still cold-start but the first is always fast.
            num_idle_processes=1,
        ),
    )
