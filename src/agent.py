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
    llm,
)
from livekit.plugins import openai, silero

load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")

logger = logging.getLogger("voice-agent")

# Local service endpoints
OLLAMA_BASE_URL = "http://localhost:11434/v1"
WHISPER_BASE_URL = "http://localhost:8100/v1"
TTS_BASE_URL = "http://localhost:8200/v1"


class VoiceAgent(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are a friendly and helpful voice assistant. "
                "You engage in natural conversations with users. "
                "Keep your responses concise and conversational since this is a voice interface. "
                "Avoid using markdown formatting, bullet points, or special characters. "
                "Speak naturally as if having a real conversation."
            ),
        )


async def entrypoint(ctx: JobContext):
    """Main entrypoint for the voice agent."""
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    agent = VoiceAgent()
    session = AgentSession(
        stt=openai.STT(
            model="Systran/faster-whisper-base.en",
            base_url=WHISPER_BASE_URL,
            api_key="local",
        ),
        llm=openai.LLM(
            model="gemma4:e2b",
            base_url=OLLAMA_BASE_URL,
            api_key="ollama",
            timeout=httpx.Timeout(connect=10, read=60, write=10, pool=10),
        ),
        tts=openai.TTS(
            model="tts-1",
            voice="alloy",
            base_url=TTS_BASE_URL,
            api_key="local",
        ),
        vad=ctx.proc.userdata["vad"],
    )

    await session.start(agent=agent, room=ctx.room)

    await session.generate_reply(
        instructions="Greet the user warmly and ask how you can help them today."
    )


def prewarm(proc: JobProcess):
    """Pre-load the Silero VAD model and env vars in the subprocess."""
    load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env", override=True)
    proc.userdata["vad"] = silero.VAD.load()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
        ),
    )
