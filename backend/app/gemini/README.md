# Gemini Live Voice Agent

This package is a real-time voice-agent platform built on Google's **Gemini Live**
API. A single agent definition (prompt + voice + language + tools + knowledge
bases + background ambience) drives three independent entry points:

| Entry point | Transport | Who initiates | Route |
|-------------|-----------|---------------|-------|
| **Browser Voice** | Mic → WebSocket | User clicks "Start" in the web UI | `/api/gemini/ws` |
| **Twilio Bridge** | PSTN phone → Twilio Media Streams | Caller dials a Twilio number (inbound) | `/api/twilio/stream` |
| **Vobiz Bridge** | PSTN phone → Vobiz (Plivo-style) | Inbound *or* outbound (we dial them) | `/api/vobiz/stream` |

All three converge on **one Gemini Live session per call** and reuse the same
tool-dispatch, knowledge-base, ambience, and call-logging machinery.

> **Why a backend proxy at all?** The browser never talks to Gemini directly:
> the API key would leak, tool calls couldn't run, and ambient mixing / logging /
> reconnects would be impossible. The backend is the only safe place to hold the
> key and execute side-effects. See "Why the proxy" at the bottom.

---

## 1. Directory map

```
gemini/
├── README.md                 ← you are here
├── agents.py                 # DEFAULT_PHONE_AGENT + built-in prompt strings
├── agent_tools.py            # Python builtin tool fns (e.g. get_doctors_by_department)
│
├── routes/                   # FastAPI routers (mounted under /api/* in main.py)
│   ├── call.py               #   /api/gemini/ws    — browser WebSocket bridge
│   ├── twilio_bridge.py      #   /api/twilio/*     — Twilio voice + media stream
│   ├── vobiz_bridge.py       #   /api/vobiz/*      — Vobiz answer webhook + stream + outbound /call
│   ├── calls.py              #   /api/gemini-calls — paginated call history + transcripts
│   ├── agents.py             #   /api/agents       — agent CRUD
│   ├── tools.py              #   /api/tools        — tool CRUD + test
│   ├── ambience.py           #   /api/ambience     — ambient catalogue + WAV preview
│   ├── kb.py                 #   /api/kb           — knowledge-base CRUD + upload + search
│   └── voice_samples.py      #   /api/voice-samples— per-voice WAV samples
│
├── services/
│   ├── tools_runtime.py      # build Gemini FunctionDeclarations + dispatch_tool_call()
│   ├── agents_store.py       # seed built-in agents, resolve default phone agent
│   └── logger.py             # start_call / add_transcript / end_call → gemini_call_logs
│
├── ambience/                 # background-sound mixing
│   ├── registry.py           # catalogue of ambient slugs (office, cafe, typing, …)
│   ├── synth.py              # procedural PCM generators (no asset files needed)
│   ├── mixer.py              # AmbientMixer — loops + mixes PCM into outgoing audio
│   └── assets/               # optional real WAVs override the procedural sound
│
├── kb/                       # knowledge base (RAG)
│   ├── extract.py            # PDF (PyMuPDF) / TXT / MD → text per page
│   ├── chunking.py           # word-window chunker with overlap
│   ├── embeddings.py         # gemini-embedding-001 → 768-dim normalized vectors
│   ├── pipeline.py           # background ingest: extract → chunk → embed → insert
│   └── search.py             # pgvector cosine similarity query
│
└── models/                   # SQLAlchemy tables
    ├── agent.py              # gemini_agents
    ├── tool.py               # gemini_tools
    ├── call_log.py           # gemini_call_logs
    └── kb.py                 # gemini_kb_collections / _documents / _chunks (VECTOR(768))
```

---

## 2. The core call flow (browser)

```
┌─────────┐   PCM16 16kHz (mic)      ┌──────────────┐   PCM16 16kHz     ┌──────────────┐
│ Browser │ ───────────────────────▶ │  FastAPI     │ ────────────────▶ │  Gemini Live │
│ mic +   │                          │  /gemini/ws  │                   │  WebSocket   │
│ speaker │ ◀─────────────────────── │  (call.py)   │ ◀──────────────── │  API         │
└─────────┘   PCM16 24kHz (speech)   └──────┬───────┘   PCM16 24kHz     └──────────────┘
                                            │
                       ┌────────────────────┼─────────────────────┐
                       ▼                     ▼                      ▼
                 AmbientMixer         dispatch_tool_call      logger (DB)
                 (mix bg audio)       (HTTP / Python / KB)    transcripts
```

### Step by step (`routes/call.py`)

