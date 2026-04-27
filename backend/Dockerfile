FROM python:3.11-slim

WORKDIR /app

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Bake the project venv into the image so `uv run` (and any subprocess that
# uses .venv/bin/python) starts instantly at runtime instead of resolving
# and downloading wheels on every container start.
COPY pyproject.toml .
RUN uv sync --no-install-project

# Copy application code and finalize the project install
COPY . .
RUN uv sync

# Use the prebuilt venv directly (skip the `uv run` resolution step)
ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
