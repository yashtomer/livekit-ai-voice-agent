# LiveKit AI Voice Agent

A real-time AI voice assistant built with [LiveKit Agents](https://github.com/livekit/agents). Uses Anthropic Claude for conversation and OpenAI for speech-to-text and text-to-speech.

## Prerequisites

- Python 3.10+
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- [Anthropic API key](https://console.anthropic.com/)
- [OpenAI API key](https://platform.openai.com/api-keys) (for STT/TTS)
- LiveKit server (local or cloud)

## Setup

### 1. Install dependencies

```bash
uv sync
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add your API keys:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
OPENAI_API_KEY=sk-your-key-here
```

### 3. Download required models

```bash
uv run python src/agent.py download-files
```

### 4. Start LiveKit server

**macOS (recommended):**

```bash
brew install livekit
livekit-server --dev
```

**Docker (Linux):**

```bash
docker compose up -d
```

The `--dev` flag provides default credentials: API key `devkey`, secret `secret`.

## Running the Agent

### Console mode (quickest way to test)

Uses your local microphone and speakers directly - no LiveKit server needed:

```bash
uv run python src/agent.py console
```

### Development mode (connects to LiveKit server)

```bash
uv run python src/agent.py dev
```

Then connect via the [LiveKit Agents Playground](https://agents-playground.livekit.io) or any LiveKit client.

## Architecture

| Component | Model | Purpose |
|-----------|-------|---------|
| STT | OpenAI `gpt-4o-transcribe` | Speech-to-text transcription |
| LLM | Anthropic `claude-sonnet-4` | Conversation and reasoning |
| TTS | OpenAI `gpt-4o-mini-tts` | Text-to-speech synthesis |
| VAD | Silero | Voice activity detection |

## Project Structure

```
src/agent.py       - Main voice agent code
.env.example       - Environment variable template
docker-compose.yml - Local LiveKit server (Docker)
pyproject.toml     - Project metadata and dependencies
uv.lock            - Locked dependency versions
```