1. **Handshake.** Browser opens `wss://<host>/api/gemini/ws?token=<JWT>`.
   The JWT is decoded server-side (`_resolve_api_key`) → identifies the user →
   loads *their* stored Google API key (admins fall back to the server key).
   No key ⇒ the socket closes with `no_api_key`.

2. **Config message.** The first text frame is JSON:
   ```json
   {
     "type": "config",
     "system_prompt": "...", "language": "en", "voice": "Aoede",
     "tool_ids": [1,2], "kb_collection_ids": [3],
     "ambient_always": "office_busy", "ambient_tool_call": "typing",
     "ambient_volume": 0.15
   }
   ```

3. **Session open.** `build_gemini_tools(tool_ids, kb_collection_ids)` builds the
   tool declarations and `client.aio.live.connect(...)` opens the Gemini session
   with voice / language / system-prompt / tools baked into `LiveConnectConfig`.

4. **Two pumps run concurrently:**
   - `frontend_to_gemini`: binary mic frames → `session.send_realtime_input(...)`.
   - `gemini_to_frontend`: `session.receive()` → audio frames (mixed, see §3) +
     transcripts + tool calls (see §4) → browser.

5. **Transparent reconnect.** Preview models (`gemini-3.1-flash-live-preview`)
   drop with code 1006 roughly every turn. The outer loop silently re-opens the
   Gemini session **without** closing the browser socket — the caller hears at
   most a ~300 ms pause.

6. **Logging.** `start_call` on connect, `add_transcript` per turn, `end_call`
   in `finally` → row in `gemini_call_logs`, visible under the Calls page.

Audio formats: **mic = PCM16 @ 16 kHz**, **speech = PCM16 @ 24 kHz**.

---

## 3. Background ambience

Ambience makes the agent sound like it's in a real environment (busy office,
cafe, call-center) and masks the silent gap during tool calls (typing, clicks).

```
Gemini speech PCM ─┐
                   ├─▶ always_mixer.mix() ─▶ (browser)  /  ─▶ 24→8kHz μ-law ─▶ (phone)
ambient loop PCM ──┘     (adds bg under voice)
```

### Two modes (per agent)

- **`ambient_always`** — a soft loop under the *entire* conversation
  (office hum, cafe, elevator music). Volume `ambient_volume` (0–1, default 0.15).
- **`ambient_tool_call`** — plays **only during a tool call**, so the otherwise
  silent dispatch gap is filled with typing / mouse-clicks / "processing" beeps.

### How mixing works (`ambience/mixer.py`)

- `AmbientMixer(slug, target_rate, volume)` loads a looped PCM16 buffer at the
  call's sample rate (24 kHz internally for all transports), then `.mix(voice)`
  adds `ambient * volume` to each outgoing frame via `audioop.add` (saturating).
- The loop pointer is per-session, so the seam stays inaudible across chunks.
- **Source priority:** a real WAV at `ambience/assets/{slug}.wav` overrides the
  built-in procedural generator in `synth.py`. Drop in real loops anytime.

### Tool-call filler

During a `tool_call`, Gemini sends no audio. Each route starts a **filler task**
that emits 40 ms ambient-only frames (`always` + `tool_call` mixed) on a steady
cadence, then **cancels the instant** Gemini's next real audio frame arrives —
so the agent's voice is never clobbered.

### Phone transports

Twilio/Vobiz mix into **24 kHz PCM first**, *then* the existing 24 kHz → 8 kHz
μ-law downsample runs — so one mixer covers every transport identically.

Catalogue + 5 s WAV preview: `GET /api/ambience/` and
`GET /api/ambience/preview/{slug}.wav`.

---

## 4. Tool calling

Tools let the agent call external HTTP APIs or built-in Python functions
mid-conversation. The LLM decides *when*; we execute and feed the result back.

```
Gemini ──tool_call(name,args)──▶ dispatch_tool_call(tool_ids, name, args, kb_ids)
                                       │
            ┌──────────────────────────┼───────────────────────────┐
            ▼                          ▼                            ▼
   name == search_knowledge_base   DB tool (gemini_tools)     Python builtin
       → KB vector search          ├─ url set → HTTP call      (agent_tools.py
       (see §5)                    └─ no url  → Python builtin   TOOL_REGISTRY)
                                       │
                                       ▼
                          result dict ──send_tool_response()──▶ Gemini continues
```

### Resolution order (`services/tools_runtime.py` → `dispatch_tool_call`)

1. **`search_knowledge_base`** — synthetic built-in, only registered when the
   agent has `kb_collection_ids`. Runs a pgvector search (§5).
