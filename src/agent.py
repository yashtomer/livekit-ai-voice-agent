import logging
from pathlib import Path

import httpx
from dotenv import load_dotenv
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
from livekit.agents.voice.turn import EndpointingOptions, InterruptionOptions, TurnHandlingOptions
from livekit.plugins import openai, silero
from livekit.plugins.turn_detector.english import EnglishModel
from livekit import rtc

load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")

logger = logging.getLogger("voice-agent")

OLLAMA_BASE_URL = "http://localhost:11434/v1"
OLLAMA_NATIVE_URL = "http://localhost:11434"
WHISPER_BASE_URL = "http://localhost:8100/v1"
TTS_BASE_URL = "http://localhost:8200/v1"

LLM_MODEL = "gemma4:e2b"
STT_MODEL = "Systran/faster-whisper-base.en"
TTS_MODEL = "tts-1"
TTS_VOICE = "alloy"

LLM_KEEP_ALIVE = "30m"
LLM_MAX_TOKENS = 150


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


class VoiceAgent(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are a friendly voice assistant. "
                "Reply in one or two short sentences, plain spoken English, no markdown."
            ),
        )


async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    agent = VoiceAgent()
    session = AgentSession(
        stt=VadFilteredSTT(
            model=STT_MODEL,
            base_url=WHISPER_BASE_URL,
            api_key="local",
            language="en",
        ),
        llm=openai.LLM(
            model=LLM_MODEL,
            base_url=OLLAMA_BASE_URL,
            api_key="ollama",
            temperature=0.6,
            max_completion_tokens=LLM_MAX_TOKENS,
            extra_body={"keep_alive": LLM_KEEP_ALIVE},
            timeout=httpx.Timeout(connect=5, read=60, write=5, pool=5),
        ),
        tts=openai.TTS(
            model=TTS_MODEL,
            voice=TTS_VOICE,
            base_url=TTS_BASE_URL,
            api_key="local",
        ),
        vad=ctx.proc.userdata["vad"],
        turn_handling=TurnHandlingOptions(
            turn_detection=EnglishModel(),
            endpointing=EndpointingOptions(mode="dynamic", min_delay=0.2, max_delay=3.0),
            interruption=InterruptionOptions(min_words=3, min_duration=0.6),
        ),
        preemptive_generation=True,
    )

    await session.start(agent=agent, room=ctx.room)

    await session.generate_reply(
        instructions="Greet the user briefly and ask how you can help."
    )


def prewarm(proc: JobProcess):
    load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env", override=True)

    proc.userdata["vad"] = silero.VAD.load(
        activation_threshold=0.7,
        min_speech_duration=0.25,
        min_silence_duration=0.55,
    )

    try:
        httpx.post(
            f"{OLLAMA_NATIVE_URL}/api/generate",
            json={"model": LLM_MODEL, "prompt": "hi", "keep_alive": LLM_KEEP_ALIVE, "stream": False,
                  "options": {"num_predict": 1}},
            timeout=60.0,
        )
        logger.info("ollama model warmed")
    except Exception as e:
        logger.warning(f"ollama warmup failed: {e}")

    try:
        httpx.post(
            f"{TTS_BASE_URL}/audio/speech",
            headers={"Authorization": "Bearer local"},
            json={"model": TTS_MODEL, "voice": TTS_VOICE, "input": "."},
            timeout=30.0,
        )
        logger.info("tts warmed")
    except Exception as e:
        logger.warning(f"tts warmup failed: {e}")


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
        ),
    )
