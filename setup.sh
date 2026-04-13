#!/usr/bin/env bash
set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_step() { echo -e "\n${BLUE}[$1/7]${NC} $2"; }
print_ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
print_warn() { echo -e "  ${YELLOW}!${NC} $1"; }
print_fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }

echo -e "${GREEN}"
echo "╔══════════════════════════════════════════════╗"
echo "║   LiveKit AI Voice Agent - Local Setup       ║"
echo "║   Ollama + Whisper + Piper TTS (\$0/month)    ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ─── Step 1: Check prerequisites ───
print_step 1 "Checking prerequisites..."

# Python 3.10+ (check multiple paths)
PYTHON_CMD=""
for cmd in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$cmd" &>/dev/null; then
        PY_VER=$($cmd -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
        PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
        PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
        if [ "$PY_MAJOR" -ge 3 ] && [ "$PY_MINOR" -ge 10 ]; then
            PYTHON_CMD="$cmd"
            break
        fi
    fi
done

if [ -n "$PYTHON_CMD" ]; then
    print_ok "Python $PY_VER ($PYTHON_CMD)"
else
    print_fail "Python 3.10+ required. Install from https://python.org"
fi

# Docker
if command -v docker &>/dev/null; then
    if docker info &>/dev/null; then
        print_ok "Docker (running)"
    else
        print_fail "Docker is installed but not running. Start Docker Desktop first."
    fi
else
    print_fail "Docker not found. Install from https://docs.docker.com/get-docker/"
fi

# uv
if command -v uv &>/dev/null; then
    print_ok "uv $(uv --version | awk '{print $2}')"
else
    echo -e "  ${YELLOW}!${NC} uv not found. Installing..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
    print_ok "uv installed"
fi

# ─── Step 2: Install Ollama ───
print_step 2 "Setting up Ollama..."

if command -v ollama &>/dev/null; then
    print_ok "Ollama already installed"
else
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &>/dev/null; then
            echo "  Installing Ollama via Homebrew..."
            brew install ollama
        else
            print_fail "Homebrew not found. Install Ollama from https://ollama.com"
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "  Installing Ollama..."
        curl -fsSL https://ollama.com/install.sh | sh
    else
        print_fail "Unsupported OS. Install Ollama from https://ollama.com"
    fi
    print_ok "Ollama installed"
fi

# Start Ollama
if curl -s http://localhost:11434/v1/models &>/dev/null; then
    print_ok "Ollama is running"
else
    echo "  Starting Ollama..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew services start ollama 2>/dev/null || true
    else
        systemctl start ollama 2>/dev/null || ollama serve &>/dev/null &
    fi
    # Wait for Ollama to be ready
    for i in {1..15}; do
        if curl -s http://localhost:11434/v1/models &>/dev/null; then
            break
        fi
        sleep 1
    done
    if curl -s http://localhost:11434/v1/models &>/dev/null; then
        print_ok "Ollama started"
    else
        print_fail "Failed to start Ollama"
    fi
fi

# ─── Step 3: Pull Gemma 4 model ───
print_step 3 "Pulling Gemma 4 (2B) model..."

if ollama list 2>/dev/null | grep -q "gemma4:e2b"; then
    print_ok "gemma4:e2b already downloaded"
else
    echo "  Downloading gemma4:e2b (~7GB, this may take a few minutes)..."
    ollama pull gemma4:e2b
    print_ok "gemma4:e2b downloaded"
fi

# ─── Step 4: Start Docker services ───
print_step 4 "Starting Docker services (LiveKit + Whisper + TTS)..."

docker compose up -d 2>&1 | grep -E "Started|Running|Created" || true

# Wait for services to be healthy
echo "  Waiting for services to initialize..."
for i in {1..30}; do
    WHISPER_OK=$(curl -s http://localhost:8100/health 2>/dev/null || echo "")
    TTS_OK=$(curl -s http://localhost:8200/v1/models 2>/dev/null || echo "")
    if [ "$WHISPER_OK" = "OK" ] && [ -n "$TTS_OK" ]; then
        break
    fi
    sleep 2
done

# Verify each service
if curl -s http://localhost:7880 &>/dev/null; then
    print_ok "LiveKit Server (port 7880)"
else
    print_warn "LiveKit Server not ready yet"
fi

if [ "$(curl -s http://localhost:8100/health 2>/dev/null)" = "OK" ]; then
    print_ok "Whisper STT (port 8100)"
else
    print_warn "Whisper STT still loading (may take a minute)"
fi

if curl -s http://localhost:8200/v1/models &>/dev/null; then
    print_ok "Piper TTS (port 8200)"
else
    print_warn "Piper TTS still loading (may take a minute)"
fi

# ─── Step 5: Install Python dependencies ───
print_step 5 "Installing Python dependencies..."

uv sync 2>&1 | tail -3
print_ok "Dependencies installed"

# ─── Step 6: Configure environment ───
print_step 6 "Configuring environment..."

if [ ! -f .env ]; then
    cp .env.example .env
    print_ok "Created .env from .env.example"
else
    print_ok ".env already exists"
fi

# ─── Step 7: Download model files ───
print_step 7 "Downloading required model files..."

uv run python src/agent.py download-files 2>&1 | grep -E "Downloading|Finished" || true
print_ok "Model files ready"

# ─── Done ───
echo ""
echo -e "${GREEN}"
echo "╔══════════════════════════════════════════════╗"
echo "║          Setup complete!                     ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"
echo "  Run the agent:"
echo ""
echo -e "    ${BLUE}uv run python src/agent.py console${NC}    # Test with mic/speaker"
echo -e "    ${BLUE}uv run python src/agent.py dev${NC}        # Connect via browser"
echo ""
echo "  Stop everything:"
echo ""
echo -e "    ${BLUE}docker compose down${NC}"
echo -e "    ${BLUE}brew services stop ollama${NC}"
echo ""
