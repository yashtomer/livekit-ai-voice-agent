# LiveKit AI Voice Agent (Fully Local)

A real-time AI voice assistant that runs **100% locally** with zero API costs. Built with [LiveKit Agents](https://github.com/livekit/agents), Ollama, Whisper, and Piper TTS.

## How It Works

```
You speak → Mic captures audio
              ↓
         Silero VAD (detects speech)
              ↓
         Faster-Whisper (speech → text)
              ↓
         Gemma 4 LLM (generates response)
              ↓
         Piper TTS (text → speech)
              ↓
You hear ← Speaker plays audio
```

## Architecture

| Component | Provider | Model | Runs on | Port |
|-----------|----------|-------|---------|------|
| STT | Faster-Whisper | `base.en` | Docker | 8100 |
| LLM | Ollama | Gemma 4 (2B) | Native | 11434 |
| TTS | OpenedAI-Speech (Piper) | `alloy` | Docker | 8200 |
| VAD | Silero | ONNX | In-process | - |
| Server | LiveKit | - | Docker | 7880 |

## Quick Start

```bash
git clone https://github.com/yashtomer/livekit-ai-voice-agent.git
cd livekit-ai-voice-agent
./setup.sh
```

The setup script automatically installs all dependencies, pulls models, starts services, and configures everything. After setup, run:

```bash
uv run python src/agent.py console
```

## Prerequisites (manual setup)

Before starting, make sure you have these installed:

| Tool | Install | Verify |
|------|---------|--------|
| **Python 3.10+** | [python.org](https://www.python.org/) | `python3 --version` |
| **uv** | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | `uv --version` |
| **Docker Desktop** | [docker.com](https://docs.docker.com/get-docker/) | `docker --version` |
| **Ollama** | `brew install ollama` (macOS) or [ollama.com](https://ollama.com/) | `ollama --version` |

## Setup (Step by Step)

### Step 1: Clone the repository

```bash
git clone https://github.com/yashtomer/livekit-ai-voice-agent.git
cd livekit-ai-voice-agent
```

### Step 2: Install and start Ollama

**macOS:**

```bash
brew install ollama
brew services start ollama
```

**Linux:**

```bash
curl -fsSL https://ollama.com/install.sh | sh
systemctl start ollama
```

Verify Ollama is running:

```bash
curl http://localhost:11434/v1/models
```

### Step 3: Pull the LLM model

```bash
ollama pull gemma4:e2b
```

This downloads Gemma 4 (2B parameters, ~7GB). It only needs to download once.

### Step 4: Start Docker services

Make sure Docker Desktop is running, then:

```bash
docker compose up -d
```

This starts three services:

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `livekit-server` | `livekit/livekit-server` | 7880 | WebRTC audio transport |
| `whisper` | `fedirz/faster-whisper-server` | 8100 | Speech-to-text |
| `tts` | `ghcr.io/matatonic/openedai-speech` | 8200 | Text-to-speech |

Verify all services are running:

```bash
docker compose ps
```

### Step 5: Install Python dependencies

```bash
uv sync
```

### Step 6: Configure environment

```bash
cp .env.example .env
```

No API keys needed — everything runs locally!

### Step 7: Download required model files

```bash
uv run python src/agent.py download-files
```

This downloads the Silero VAD model (~2MB) used for voice activity detection.

## Running the Agent

### Console mode (quickest way to test)

Uses your local microphone and speakers directly:

```bash
uv run python src/agent.py console
```

- No LiveKit server connection needed
- Just speak into your mic and the agent responds
- Press `Ctrl+C` to stop

### Development mode (for building a real app)

Connects to the LiveKit server for browser-based access:

```bash
uv run python src/agent.py dev
```

Then connect via the [LiveKit Agents Playground](https://agents-playground.livekit.io) or any LiveKit client.

### Console vs Dev mode

| | Console | Dev |
|--|---------|-----|
| Audio | Local mic/speaker | WebRTC via browser |
| LiveKit server | Not needed | Required (port 7880) |
| Multiple users | No | Yes |
| Use case | Quick testing | Building a product |

## Verify Everything Works

Run these checks to make sure all services are healthy:

```bash
# 1. Ollama (LLM)
curl -s http://localhost:11434/v1/models | python3 -m json.tool

# 2. Whisper (STT)
curl -s http://localhost:8100/health

# 3. TTS
curl -s http://localhost:8200/v1/models | python3 -m json.tool

# 4. LiveKit Server
curl -s http://localhost:7880
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `docker compose` fails | Make sure Docker Desktop is running |
| Ollama model not found | Run `ollama pull gemma4:e2b` |
| LLM timeout errors | Normal on CPU — responses take ~13s |
| `termios` error in console | Harmless — only affects keyboard shortcuts |
| Whisper not transcribing | Wait 15s after `docker compose up` for model to load |
| No audio output | Check your speaker/mic permissions in System Settings |

## Stopping Everything

```bash
# Stop the agent
Ctrl+C

# Stop Docker services
docker compose down

# Stop Ollama
brew services stop ollama
```

## Cost

**$0/month** — all models run locally. No external API calls, no rate limits, no data leaving your machine.

## Project Structure

```
livekit-ai-voice-agent/
├── src/
│   └── agent.py           # Main voice agent code
├── .env.example            # Environment variable template
├── .claude/
│   └── launch.json         # Dev server configurations
├── docker-compose.yml      # LiveKit + Whisper + TTS services
├── pyproject.toml          # Project metadata and dependencies
└── uv.lock                 # Locked dependency versions
```
