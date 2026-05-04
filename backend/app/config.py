import os
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(dotenv_path=ROOT / ".env", override=False)


def _require(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        raise ValueError(f"Required environment variable {key} is not set")
    return val


# Postgres connection — defaults target the host's system-installed Postgres
# (user `postgres`, password `password`, db `voiceagent`). Override via .env
# or DATABASE_URL directly. Inside docker-compose, POSTGRES_HOST defaults to
# `host.docker.internal` so the backend container reaches the host DB.
_PG_USER = os.environ.get("POSTGRES_USER", "postgres")
_PG_PASS = os.environ.get("POSTGRES_PASSWORD", "password")
_PG_HOST = os.environ.get("POSTGRES_HOST", "localhost")
_PG_PORT = os.environ.get("POSTGRES_PORT", "5432")
_PG_DB = os.environ.get("POSTGRES_DB", "voiceagent")
DATABASE_URL: str = os.environ.get(
    "DATABASE_URL",
    f"postgresql+asyncpg://{_PG_USER}:{_PG_PASS}@{_PG_HOST}:{_PG_PORT}/{_PG_DB}",
)
SECRET_KEY: str = os.environ.get("SECRET_KEY", "dev-secret-key-change-in-production")
FERNET_KEY: str = os.environ.get(
    "FERNET_KEY", "***REMOVED***"
)
# Internal URL the backend itself uses to talk to LiveKit.
LIVEKIT_URL: str = os.environ.get("LIVEKIT_URL", "ws://localhost:7880")
# Public URL handed back to the browser for WebRTC; falls back to LIVEKIT_URL
# when running natively. In compose, this is set to ws://localhost:${LIVEKIT_PORT}.
LIVEKIT_PUBLIC_URL: str = os.environ.get("LIVEKIT_PUBLIC_URL", LIVEKIT_URL)
LIVEKIT_API_KEY: str = os.environ.get("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET: str = os.environ.get("LIVEKIT_API_SECRET", "secret")
OLLAMA_URL: str = os.environ.get("OLLAMA_URL", "http://localhost:11434")
VOICEBOX_URL: str = os.environ.get("VOICEBOX_URL", "http://localhost:17493")
PIPER_URL: str = os.environ.get("PIPER_URL", "http://localhost:8200/v1")
CORS_ORIGINS: list[str] = os.environ.get(
    "CORS_ORIGINS", "http://localhost:3000,http://localhost:5173"
).split(",")
ADMIN_EMAIL: str = os.environ.get("ADMIN_EMAIL", "***REMOVED***")
ADMIN_PASSWORD: str = os.environ.get("ADMIN_PASSWORD", "***REMOVED***")
JWT_EXPIRY_HOURS: int = int(os.environ.get("JWT_EXPIRY_HOURS", "24"))

# Shared secret used by the agent to fetch per-room config (including the
# user's API keys) over the internal HTTP channel. Keys never enter the
# LiveKit JWT or the browser; the agent reads them server-to-server.
INTERNAL_AGENT_SECRET: str = os.environ.get(
    "INTERNAL_AGENT_SECRET", "dev-internal-agent-secret-change-in-production"
)
# How long the room-config cache entry lives before being evicted. Entries
# are also evicted on first read (single-use), so this is just the upper
# bound for an unclaimed room (e.g. user clicked Start Call but never
# connected).
ROOM_CONFIG_TTL_SECONDS: int = int(os.environ.get("ROOM_CONFIG_TTL_SECONDS", "300"))
