#!/usr/bin/env python3
"""Benchmark STT, LLM, and TTS latency individually."""

import time
import wave
import struct
import httpx
import json
import statistics

OLLAMA_URL = "http://localhost:11434"
OLLAMA_OPENAI_URL = "http://localhost:11434/v1"
WHISPER_URL = "http://localhost:8100/v1"
TTS_URL = "http://localhost:8200/v1"
LLM_MODEL = "gemma4:e2b"
ROUNDS = 3

client = httpx.Client(timeout=120.0)


def generate_test_wav(duration_sec=2, sample_rate=16000):
    """Generate a silent WAV file for STT testing."""
    n_frames = sample_rate * duration_sec
    frames = struct.pack(f"<{n_frames}h", *([0] * n_frames))
    import io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(frames)
    buf.seek(0)
    return buf.read()


def benchmark_stt():
    """Benchmark Whisper STT latency."""
    print("\n" + "=" * 50)
    print("STT BENCHMARK (Faster-Whisper)")
    print("=" * 50)

    wav_data = generate_test_wav(duration_sec=2)
    times = []

    for i in range(ROUNDS):
        start = time.perf_counter()
        resp = client.post(
            f"{WHISPER_URL}/audio/transcriptions",
            files={"file": ("test.wav", wav_data, "audio/wav")},
            data={"model": "Systran/faster-whisper-base.en", "language": "en"},
        )
        elapsed = time.perf_counter() - start
        times.append(elapsed)
        text = resp.json().get("text", "").strip()
        print(f"  Run {i+1}: {elapsed:.3f}s | text: '{text[:50]}'")

    print(f"\n  Avg: {statistics.mean(times):.3f}s | Min: {min(times):.3f}s | Max: {max(times):.3f}s")
    return statistics.mean(times)


def benchmark_llm():
    """Benchmark Ollama LLM latency (streaming first token + total)."""
    print("\n" + "=" * 50)
    print("LLM BENCHMARK (Gemma 4 2B via Ollama)")
    print("=" * 50)

    prompts = [
        "Say hello in one sentence.",
        "What is Python?",
        "Tell me a joke.",
    ]

    # Warmup
    print("  Warming up model...")
    client.post(
        f"{OLLAMA_URL}/api/generate",
        json={"model": LLM_MODEL, "prompt": "hi", "stream": False, "options": {"num_predict": 1}},
        timeout=120.0,
    )

    ttft_times = []
    total_times = []
    token_counts = []

    for i, prompt in enumerate(prompts):
        start = time.perf_counter()
        first_token_time = None
        full_text = ""
        tokens = 0

        with client.stream(
            "POST",
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": LLM_MODEL,
                "prompt": prompt,
                "stream": True,
                "options": {"num_predict": 50, "temperature": 0.6},
            },
            timeout=120.0,
        ) as resp:
            for line in resp.iter_lines():
                if line:
                    data = json.loads(line)
                    token = data.get("response", "")
                    if token and first_token_time is None:
                        first_token_time = time.perf_counter() - start
                    full_text += token
                    tokens += 1
                    if data.get("done"):
                        break

        total = time.perf_counter() - start
        ttft = first_token_time or total

        ttft_times.append(ttft)
        total_times.append(total)
        token_counts.append(tokens)

        tps = tokens / total if total > 0 else 0
        print(f"  Run {i+1}: TTFT={ttft:.3f}s | Total={total:.3f}s | {tokens} tokens | {tps:.1f} tok/s")
        print(f"         '{full_text.strip()[:60]}...'")

    print(f"\n  Avg TTFT: {statistics.mean(ttft_times):.3f}s")
    print(f"  Avg Total: {statistics.mean(total_times):.3f}s")
    print(f"  Avg Tokens/s: {sum(token_counts) / sum(total_times):.1f}")
    return statistics.mean(ttft_times), statistics.mean(total_times)


def benchmark_tts():
    """Benchmark TTS latency."""
    print("\n" + "=" * 50)
    print("TTS BENCHMARK (OpenedAI-Speech / Piper)")
    print("=" * 50)

    texts = [
        "Hello, how can I help you today?",
        "That is a great question, let me think about it.",
        "Sure, I would be happy to help you with that.",
    ]

    times = []
    sizes = []

    for i, text in enumerate(texts):
        start = time.perf_counter()
        resp = client.post(
            f"{TTS_URL}/audio/speech",
            headers={"Authorization": "Bearer local"},
            json={"model": "tts-1", "voice": "alloy", "input": text},
        )
        elapsed = time.perf_counter() - start
        audio_size = len(resp.content)

        times.append(elapsed)
        sizes.append(audio_size)
        print(f"  Run {i+1}: {elapsed:.3f}s | {audio_size/1024:.0f}KB | '{text[:40]}...'")

    print(f"\n  Avg: {statistics.mean(times):.3f}s | Avg size: {statistics.mean(sizes)/1024:.0f}KB")
    return statistics.mean(times)


def main():
    print("╔══════════════════════════════════════════════╗")
    print("║   Voice Agent Performance Benchmark          ║")
    print("╚══════════════════════════════════════════════╝")

    # Check services
    print("\nChecking services...")
    services = {
        "Whisper STT": f"{WHISPER_URL}/../health",
        "Ollama LLM": f"{OLLAMA_URL}/v1/models",
        "Piper TTS": f"{TTS_URL}/models",
    }
    for name, url in services.items():
        try:
            r = client.get(url, timeout=5)
            print(f"  ✓ {name}")
        except Exception:
            print(f"  ✗ {name} - NOT RUNNING")
            return

    stt_avg = benchmark_stt()
    ttft_avg, llm_avg = benchmark_llm()
    tts_avg = benchmark_tts()

    print("\n" + "=" * 50)
    print("SUMMARY")
    print("=" * 50)
    pipeline_total = stt_avg + llm_avg + tts_avg
    pipeline_with_streaming = stt_avg + ttft_avg + tts_avg

    print(f"\n  STT (Whisper):     {stt_avg:.3f}s")
    print(f"  LLM TTFT:          {ttft_avg:.3f}s")
    print(f"  LLM Total:         {llm_avg:.3f}s")
    print(f"  TTS:               {tts_avg:.3f}s")
    print(f"\n  Pipeline (sequential):     {pipeline_total:.3f}s")
    print(f"  Pipeline (with streaming): {pipeline_with_streaming:.3f}s")

    # Rating
    print(f"\n  BOTTLENECK: ", end="")
    components = {"STT": stt_avg, "LLM (TTFT)": ttft_avg, "TTS": tts_avg}
    bottleneck = max(components, key=components.get)
    print(f"{bottleneck} ({components[bottleneck]:.3f}s)")


if __name__ == "__main__":
    main()
