# AI Voice Cost Calculator

A full-stack platform for running live AI voice calls with real-time cost estimation. Built with LiveKit Agents, FastAPI, PostgreSQL, and React.

Compare STT, LLM, and TTS providers side-by-side, estimate monthly infrastructure costs, and make real WebRTC voice calls — all from one dashboard.

![Dashboard](https://img.shields.io/badge/stack-FastAPI%20%7C%20React%20%7C%20LiveKit%20%7C%20PostgreSQL-blue)

---

## Features

- **Multi-provider voice pipeline** — mix and match STT, LLM, and TTS from different providers per call.
- **Live voice calls** — real WebRTC calls via LiveKit with mute, timer, and auto-disconnect.
- **Real-time metrics** — STT / LLM / TTS latency, TTFT, tokens/sec, and traffic-light quality dots after each turn.
- **Smart cost estimator** — auto-picks AWS or GCP server tier based on each model's `compute_profile`; concurrency-aware (`ceil(agents / capacity)`); editable traffic baselines (LLM tokens/hr, TTS chars/hr).
- **Per-user usage quotas** — admin-tunable concurrent + daily call limits prevent vendor-bill leakage.
- **Configurable everywhere** — every host port and the entire DB connection string come from `.env`; ready to redeploy behind a different domain or port set.
- **Admin panel** — manage models (price, label, `compute_profile`, reset-to-seed), users, quotas, and tail backend logs live.
- **Role-based auth** — JWT login; admin / customer roles; customer-supplied API keys encrypted with Fernet at rest.
- **Model search & sort** — filter by type, search by name, sort by any column.

---

## Supported Providers

| Category | Providers |
|---|---|
| **STT** | Deepgram Nova-3/2, Groq Whisper, OpenAI Whisper-1, local Whisper (tiny/base/small, EN + multilingual) |
| **LLM** | Groq (Llama 4, Llama 3.3, Qwen3), OpenAI (GPT-4.1, GPT-4o), Google Gemini 2.5/2.0/1.5, Anthropic Claude (Haiku/Sonnet/Opus), DeepSeek V3, Ollama (local) |
| **TTS** | ElevenLabs Flash v2.5, OpenAI TTS-1/HD, Azure Neural, Edge TTS (free), Groq Orpheus, Piper (local, free) |

---

## Architecture

```
Host
  │
  ├─ PostgreSQL (system-installed) ◄────── DATABASE_URL via host.docker.internal
  │
  ├─ Shared LiveKit (~/infra/livekit/)
  │    └─ joins external docker network: voice-shared
  │       WS 7880 · TCP 7881 · UDP 7882 → direct to host
  │
  └─ Docker Compose  (project: ai-voice-cost-calc)
       │
       ├─ Browser ─► frontend (nginx, ${FRONTEND_PORT}) ──► HTTPS via Apache
       │
       ├─ REST/JWT ─► backend (FastAPI, ${BACKEND_PORT}) ─► PostgreSQL (host)
       │                       │
       │                       └─ joins voice-shared ──► livekit:7880
       │
       ├─ agent worker ─ joins voice-shared ─► livekit:7880
       │                                       │
       │                                       └─► STT/LLM/TTS containers (internal only)
       │
       └─ whisper-{tiny,base,small,base-multi,small-multi} · tts (Piper) · voicebox
            ▲ no host ports — reached over the docker network by service name
```

**Call flow:**
1. Browser requests a token from the FastAPI backend (selected model config embedded in metadata).
2. Backend signs a token whose URL is `LIVEKIT_PUBLIC_URL` (the WSS Apache exposes); browser connects there.
3. Agent worker picks up the room (signaling over `LIVEKIT_URL=ws://livekit:7880` on the shared docker network), reads metadata, and builds the STT → LLM → TTS pipeline.
4. Real-time transcript + per-stage latency metrics are sent back to the browser via LiveKit data messages.

**Database:** PostgreSQL runs on the host (not in Docker) so DB lifecycle is decoupled from `docker compose`. Backend reaches it via `host.docker.internal`.

**LiveKit:** runs as **shared infrastructure** at `~/infra/livekit/` and is *not* part of this Compose project. Both this stack and the booking-app stack join the external `voice-shared` Docker network and reach LiveKit by service name.

---

## Quick Start

```bash
git clone <repo-url>
cd livekit-ai-voice-agent

# 1. Create the shared docker network (one-time per host).
docker network create voice-shared 2>/dev/null || true

# 2. Bring up the shared LiveKit at ~/infra/livekit/ if it isn't already.
#    (See its own README; it must publish itself on the voice-shared network.)

# 3. Create the database on your host Postgres (one-time).
#    Defaults expect user=postgres, password=password, db=voiceagent;
#    override via .env if your local install differs.
psql -U postgres -c "CREATE DATABASE voiceagent;"

# 4. Copy the env template and fill in API keys + LIVEKIT_API_KEY/SECRET
#    matching ~/infra/livekit/livekit.yaml.
cp .env.example .env

# 5. Start everything.
docker compose up -d --build
```

The backend auto-runs Postgres column migrations, seeds the default model catalogue, and downloads the LiveKit turn-detector model into a shared volume on first start. **No manual `download-files` step is needed.**

Open **http://localhost:${FRONTEND_PORT:-3000}** and log in with the admin credentials from your `.env`. In production, point your browser at the Apache HTTPS URL instead.

---

## Development Setup

Run infrastructure in Docker and the app natively for hot-reload.

### 1. Prerequisites

| Tool | Install |
|---|---|
| PostgreSQL 14+ (host-installed) | `brew install postgresql@16` (macOS) / package manager (Linux) |
| Python 3.11+ | [python.org](https://python.org) |
| uv | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Node 18+ | [nodejs.org](https://nodejs.org) |
| Docker Desktop | [docker.com](https://docs.docker.com/get-docker/) |

### 2. Database

```bash
# Create the project DB once.
createdb voiceagent
# Optionally create a dedicated role:
psql -d postgres -c "CREATE USER va WITH PASSWORD 'password'; GRANT ALL ON DATABASE voiceagent TO va;"
```

Set matching values in `.env` (`POSTGRES_USER`, `POSTGRES_PASSWORD`, etc.).

### 3. Supporting services in Docker (LiveKit + Whisper + TTS)

```bash
# LiveKit comes from the shared infra, not this compose:
( cd ~/infra/livekit && docker compose up -d )

# STT/TTS containers from this stack:
docker compose up -d tts whisper-base
```

### 4. Backend

```bash
cd backend
uv sync
# Native: backend reaches host Postgres at localhost:5432 and shared LiveKit
# at the host port (not via the docker DNS name `livekit`).
POSTGRES_HOST=localhost \
LIVEKIT_URL=ws://localhost:7880 \
  uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 5. Agent worker

The backend auto-downloads the turn-detector model on startup. For native dev:

```bash
cd backend
LIVEKIT_URL=ws://localhost:7880 uv run python agent.py start
```

### 6. Frontend

```bash
cd frontend
npm install
npm run dev    # uses VITE_BACKEND_URL or BACKEND_PORT to find the API
```

Open **http://localhost:3000**

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the keys for the providers you want to use.

```env
# ─── Database (system-installed Postgres on host) ────────────────────
POSTGRES_HOST=host.docker.internal   # or `localhost` for native dev
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=password
POSTGRES_DB=voiceagent

# ─── Host port mappings ──────────────────────────────────────────────
# HOST_BIND controls which host interface published ports listen on.
# 127.0.0.1 (default) = loopback only; Apache fronts it for HTTPS.
# 0.0.0.0             = all interfaces; for LAN/dev access without a proxy.
HOST_BIND=127.0.0.1
BACKEND_PORT=8000
FRONTEND_PORT=3000
VOICEBOX_PORT=17493

# Whisper/TTS containers stay internal-only on the docker network — no host port.

# ─── LiveKit URLs ────────────────────────────────────────────────────
# Internal — used server-side by backend + agent. MUST be plain ws://
# (LiveKit speaks unencrypted WS internally; Apache adds TLS only for
# the browser). Using wss:// here fails with "SSL record layer failure".
LIVEKIT_URL=ws://livekit:7880

# Public — what the browser uses. In prod set to the WSS Apache exposes.
LIVEKIT_PUBLIC_URL=wss://livekit.example.com

# ─── Auth + secrets ──────────────────────────────────────────────────
LIVEKIT_API_KEY=devkey               # must match ~/infra/livekit/livekit.yaml
LIVEKIT_API_SECRET=<your-secret>
SECRET_KEY=<random-hex-32>           # JWT signing key
FERNET_KEY=<fernet-key>              # encrypts customer API keys at rest

# ─── Admin account (created on first startup) ────────────────────────
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me-on-first-login

# ─── Provider API keys (only needed for providers you actually use) ──
GROQ_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
DEEPGRAM_API_KEY=
ELEVENLABS_API_KEY=
DEEPSEEK_API_KEY=
```

Generate keys:
```bash
# SECRET_KEY
python3 -c "import secrets; print(secrets.token_hex(32))"

# FERNET_KEY
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

---

## Services & Ports

Only host-facing services are published; STT/TTS containers are reached
internally over the `voice-shared` / default docker networks by service name.

| Service | Container port | Host mapping | Env var |
|---|---|---|---|
| Frontend (nginx) | 80 | `${HOST_BIND}:${FRONTEND_PORT}` | `FRONTEND_PORT` |
| Backend (FastAPI) | 8000 | `${HOST_BIND}:${BACKEND_PORT}` | `BACKEND_PORT` |
| Voicebox (optional) | 17493 | `${HOST_BIND}:${VOICEBOX_PORT}` | `VOICEBOX_PORT` |
| Whisper tiny / base / small | 8000 | *internal only* | — |
| Whisper multi (base / small) | 8000 | *internal only* | — |
| Piper TTS | 8000 | *internal only* | — |
| LiveKit signal / RTC TCP / RTC UDP | 7880 / 7881 / 7882 | published by `~/infra/livekit/` | (separate stack) |
| PostgreSQL | 5432 | host (not Docker) | `POSTGRES_PORT` |

> Whisper, Piper, and (when not exposed) Voicebox are only reachable via
> docker DNS names like `http://whisper-base:8000` or `http://tts:8000`
> from inside the same Compose project. They do **not** bind host ports.

---

## Production: Apache reverse proxy

Apache terminates TLS for the dashboard, the backend API, and LiveKit
signaling. The container ports stay bound to `${HOST_BIND}` (loopback by
default), so Apache is the only public ingress.

**Required modules:** `proxy`, `proxy_http`, `proxy_wstunnel`, `rewrite`, `ssl`.

A typical layout exposes three vhosts:

- `app.example.com`     → `http://127.0.0.1:${FRONTEND_PORT}` (the React UI)
- `api.example.com`     → `http://127.0.0.1:${BACKEND_PORT}` (FastAPI)
- `livekit.example.com` → `http://127.0.0.1:7880` with WebSocket upgrade

The third vhost is the WSS endpoint clients use for `LIVEKIT_PUBLIC_URL`.
**LiveKit's UDP media port (7882) cannot be proxied** — open it directly
on the host firewall.

---

## Admin Panel

Log in as admin to access the **Admin** tab in the top navigation.

| Tab | What you can do |
|---|---|
| **Models** | Enable / disable models, edit label / price / `compute_profile` inline, reset edited rows back to seed defaults, search / filter / sort, sync seed data |
| **Users** | Add users, toggle active status, assign roles (admin / customer) |
| **Settings** | Per-call duration limit · max concurrent calls per user · max calls per user per day |
| **Logs** | Live-tailing backend logs with level filtering and auto-scroll |

**Customer onboarding flow** (admin → customer):
1. Create a customer account in the Users tab.
2. Decide quotas in the Settings tab — defaults are 2 concurrent calls and 50/day per user.
3. Send the customer the URL + their credentials. They can immediately use any FREE local model (Whisper, Piper, Edge, Voicebox, Ollama). To unlock cloud providers, they add their own API keys in the Config modal.

At least one admin account must remain active — the last active admin cannot be disabled.

---

## API Keys

Provider API keys are stored encrypted (AES-256 Fernet) in PostgreSQL. Admins set keys in the **Config** modal; they are injected into LiveKit participant metadata at call time so the agent worker never stores them in memory beyond the call duration.

---

## Cost Estimation

The Cost Estimator computes monthly cost as:

```
sttCost    = stt.price_per_hour × agents × hours/day × days/month
llmCost    = llm.price_per_hour × agents × hours/day × days/month × (custom_tokens_per_hour / 30,000)
ttsCost    = tts.price_per_hour × agents × hours/day × days/month × (custom_chars_per_hour / 50,000)
serverCost = ceil(agents / tier.concurrent_capacity) × hours/day × days/month × tier.$/hr
total      = sttCost + llmCost + ttsCost + serverCost
```

Defaults for the tunable baselines:

| Type | Baseline | Note |
|---|---|---|
| STT | 1 hr audio = 1 hr cost | Real-time billing |
| LLM | 30,000 tokens/hr (15K in + 15K out, ~3 turns/min) | Customer-tunable in the UI |
| TTS | 50,000 chars/hr (agent speaks ~50% @ 150 wpm × 5 chars/word) | Customer-tunable in the UI |

**Server tiers** are auto-recommended from each model's `compute_profile`
(`none / cpu_light / cpu_heavy / gpu_small / gpu_mid / gpu_large`); the BEST
option is auto-selected and labelled `✨ AUTO`. One server hosts multiple
concurrent voice agents (an A10G runs ~5 small-LLM streams), so the cost
formula scales with `ceil(agents / concurrent_capacity)`, not with the agent
count itself.

**Quotas** prevent vendor-bill leakage: each customer is limited to
`max_concurrent_calls_per_user` (default 2) and `max_calls_per_day_per_user`
(default 50). Both are admin-tunable. Admins are exempt.

---

## Project Structure

```
livekit-ai-voice-agent/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app · startup migrations · seed reconcile
│   │   ├── seed_data.py         # Default model catalog + compute_profile_for()
│   │   ├── log_buffer.py        # In-memory log ring buffer (500 lines)
│   │   ├── models/              # SQLAlchemy ORM models
│   │   ├── routes/
│   │   │   ├── auth.py          # Login / token refresh
│   │   │   ├── admin_route.py   # Models · users · settings · logs · reset_to_seed
│   │   │   ├── token_route.py   # LiveKit token generation + quota enforcement
│   │   │   ├── models_route.py  # Customer model catalog (filters by API keys)
│   │   │   ├── setup_route.py   # Turn-detector model download status
│   │   │   ├── tts_route.py     # Edge / Voicebox TTS sample
│   │   │   └── fx_route.py      # USD → INR exchange rate
│   │   └── services/
│   │       ├── auth.py          # JWT + bcrypt
│   │       ├── encryption.py    # Fernet API key encryption
│   │       ├── livekit_svc.py   # Token signing (uses LIVEKIT_PUBLIC_URL)
│   │       ├── model_setup.py   # Async turn-detector model downloader
│   │       └── model_sync.py    # Reconciles dynamic Ollama / Voicebox models
│   └── agent.py                 # LiveKit agent worker (warmups + JIT loaders)
├── frontend/
│   └── src/
│       ├── pages/Dashboard.tsx
│       ├── components/
│       │   ├── AdminPanel/      # Admin tabs (models / users / settings / logs)
│       │   ├── CallInterface/   # WebRTC call controls + setup-ready modal
│       │   ├── ConfigModal/     # Customer API-key entry (encrypted at rest)
│       │   ├── CostEstimator/   # Auto-recommended server tier · concurrency
│       │   │                    #   model · editable traffic baselines
│       │   ├── MetricsPanel/    # Live STT/LLM/TTS latency + quality dots
│       │   ├── TranscriptPanel/ # Conversation transcript
│       │   └── LoginPage/
│       └── store/               # Zustand: auth · call · models
├── voicebox/                    # Optional local TTS engine (profile: voicebox)
├── docker-compose.yml           # project: ai-voice-cost-calc; no postgres, no livekit
└── .env                         # Secrets, ports, DB connection, API keys
```

> The LiveKit server config (`livekit.yaml`) and the LiveKit container live
> under `~/infra/livekit/`, not in this repo. This stack only consumes it.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `network voice-shared declared as external, but could not be found` | Run `docker network create voice-shared` once on the host. |
| Backend can't reach Postgres | Confirm host Postgres is running and listens on `POSTGRES_PORT`. Inside Docker, `POSTGRES_HOST` must be `host.docker.internal` (already the default). |
| `could not establish signal connection` | Shared LiveKit container not running. `cd ~/infra/livekit && docker compose ps`. |
| `SSL record layer failure` connecting to LiveKit | `LIVEKIT_URL` is `wss://…`. Internal must be plain `ws://livekit:7880`; only the browser-facing `LIVEKIT_PUBLIC_URL` is `wss://`. |
| `port is already allocated` on `up` | An orphan container from a prior project name still holds the port. `docker ps -a` to find it, then `docker rm -f <name>`. |
| `could not establish pc connection` | ICE IP mismatch — check the shared LiveKit's `livekit.yaml` and that UDP 7882 is reachable from clients. |
| Browser says `403 Account is disabled` | Admin disabled the user — re-enable in Admin → Users. |
| `429 Concurrent-call limit reached` | The customer hit their quota — bump it in Admin → Settings, or wait for active calls to finish. |
| Turn-detector model missing | Backend auto-downloads on startup. If it failed (no internet at first start), open Admin → check the setup endpoint. |
| `Ollama unreachable` warning | Normal if Ollama is not installed — local LLM models won't appear. |
| FX rate not showing | Frankfurter API unreachable — badge is hidden automatically. |
| Last admin can't be disabled | By design — activate another admin account first. |
| Re-seeding clobbered an admin price edit | Won't happen: rows admins have edited get `is_seed=false` and are skipped by the reseed reconcile. Click "Reset to seed" on a row to re-adopt the seed default. |
