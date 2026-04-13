# LiveKit AI Voice Agent (Fully Local)

A real-time AI voice assistant that runs **100% locally** with zero API costs. Built with [LiveKit Agents](https://github.com/livekit/agents), Ollama, Whisper, and Piper TTS.

## Architecture

| Component | Provider | Model | Runs on |
|-----------|----------|-------|---------|
| STT | Faster-Whisper | `base.en` | Docker (port 8100) |
| LLM | Ollama | Gemma 4 | Native (port 11434) |
| TTS | OpenedAI-Speech (Piper) | `alloy` | Docker (port 8200) |
| VAD | Silero | - | In-process |
| Server | LiveKit | - | Docker (port 7880) |

## Prerequisites

- Python 3.10+
- [uv](https://docs.astral.sh/uv/)
- [Docker](https://docs.docker.com/get-docker/)
- [Ollama](https://ollama.com/)

## Setup

### 1. Install Ollama and pull the model

```bash
brew install ollama
brew services start ollama
ollama pull gemma4
```

### 2. Start Docker services (LiveKit + Whisper + TTS)

```bash
docker compose up -d
```

This starts:
- LiveKit server on port 7880
- Faster-Whisper STT on port 8100
- OpenedAI-Speech TTS on port 8200

### 3. Install Python dependencies

```bash
uv sync
```

### 4. Configure environment

```bash
cp .env.example .env
```

No API keys needed - everything is local!

### 5. Download required models

```bash
uv run python src/agent.py download-files
```

## Running the Agent

### Console mode (quickest way to test)

```bash
uv run python src/agent.py console
```

### Development mode (connects to LiveKit server)

```bash
uv run python src/agent.py dev
```

## Cost

**$0/month** - All models run locally. No external API calls.

## Project Structure

```
src/agent.py       - Main voice agent code
.env.example       - Environment variable template
docker-compose.yml - LiveKit + Whisper + TTS services
pyproject.toml     - Project metadata and dependencies
uv.lock            - Locked dependency versions
```
