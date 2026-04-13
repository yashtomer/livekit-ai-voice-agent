# LiveKit AI Voice Agent

A real-time AI voice assistant built with [LiveKit Agents](https://github.com/livekit/agents) and OpenAI. The agent listens to speech, processes it with GPT-4o, and responds with natural-sounding voice.

## Prerequisites

- Python 3.10+
- [OpenAI API key](https://platform.openai.com/api-keys)
- LiveKit server (local or cloud)

## Setup

### 1. Install dependencies

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add your OpenAI API key:

```
OPENAI_API_KEY=sk-your-actual-key-here
```

### 3. Download required models

```bash
python src/agent.py download-files
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
python src/agent.py console
```

### Development mode (connects to LiveKit server)

```bash
python src/agent.py dev
```

Then connect via the [LiveKit Agents Playground](https://agents-playground.livekit.io) or any LiveKit client.

## Architecture

The agent uses a voice pipeline with three OpenAI models:

| Component | Model | Purpose |
|-----------|-------|---------|
| STT | `gpt-4o-transcribe` | Speech-to-text transcription |
| LLM | `gpt-4o` | Conversation and reasoning |
| TTS | `gpt-4o-mini-tts` | Text-to-speech synthesis |
| VAD | Silero | Voice activity detection |

## Project Structure

```
src/agent.py       - Main voice agent code
.env.example       - Environment variable template
docker-compose.yml - Local LiveKit server (Docker)
requirements.txt   - Python dependencies
pyproject.toml     - Project metadata
```
