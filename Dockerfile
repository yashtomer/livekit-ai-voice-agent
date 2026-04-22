# ─── Shared image for the token server AND the agent worker ───
# Both processes need the same Python deps (livekit-agents, fastapi, torch,
# faster-whisper clients, etc.). docker-compose.yml runs two services from
# this one image with different CMD overrides, which keeps build time
# down — deps are installed once, cached, and reused.
#
# Build:      docker compose build token-server agent
# Run just one: docker compose up token-server

FROM python:3.12-slim AS base

# System packages required at runtime:
#   - ffmpeg: audio encoding/decoding for Whisper + edge-tts fallbacks
#   - curl:   health checks
#   - libsndfile1 / libgomp1: soundfile + OpenMP (used by torch on CPU)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      curl \
      libsndfile1 \
      libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# uv is our package manager (same as native dev). Pull the static binary.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

WORKDIR /app

# Copy manifest first for best layer caching — deps only change when this
# file changes. Source edits won't re-trigger the slow torch download.
COPY pyproject.toml uv.lock ./

# Install deps (cloud extra unlocks Anthropic/Deepgram + UI extra for FastAPI)
RUN uv sync --locked --extra cloud --extra ui

# Copy source code + the web frontend (token server serves it statically)
COPY src/ ./src/
COPY web/ ./web/

# Pre-download the Silero VAD + turn-detector ONNX models into the image so
# the agent doesn't pay a ~15 MB download on first job. (Matches what we do
# natively via `uv run python src/agent.py download-files`.) This step adds
# ~100 MB to the image but removes the cold-start surprise where the agent
# registers but then fails the first session because ONNX files are missing.
RUN uv run python src/agent.py download-files || true

# 8000 = token server; agent doesn't listen on any port (outbound-only WS).
EXPOSE 8000

# Default CMD runs the token server. docker-compose.yml overrides to
# `python src/agent.py start` for the agent service.
CMD ["uv", "run", "uvicorn", "src.token_server:app", "--host", "0.0.0.0", "--port", "8000"]