2. **DB tool** matching the slug in `gemini_tools`:
   - has a **URL** → HTTP request (`GET` → query string, `POST/…` → JSON body),
     response parsed as JSON (non-JSON wrapped as `{status:"ok", raw:…}`).
   - **no URL** (built-in) → look up the Python fn in `agent_tools.TOOL_REGISTRY`.
3. **Python fallback** — direct registry lookup if the slug isn't in the DB.

### How the LLM "sees" a tool

`build_gemini_tools()` converts each `gemini_tools` row into a Gemini
`FunctionDeclaration`: parameter schema from the row's `parameters`, and the
declared **response keys** appended to the description so the model knows the
shape of what comes back. Built-in tools can have a URL set to switch them from
Python to HTTP dispatch without code changes.

---

## 5. Knowledge base (RAG)

Lets an agent answer from uploaded documents (PDF / TXT / MD / pasted text)
using semantic search. Storage is **pgvector inside the existing Postgres** — no
extra service.

### Tables (`models/kb.py`)

```
gemini_kb_collections   id, slug, name, chunk_size, chunk_overlap, counts…
gemini_kb_documents     id, collection_id, source, filename, status, raw_bytes/raw_text…
gemini_kb_chunks        id, document_id, collection_id, content, embedding VECTOR(768)
                        └─ HNSW index on embedding (vector_cosine_ops)
```
Agents link via `gemini_agents.kb_collection_ids` (JSON list).

### Ingestion (background) — `kb/pipeline.py`

```
upload (file or text)                 status: pending
   │
   ▼  ingest_document() runs as a FastAPI BackgroundTask
extract  (PyMuPDF / decode)           status: processing
   │     PDF keeps per-page numbers for citation
   ▼
chunk    (word-window + overlap)      kb/chunking.py
   │
   ▼
embed    (gemini-embedding-001,       kb/embeddings.py
   │      output_dimensionality=768, L2-normalized)
   ▼
insert   chunk rows w/ embeddings     status: ready  (or failed + error)
```
The UI polls the documents list while any doc is `pending`/`processing`.

### Retrieval at call time

```
caller asks something
   │
Gemini fires  search_knowledge_base(query)
   │
embed query → 768-dim vector  (1 embed API call, ~50 ms)
   │
SELECT … ORDER BY embedding <=> :qvec  LIMIT 5      (kb/search.py)
   WHERE collection_id = ANY(agent.kb_collection_ids)
   │
top-k chunks (content + filename + page + score) ──▶ Gemini speaks the answer
```

- Distance operator `<=>` is **cosine**; score returned as `1 - distance`.
- The tool response returns up to ~6000 chars per chunk so a full section
  reaches the model (truncating too hard drops the actual answer).
- Tune precision per collection via `chunk_size` / `chunk_overlap` (smaller =
  more focused chunks); re-index documents after changing.

> **Embedding model note:** uses `gemini-embedding-001` truncated to 768 dims to
> match the column. `text-embedding-004` is *not* available on all keys.

---

## 6. Twilio bridge

Inbound PSTN calls to a Twilio number.

```
Caller (PSTN) ──dials──▶ Twilio ──POST /api/twilio/voice──▶ FastAPI
                                                              │ returns TwiML:
                                                              │ <Connect><Stream
                                                              │   url="wss://…/api/twilio/stream"/>
                                                              ▼
Caller ◀── μ-law 8kHz ──▶ Twilio Media Streams ◀──WS──▶ /api/twilio/stream
                                                              │
                              decode μ-law 8k → PCM16 16k ───▶ Gemini Live
                              PCM16 24k → mix ambient → μ-law 8k ◀── Gemini
```

- The agent used is the **default phone agent** (`is_default_phone=true`,
  resolved by `agents_store.get_default_phone_agent`); falls back to the env
  `PHONE_SYSTEM_PROMPT` / `DEFAULT_PHONE_AGENT`.
- `/api/twilio/config` returns the URLs (and `TWILIO_PHONE_NUMBER`) to paste into
  the Twilio console; `/api/twilio/token` issues a browser Voice-SDK JWT for the
  in-page dialer.
- Same tool dispatch, KB, ambient, reconnect, and logging as the browser path.

---

## 7. Vobiz bridge

Vobiz is a Plivo-compatible voice API supporting **inbound and outbound**.

### Outbound (we call them) — `POST /api/vobiz/call`

