import logging

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
from livekit.plugins import anthropic, openai, silero

load_dotenv()

logger = logging.getLogger("voice-agent")


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
        stt=openai.STT(model="gpt-4o-transcribe"),
        llm=anthropic.LLM(model="claude-sonnet-4-20250514"),
        tts=openai.TTS(model="gpt-4o-mini-tts", voice="ash"),
        vad=ctx.proc.userdata["vad"],
    )

    await session.start(agent=agent, room=ctx.room)

    await session.generate_reply(
        instructions="Greet the user warmly and ask how you can help them today."
    )


def prewarm(proc: JobProcess):
    """Pre-load the Silero VAD model to avoid reloading on every session."""
    proc.userdata["vad"] = silero.VAD.load()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
        ),
    )
