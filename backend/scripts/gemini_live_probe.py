"""Probe which LiveConnectConfig fields the current GEMINI_LIVE_MODEL accepts.

Run inside the backend container:
    docker compose -f docker-compose-dev.yml exec backend \
        python scripts/gemini_live_probe.py
"""
import asyncio
import os

from google import genai
from google.genai import types

MODEL = os.environ.get("GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview")
API_VERSION = os.environ.get("GEMINI_API_VERSION", "v1alpha")

CONFIGS = {
    "1_bare": types.LiveConnectConfig(response_modalities=["AUDIO"]),
    "2_+voice": types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
            )
        ),
    ),
    "3_+in_trans": types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        input_audio_transcription=types.AudioTranscriptionConfig(),
    ),
    "4_+out_trans": types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        output_audio_transcription=types.AudioTranscriptionConfig(),
    ),
    "5_+vad": types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                silence_duration_ms=100,
            )
        ),
    ),
    "6_+sys_instruction": types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=types.Content(parts=[types.Part(text="Be brief.")]),
    ),
    "7_full_app_config": types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
            )
        ),
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                silence_duration_ms=100,
            )
        ),
        system_instruction=types.Content(parts=[types.Part(text="Be brief.")]),
    ),
}


async def probe_one(client, name, cfg):
    try:
        async with client.aio.live.connect(model=MODEL, config=cfg) as s:
            await s.send_realtime_input(
                audio=types.Blob(data=b"\x00" * 3200, mime_type="audio/pcm;rate=16000")
            )

            async def recv():
                async for _ in s.receive():
                    return "got response"
                return "no response"

            try:
                r = await asyncio.wait_for(recv(), timeout=4)
            except asyncio.TimeoutError:
                r = "timeout (still alive)"
            print(f"{name}: OK — {r}")
    except Exception as e:
        print(f"{name}: FAIL — {type(e).__name__}: {str(e)[:200]}")


async def main():
    print(f"MODEL       = {MODEL}")
    print(f"API_VERSION = {API_VERSION}")
    print("-" * 60)
    client = genai.Client(
        api_key=os.environ["GOOGLE_API_KEY"],
        http_options={"api_version": API_VERSION},
    )
    for name, cfg in CONFIGS.items():
        await probe_one(client, name, cfg)


if __name__ == "__main__":
    asyncio.run(main())