```
POST /api/vobiz/call {to, system_prompt?, voice?, tool_ids?, kb_collection_ids?, ambient_*?}
   │
   ├─ store overrides in CALL_CONFIGS[cfg_id]  (in-memory, 1h TTL)
   │
   └─ POST api.vobiz.ai …/Call/  with answer_url = https://<host>/api/vobiz/voice?cfg=<id>
        │
        ▼  recipient answers → Vobiz hits answer_url
   GET/POST /api/vobiz/voice?cfg=<id>  → returns XML <Stream wss://…/api/vobiz/stream?cfg=<id>>
        │
        ▼
   WS /api/vobiz/stream?cfg=<id>  → pops CALL_CONFIGS[cfg] → opens Gemini session
```

### Inbound

If a call arrives with **no `cfg`**, the bridge falls back to the **default phone
agent** (same as Twilio).

### Audio + features

```
Caller ◀─ μ-law 8kHz ─▶ Vobiz ◀──WS (playAudio / media events)──▶ /api/vobiz/stream
                                  decode μ-law 8k → PCM16 16k → Gemini
                                  Gemini PCM16 24k → mix ambient → μ-law 8k → playAudio
```

- Per-call config (`CALL_CONFIGS`) carries prompt, voice, language, `tool_ids`,
  `kb_collection_ids`, and ambient settings so each outbound call can differ.
- Barge-in: caller interrupting flushes Vobiz's playback queue (`clearAudio`).
- Same tool dispatch, KB, ambient filler, and logging as the other paths.

Required env: `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_PHONE_NUMBER`. The
answer / stream / transfer URLs that Vobiz must reach are built from the public
host: `VITE_BACKEND_URL` when set, otherwise the inbound request host. (Inside
the WebSocket handler the socket's own host is the internal container address,
so `VITE_BACKEND_URL` is what makes the webhook URLs externally reachable.)
Optional: `HUMAN_AGENT_NUMBER` — default number the `transfer_call` tool hands
off to (a per-call `transfer_number` on `/api/vobiz/call` overrides it).

---

## 8. Agents — the unifying config

Every entry point resolves an **agent** (`gemini_agents` row) that bundles:

| Field | Used for |
|-------|----------|
| `system_prompt`, `language`, `voice` | the Gemini Live session config |
| `tool_ids` | which `gemini_tools` the LLM may call |
| `kb_collection_ids` | which KB collections `search_knowledge_base` queries |
| `ambient_always`, `ambient_tool_call`, `ambient_volume` | background sound |
| `is_default_phone` | the agent used for inbound Twilio/Vobiz calls (exactly one) |
| `is_builtin` | seeded agent — name/delete locked, everything else editable |

- **Browser** sends the chosen agent's config in the WS `config` message.
- **Outbound Vobiz** sends it in the `/call` body.
- **Inbound phone** uses the default phone agent from the DB.

---

## 9. Why the backend proxy (not browser → Gemini direct)

1. **API key safety** — Gemini Live auth is the key in the URL; in the browser it
   leaks via devtools, extensions, proxies. Server-side it never leaves.
2. **Tool execution** — tool calls need DB access + service credentials + server
   HTTP; impossible from the browser.
3. **Per-user gating** — the JWT is decoded server-side to pick the user's key,
   enforce role, and log the call.
4. **Ambient mixing + KB search** — run in Python on the server.
5. **Transparent reconnects** — preview-model 1006 drops are hidden from the user.
6. **One code path** for browser + Twilio + Vobiz.

Added round-trip latency is ~20–40 ms — inaudible in a voice call.

---

## 10. Key environment variables

| Var | Purpose |
|-----|---------|
| `GOOGLE_API_KEY` | server Gemini key (admins / embeddings / phone calls) |
| `GEMINI_LIVE_MODEL` | Live model (default `gemini-3.1-flash-live-preview`) |
| `KB_EMBED_MODEL` | embedding model (default `gemini-embedding-001`) |
| `TWILIO_ACCOUNT_SID/API_KEY/API_SECRET/TWIML_APP_SID/PHONE_NUMBER` | Twilio |
| `VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN / VOBIZ_PHONE_NUMBER` | Vobiz |
| `VITE_BACKEND_URL` | public backend host used to build Vobiz answer/stream/transfer webhook URLs (falls back to the request host) |
| `HUMAN_AGENT_NUMBER` | default human-agent number for the `transfer_call` warm-transfer tool |
| `PHONE_SYSTEM_PROMPT`, `PHONE_LANGUAGE` | inbound-phone fallback agent |

**pgvector prerequisite:** the KB needs the `vector` extension on Postgres
(`apt install postgresql-16-pgvector`, then the backend runs `CREATE EXTENSION`
on boot). If it's missing, the app boots fine but KB features are disabled.
