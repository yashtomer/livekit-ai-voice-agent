# AI Voice Cost Calculator

A full-stack platform for running live AI voice calls with real-time cost estimation. Built with LiveKit Agents, FastAPI, PostgreSQL, and React.

Compare STT, LLM, and TTS providers side-by-side, estimate monthly infrastructure costs, and make real WebRTC voice calls — all from one dashboard.

![Dashboard](https://img.shields.io/badge/stack-FastAPI%20%7C%20React%20%7C%20LiveKit%20%7C%20PostgreSQL-blue)

---

## Features

- **Multi-provider voice pipeline** — mix and match STT, LLM, and TTS from different providers per call.
- **Live voice calls** — real WebRTC calls via LiveKit with mute, timer, and auto-disconnect.
- **Ultravox browser calling** — one-click AI voice call from the dashboard using the Ultravox WebRTC SDK.
- **WhatsApp AI calling** — incoming WhatsApp calls answered automatically by an Ultravox AI agent (FastAPI bridge).
- **Gemini Live browser calling** — full-duplex voice calls directly in the browser using Google's Gemini Live API (PCM16 / AudioWorklet, barge-in supported).
- **Gemini × Twilio phone bridge** — dial a real phone number and speak with a Gemini Live AI agent via Twilio Media Streams.
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
       ├─ REST/JWT ─► backend (FastAPI, network_mode: host, port 8000)
       │                       │
       │                       ├─ /gemini/ws   ─► Google Gemini Live API (v1alpha)
       │                       ├─ /twilio/voice  ─► TwiML webhook for Twilio
       │                       ├─ /twilio/stream ─► Twilio Media Streams WS bridge
       │                       ├─ /whatsapp/*    ─► WhatsApp + Ultravox bridge
       │                       └─ joins voice-shared ──► livekit:7880
       │
       ├─ agent worker ─ joins voice-shared ─► livekit:7880
       │                                       │
       │                                       └─► STT/LLM/TTS containers (internal only)
       │
       └─ whisper-{tiny,base,small,base-multi,small-multi} · tts (Piper) · voicebox
            ▲ no host ports — reached over the docker network by service name
```

**LiveKit call flow:**
1. Browser requests a token from the FastAPI backend (selected model config embedded in metadata).
2. Backend signs a token whose URL is `LIVEKIT_PUBLIC_URL` (the WSS Apache exposes); browser connects there.
3. Agent worker picks up the room (signaling over `LIVEKIT_URL=ws://livekit:7880` on the shared docker network), reads metadata, and builds the STT → LLM → TTS pipeline.
4. Real-time transcript + per-stage latency metrics are sent back to the browser via LiveKit data messages.

**Ultravox browser call flow:**
1. Browser calls `POST /api/ultravox/create-web-call` on the FastAPI backend.
2. Backend calls the Ultravox API and returns a `joinUrl`.
3. Browser connects directly to Ultravox via the `ultravox-client` SDK (WebRTC, no server relay needed).

**Gemini Live browser call flow:**
1. Browser opens a WebSocket to `GET /gemini/ws?token=<jwt>`.
2. Backend decodes the JWT, looks up the user's encrypted Google API key (`UserAPIKey` table, `provider=google`). Admins fall back to the server `GOOGLE_API_KEY` if no personal key is set; regular users without a key get an immediate `no_api_key` error.
3. Backend connects to Google Gemini Live (`gemini-3.1-flash-live-preview`, `v1alpha`) and relays PCM16 audio both ways.
4. Browser uses an AudioWorklet for zero-latency mic capture (Float32 → Int16 @ 16 kHz) and a dual AudioContext for playback (24 kHz).

**Gemini × Twilio phone bridge flow:**
1. Someone calls your Twilio phone number → Twilio hits `POST /twilio/voice` (TwiML webhook).
2. Backend returns `<Connect><Stream url="wss://<backend-host>/twilio/stream" />` TwiML (host derived from `VITE_BACKEND_URL`, falling back to the request host).
3. Twilio opens a Media Stream WebSocket to `/twilio/stream`; backend transcodes μ-law 8 kHz ↔ PCM16 16 kHz via `audioop` and streams to Gemini Live.
4. For browser-to-phone dialling: browser calls `GET /twilio/token` to get a Twilio Voice SDK JWT, then uses the `@twilio/voice-sdk` `Device` to place a call.

**WhatsApp call flow:**
1. User calls the WhatsApp Business number.
2. Meta sends a `connect` webhook event (with WebRTC SDP offer) to `POST /whatsapp/call-events` on the FastAPI backend.
3. Backend creates an Ultravox session, sets up WebRTC with Meta via `aiortc`, and bridges audio both ways.
4. On hangup, Meta sends a `terminate` event and the backend cleans up.

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

## Ultravox Setup

### Browser calling

1. Add your Ultravox API key in the dashboard **Config** modal under the `ultravox` provider.
2. Click the **Ultravox** button in the top nav — the backend creates a session and the browser connects directly via the Ultravox WebRTC SDK.

No extra config needed; the `/api/ultravox/create-web-call` endpoint is always available.

### WhatsApp AI calling

#### Prerequisites

- A **WhatsApp Business** account with Calling API access (apply via Meta Business Suite).
- An **Ultravox API key** (add to `.env` as `ULTRAVOX_API_KEY`).
- A publicly reachable HTTPS URL for the webhook (ngrok for local dev, Apache for production).
- The backend must run with `network_mode: host` (already configured in `docker-compose-dev.yml`) so the WebRTC STUN stack can discover the real public IP.

#### Required `.env` variables

```env
ULTRAVOX_API_KEY=uv-...
PHONE_NUMBER_ID=<your Meta phone number ID>
ACCESS_TOKEN=<your Meta permanent access token>
META_VERIFY_TOKEN=<any secret string you choose>
```

#### Local development with ngrok

```bash
# Start the stack
docker compose -f docker-compose-dev.yml up -d

# Expose the backend (WhatsApp webhook handler is part of FastAPI on port 8000)
ngrok http 8000
```

Copy the ngrok HTTPS URL (e.g. `https://abc123.ngrok.io`).

#### Meta webhook configuration

1. Go to **Meta Developer Console** → your app → **WhatsApp** → **Configuration**.
2. Under **Webhook**, click **Edit**:
   - **Callback URL**: `https://abc123.ngrok.io/whatsapp/call-events`
   - **Verify token**: the value you set as `META_VERIFY_TOKEN` in `.env`
3. Click **Verify and Save** — Meta will send a GET request to confirm the token.
4. Under **Webhook Fields**, subscribe to **calls**.

Call your WhatsApp Business number — the AI agent will answer automatically.

---

## Gemini Live Voice

The **Gemini** page (`/gemini`) offers two calling modes powered by Google's Gemini Live API:

- **Browser Voice** — mic audio streams directly from your browser to Gemini Live over a FastAPI WebSocket. No phone or Twilio account needed.
- **Phone Bridge** — dial a real Twilio phone number; audio is bridged Twilio Media Streams ↔ Gemini Live by the backend.

### Google API key

Each logged-in user needs a **Google (Gemini) API key** added in **Config → Google (Gemini)**.

- Admins without a personal key fall back to the server-level `GOOGLE_API_KEY` from `.env`.
- Regular users without a configured key see a banner: *"Google (Gemini) API key not configured"* with a direct link to Config.

**To obtain a key:** visit [Google AI Studio](https://aistudio.google.com/apikey) and create an API key for the Gemini API.

### Browser Voice — quick start

1. Navigate to **Gemini** in the top nav.
2. Select **Browser Voice** mode.
3. (Optional) Choose a prompt template or write a custom system prompt, and pick a language.
4. Click **Start Speaking** — allow microphone access when prompted.
5. Talk naturally; click **End Call** to stop.

No extra `.env` variables required beyond `GOOGLE_API_KEY` (or the per-user key in Config).

### Phone Bridge (Twilio) — setup

#### Prerequisites

- A **Twilio account** with a phone number.
- A **TwiML Application** in Twilio console (for browser-based outbound calling).
- Your backend reachable over HTTPS (ngrok for local dev).

#### Required `.env` variables

```env
# Google
GOOGLE_API_KEY=AIza...            # server-level fallback for admins

# Twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_API_KEY=SK...              # Twilio API Key SID (not account SID)
TWILIO_API_SECRET=<api-key-secret>
TWILIO_TWIML_APP_SID=AP...        # TwiML Application SID

# Public backend URL the Twilio/Vobiz webhooks can reach (scheme + host)
VITE_BACKEND_URL=https://api.example.com

# Optional — override the language Gemini responds in for phone calls
PHONE_LANGUAGE=en                 # default: en
```

#### Step 1 — Expose the backend publicly

```bash
# Start the stack
docker compose -f docker-compose-dev.yml up -d

# Expose port 8000 via ngrok (needed for Twilio webhook + Media Streams)
ngrok http 8000
```

Note your ngrok URL, e.g. `https://abc123.ngrok.io`. Set `VITE_BACKEND_URL=https://abc123.ngrok.io` in `.env`.

#### Step 2 — Configure Twilio

1. **Phone number → Voice webhook**
   - In Twilio Console go to **Phone Numbers** → select your number → **Voice & Fax**.
   - Set **A call comes in** → **Webhook** → `https://abc123.ngrok.io/twilio/voice` (HTTP POST).
   - Save.

2. **TwiML Application** (for browser outbound dialling)
   - Go to **Voice** → **TwiML Apps** → **Create new TwiML App**.
   - **Voice Request URL**: `https://abc123.ngrok.io/twilio/voice` (HTTP POST).
   - Save and copy the **Application SID** (`AP…`) → set as `TWILIO_TWIML_APP_SID` in `.env`.

3. **API Key** (for signing browser tokens)
   - Go to **Account** → **API keys & tokens** → **Create API key**.
   - Copy the **SID** (`SK…`) and **Secret** → set as `TWILIO_API_KEY` / `TWILIO_API_SECRET`.

#### Step 3 — Use the Phone Bridge

1. Navigate to **Gemini** → select **Phone Bridge** mode.
2. Click **Call Healthcare Agent** — your browser will connect via the Twilio Voice SDK.
3. Speak; the backend bridges audio to Gemini Live in real time.

> **Incoming call test:** Call the Twilio number from any phone. The Gemini agent answers immediately.

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

# ─── Ultravox (browser + WhatsApp calling) ───────────────────────────
ULTRAVOX_API_KEY=uv-...

# ─── WhatsApp Business (Meta) ────────────────────────────────────────
# Required only if you want AI to answer WhatsApp calls.
PHONE_NUMBER_ID=              # Meta phone number ID
ACCESS_TOKEN=                 # Meta permanent system user access token
META_VERIFY_TOKEN=            # Any secret string — must match Meta webhook config

# ─── Gemini Live Voice ───────────────────────────────────────────────
# GOOGLE_API_KEY is the server-level key used by admins (and the Twilio
# phone bridge). Regular users supply their own key via Config → Google (Gemini).
GOOGLE_API_KEY=AIza...

# ─── Twilio phone bridge (Gemini × Twilio) ───────────────────────────
# Required only if you want the Twilio Phone Bridge on the Gemini page.
TWILIO_ACCOUNT_SID=AC...
TWILIO_API_KEY=SK...          # Twilio API Key SID (not the Account SID)
TWILIO_API_SECRET=            # Secret for the API Key above
TWILIO_TWIML_APP_SID=AP...    # TwiML Application SID (voice request URL = /twilio/voice)
VITE_BACKEND_URL=https://api.example.com   # Public backend URL; used to build the TwiML Stream URL
PHONE_LANGUAGE=en             # Language for Gemini phone agent (default: en)
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
| WhatsApp bridge (Node.js) | 3001 | host port 3001 (`network_mode: host`) | `WHATSAPP_BRIDGE_PORT` |
| Voicebox (optional) | 17493 | `${HOST_BIND}:${VOICEBOX_PORT}` | `VOICEBOX_PORT` |
| Whisper tiny / base / small | 8000 | *internal only* | — |
| Whisper multi (base / small) | 8000 | *internal only* | — |
| Piper TTS | 8000 | *internal only* | — |
| LiveKit signal / RTC TCP / RTC UDP | 7880 / 7881 / 7882 | published by `~/infra/livekit/` | (separate stack) |
| PostgreSQL | 5432 | host (not Docker) | `POSTGRES_PORT` |

> `whatsapp-bridge` uses `network_mode: host` so that the Node.js WebRTC stack can resolve the host's real public IP via STUN. Docker's NAT hides the public IP from STUN, causing Meta to reject the SDP — host networking bypasses this.

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

### Webhook routes via Apache

The backend runs with `network_mode: host` on port 8000. All webhook handlers (`/whatsapp/*`, `/twilio/voice`, `/twilio/stream`) are part of the FastAPI backend — no separate service needed. Apache proxies them from the public HTTPS domain:

```apache
# Inside your api.example.com VirtualHost (or a dedicated vhost)

# FastAPI REST + WebSocket (covers /gemini/ws, /twilio/stream, /whatsapp/*, etc.)
ProxyPass        /  http://127.0.0.1:8000/
ProxyPassReverse /  http://127.0.0.1:8000/

# WebSocket upgrade (required for Gemini WS + Twilio Media Streams)
RewriteEngine On
RewriteCond %{HTTP:Upgrade} websocket [NC]
RewriteCond %{HTTP:Connection} upgrade [NC]
RewriteRule ^/?(.*) ws://127.0.0.1:8000/$1 [P,L]
```

#### Meta (WhatsApp) webhook

Set Meta's **Callback URL** to:
```
https://api.example.com/whatsapp/call-events
```
Set **Verify token** to the value of `META_VERIFY_TOKEN` in `.env`.

#### Twilio webhook

In Twilio Console → your phone number → **Voice & Fax**:

| Field | Value |
|---|---|
| A call comes in | Webhook — `https://api.example.com/twilio/voice` (HTTP POST) |
| TwiML App — Voice Request URL | `https://api.example.com/twilio/voice` (HTTP POST) |

Set `VITE_BACKEND_URL=https://api.example.com` in `.env` so the TwiML `<Stream>` URL resolves correctly.

No extra firewall rules needed — only Apache (port 443) is exposed publicly.

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

**Populate model use-case descriptions** (one-time, after first start):

```bash
docker compose -f docker-compose-dev.yml exec backend uv run python scripts/seed_use_cases.py
```

This fills the `use_case` column for every seeded model. Once populated, hover over the **ⓘ** icon in the Models table to see what each model is best suited for.

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
│   │   │   ├── fx_route.py      # USD → INR exchange rate
│   │   │   ├── gemini_call.py   # Gemini Live browser WS (/gemini/ws) + JWT auth
│   │   │   ├── twilio_bridge.py # Twilio TwiML webhook + Media Stream WS bridge
│   │   │   └── whatsapp.py      # WhatsApp ↔ Ultravox bridge (FastAPI, aiortc)
│   │   └── services/
│   │       ├── auth.py          # JWT + bcrypt
│   │       ├── encryption.py    # Fernet API key encryption
│   │       ├── livekit_svc.py   # Token signing (uses LIVEKIT_PUBLIC_URL)
│   │       ├── model_setup.py   # Async turn-detector model downloader
│   │       └── model_sync.py    # Reconciles dynamic Ollama / Voicebox models
│   └── agent.py                 # LiveKit agent worker (warmups + JIT loaders)
├── frontend/
│   ├── public/
│   │   └── audio-capture-worklet.js  # AudioWorklet: Float32→Int16 mic capture
│   └── src/
│       ├── pages/
│       │   ├── Dashboard.tsx
│       │   └── GeminiPage.tsx   # Gemini Live full page (browser + phone bridge)
│       ├── hooks/
│       │   └── useGeminiVoice.ts  # WS audio hook (PCM16, barge-in, transcript)
│       ├── components/
│       │   ├── AdminPanel/      # Admin tabs (models / users / settings / logs)
│       │   ├── CallInterface/   # WebRTC call controls + setup-ready modal
│       │   ├── ConfigModal/     # Customer API-key entry (encrypted at rest)
│       │   ├── CostEstimator/   # Auto-recommended server tier · concurrency
│       │   │                    #   model · editable traffic baselines
│       │   ├── MetricsPanel/    # Live STT/LLM/TTS latency + quality dots
│       │   ├── TranscriptPanel/ # Conversation transcript
│       │   ├── UltravoxCall/    # Ultravox browser call popup
│       │   └── LoginPage/
│       └── store/               # Zustand: auth · call · models · ui
├── voicebox/                    # Optional local TTS engine (profile: voicebox)
├── docker-compose.yml           # Production compose
├── docker-compose-dev.yml       # Dev compose (hot-reload, network_mode: host)
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
| WhatsApp webhook verify fails | Ensure `META_VERIFY_TOKEN` in `.env` matches exactly what you entered in Meta's webhook config. Check `docker compose logs backend`. |
| WhatsApp call rings but agent doesn't answer | Check backend logs for `pre_accept` errors. Confirm `PHONE_NUMBER_ID` and `ACCESS_TOKEN` are set correctly in `.env`. |
| FX rate not showing | Frankfurter API unreachable — badge is hidden automatically. |
| Last admin can't be disabled | By design — activate another admin account first. |
| Re-seeding clobbered an admin price edit | Won't happen: rows admins have edited get `is_seed=false` and are skipped by the reseed reconcile. Click "Reset to seed" on a row to re-adopt the seed default. |
| **Gemini page shows "API key not configured"** | User has no Google key in Config. Open **Config → Google (Gemini)** and add an API key from [Google AI Studio](https://aistudio.google.com/apikey). Admins can also set `GOOGLE_API_KEY` in `.env` as a server-level fallback. |
| Gemini WS connects then immediately disconnects | Wrong model or API version. The backend uses `gemini-3.1-flash-live-preview` on `v1alpha` — these are already hardcoded; no user action needed. If you see a `1008` close code, check that the API key has access to the Live API (requires Gemini API enabled in Google Cloud). |
| Gemini: no audio heard / mic not working | Browser must be served over HTTPS (or localhost) for `getUserMedia` to work. If testing on a remote server without HTTPS, use ngrok or add a self-signed cert. |
| Gemini barge-in / interruption not working | VAD config is already tuned (`START_SENSITIVITY_HIGH`, `silence_duration_ms=100`). If still sluggish, check your browser's mic sample rate — the worklet re-samples to 16 kHz internally. |
| **Twilio: `/twilio/token` returns 500** | One or more Twilio env vars missing. Ensure `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, and `TWILIO_TWIML_APP_SID` are all set in `.env` and the container was restarted after editing. |
| Twilio call connects then drops immediately | Check that `VITE_BACKEND_URL` is set to your public backend URL and that the TwiML App's **Voice Request URL** points to `<VITE_BACKEND_URL>/twilio/voice`. |
| Twilio Media Stream connects but no Gemini audio | Confirm `GOOGLE_API_KEY` is set in `.env`. The phone bridge always uses the server key — it does not look up per-user keys. |
| ngrok URL changed — Twilio webhook broken | Update the **Voice Request URL** in Twilio Console and the `VITE_BACKEND_URL` in `.env`, then restart the backend container (`docker compose restart backend`). |