import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, text, update

from .config import CORS_ORIGINS, ADMIN_EMAIL, ADMIN_PASSWORD
from .db import engine, SessionLocal, Base
# Import all models so SQLAlchemy registers them before create_all
from .models import User, UserRole, UserAPIKey, ModelEntry, CallSession, AdminSetting
from .gemini.models.call_log import GeminiCallLog  # noqa: F401 — register table for create_all
from .gemini.models.agent import GeminiAgent  # noqa: F401 — register table for create_all
from .gemini.models.tool import GeminiTool  # noqa: F401 — register table for create_all
from .gemini.models.kb import GeminiKbCollection, GeminiKbDocument, GeminiKbChunk  # noqa: F401
from .services.auth import hash_password
from .seed_data import SEED_MODELS, compute_profile_for
from .routes import auth, models_route, token_route, admin_route, config_routes, tts_route, fx_route, setup_route, internal_route
from .ultravox.routes import ultravox, whatsapp
from .gemini.routes import call as gemini_call, calls as gemini_calls, twilio_bridge, vobiz_bridge, tata_bridge, voice_samples, agents as gemini_agents, tools as gemini_tools_route, ambience as gemini_ambience, kb as gemini_kb_route, google_calendar as gemini_calendar
from .services import model_setup, room_config_cache

from .log_buffer import install as _install_log_buffer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
_install_log_buffer()
logger = logging.getLogger("main")


async def _migrate_schema() -> None:
    """Idempotent column adds. Postgres-only (project DB dialect)."""
    async with engine.begin() as conn:
        await conn.execute(text(
            "ALTER TABLE model_entries ADD COLUMN IF NOT EXISTS "
            "compute_profile VARCHAR(32) NOT NULL DEFAULT 'none'"
        ))
        await conn.execute(text(
            "ALTER TABLE model_entries ADD COLUMN IF NOT EXISTS "
            "min_vram_gb INTEGER"
        ))
        await conn.execute(text(
            "ALTER TABLE model_entries ADD COLUMN IF NOT EXISTS "
            "is_seed BOOLEAN NOT NULL DEFAULT TRUE"
        ))
        await conn.execute(text(
            "ALTER TABLE model_entries ADD COLUMN IF NOT EXISTS "
            "use_case VARCHAR(2000)"
        ))
        # gemini_agents.tool_ids — JSON list of tool IDs assigned to the agent.
        await conn.execute(text(
            "ALTER TABLE gemini_agents ADD COLUMN IF NOT EXISTS "
            "tool_ids JSONB NOT NULL DEFAULT '[]'::jsonb"
        ))
        # gemini_agents.ambient_* — background ambience mixed into outgoing audio.
        await conn.execute(text(
            "ALTER TABLE gemini_agents ADD COLUMN IF NOT EXISTS "
            "ambient_always VARCHAR(64)"
        ))
        await conn.execute(text(
            "ALTER TABLE gemini_agents ADD COLUMN IF NOT EXISTS "
            "ambient_tool_call VARCHAR(64)"
        ))
        await conn.execute(text(
            "ALTER TABLE gemini_agents ADD COLUMN IF NOT EXISTS "
            "ambient_volume DOUBLE PRECISION NOT NULL DEFAULT 0.15"
        ))
        # gemini_call_logs.recording_path — filename of the saved call recording.
        await conn.execute(text(
            "ALTER TABLE gemini_call_logs ADD COLUMN IF NOT EXISTS "
            "recording_path VARCHAR(255)"
        ))
        # gemini_call_logs.cost_usd / usage — estimated per-call cost + breakdown.
        await conn.execute(text(
            "ALTER TABLE gemini_call_logs ADD COLUMN IF NOT EXISTS "
            "cost_usd DOUBLE PRECISION"
        ))
        await conn.execute(text(
            "ALTER TABLE gemini_call_logs ADD COLUMN IF NOT EXISTS "
            "usage JSONB"
        ))
        # Vector similarity index on the KB chunks table — only if the
        # extension and table both exist (pgvector_enabled may be False).
        if "gemini_kb_chunks" in Base.metadata.tables:
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS gemini_kb_chunks_collection_idx "
                "ON gemini_kb_chunks (collection_id)"
            ))
            try:
                await conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS gemini_kb_chunks_embedding_hnsw "
                    "ON gemini_kb_chunks USING hnsw (embedding vector_cosine_ops)"
                ))
            except Exception:
                try:
                    await conn.execute(text(
                        "CREATE INDEX IF NOT EXISTS gemini_kb_chunks_embedding_ivf "
                        "ON gemini_kb_chunks USING ivfflat (embedding vector_cosine_ops) "
                        "WITH (lists = 100)"
                    ))
                except Exception as ie:
                    logger.warning("Could not create vector index: %s — searches will be slow.", ie)
        # Agents pick which KB collections they can query.
        await conn.execute(text(
            "ALTER TABLE gemini_agents ADD COLUMN IF NOT EXISTS "
            "kb_collection_ids JSONB NOT NULL DEFAULT '[]'::jsonb"
        ))
        # gemini_agents.first_message — greeting the agent speaks on connect.
        await conn.execute(text(
            "ALTER TABLE gemini_agents ADD COLUMN IF NOT EXISTS "
            "first_message TEXT"
        ))
        # gemini_call_logs — post-call AI analysis fields (summary/sentiment/extraction).
        await conn.execute(text(
            "ALTER TABLE gemini_call_logs ADD COLUMN IF NOT EXISTS summary TEXT"
        ))
        await conn.execute(text(
            "ALTER TABLE gemini_call_logs ADD COLUMN IF NOT EXISTS sentiment VARCHAR(16)"
        ))
        await conn.execute(text(
            "ALTER TABLE gemini_call_logs ADD COLUMN IF NOT EXISTS extracted JSONB"
        ))
        # gemini_call_logs.end_reason — categorized disconnect reason for the calls UI
        # (COMPLETED | CLIENT_DISCONNECTED | AGENT_ENDED | NETWORK_ISSUE | MODEL_ERROR | INTERNAL_ERROR).
        await conn.execute(text(
            "ALTER TABLE gemini_call_logs ADD COLUMN IF NOT EXISTS end_reason VARCHAR(32)"
        ))


async def reconcile_seed_models(db) -> dict:
    """Upsert SEED_MODELS into the DB and soft-disable seed rows that have
    been removed from the seed file. Preserves admin edits (rows where
    is_seed=False are left untouched).

    Returns counts: {"added": [...], "updated": [...], "disabled": [...]}.
    """
    added, updated, disabled = [], [], []

    seed_keys = set()
    for row in SEED_MODELS:
        model_type, provider, model_id, label, price_per_hour, config, sort_order = row
        seed_keys.add((provider, model_id))
        profile, vram = compute_profile_for(provider, config)

        result = await db.execute(
            select(ModelEntry).where(
                ModelEntry.provider == provider,
                ModelEntry.model_id == model_id,
            )
        )
        existing = result.scalar_one_or_none()

        if existing is None:
            db.add(ModelEntry(
                model_type=model_type,
                provider=provider,
                model_id=model_id,
                label=label,
                price_per_hour=price_per_hour,
                config=config,
                sort_order=sort_order,
                compute_profile=profile,
                min_vram_gb=vram,
                is_seed=True,
            ))
            added.append(f"{provider}/{model_id}")
            continue

        if not existing.is_seed:
            # Admin owns this row — don't touch.
            continue

        changed = False
        for attr, val in (
            ("model_type", model_type),
            ("label", label),
            ("price_per_hour", price_per_hour),
            ("config", config),
            ("sort_order", sort_order),
            ("compute_profile", profile),
            ("min_vram_gb", vram),
        ):
            if getattr(existing, attr) != val:
                setattr(existing, attr, val)
                changed = True
        if changed:
            updated.append(f"{provider}/{model_id}")

    # Soft-disable rows that *were* seed-managed but no longer appear in seeds.
    # Skip dynamic providers (ollama/voicebox) — those are managed by
    # `services.model_sync` and `routes.models_route` from runtime introspection,
    # not from SEED_MODELS, so they're never expected to match the seed file.
    DYNAMIC_PROVIDERS = {"ollama", "voicebox"}
    result = await db.execute(
        select(ModelEntry).where(ModelEntry.is_seed == True, ModelEntry.enabled == True)  # noqa: E712
    )
    for row in result.scalars():
        if row.provider in DYNAMIC_PROVIDERS:
            continue
        if (row.provider, row.model_id) not in seed_keys:
            row.enabled = False
            disabled.append(f"{row.provider}/{row.model_id}")

    return {"added": added, "updated": updated, "disabled": disabled}


async def _seed_database() -> None:
    async with SessionLocal() as db:
        # Admin user
        result = await db.execute(select(User).where(User.email == ADMIN_EMAIL))
        existing_admin = result.scalar_one_or_none()
        if not existing_admin:
            admin_user = User(
                email=ADMIN_EMAIL,
                password_hash=hash_password(ADMIN_PASSWORD),
                role=UserRole.admin,
                is_active=True,
            )
            db.add(admin_user)
            logger.info(f"Seeded admin user: {ADMIN_EMAIL}")
        elif not existing_admin.is_active:
            existing_admin.is_active = True
            logger.info(f"Re-activated admin user: {ADMIN_EMAIL}")

        # Default settings — only inserted if missing, never overwritten on
        # restart so admin tweaks survive.
        default_settings = [
            ("call_limit_seconds", "60"),
            ("max_concurrent_calls_per_user", "2"),
            ("max_calls_per_day_per_user", "50"),
        ]
        for key, value in default_settings:
            result = await db.execute(
                select(AdminSetting).where(AdminSetting.key == key)
            )
            if not result.scalar_one_or_none():
                db.add(AdminSetting(key=key, value=value))

        summary = await reconcile_seed_models(db)
        await db.commit()
        if summary["added"] or summary["updated"] or summary["disabled"]:
            logger.info(
                "Seed reconcile — added=%d updated=%d disabled=%d",
                len(summary["added"]), len(summary["updated"]), len(summary["disabled"]),
            )
        logger.info("Database seeding complete")


async def _ensure_pgvector() -> bool:
    """Try to install the pgvector extension. If unavailable, drop KB tables
    from the metadata so the rest of the app can still boot."""
    async with engine.begin() as conn:
        try:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            return True
        except Exception as e:
            logger.warning(
                "pgvector extension not available (%s). "
                "Knowledge-base features will be DISABLED. To enable, install pgvector "
                "on the Postgres host: `apt install postgresql-16-pgvector` (match your PG version), "
                "then restart the backend.", e,
            )
    # Strip KB tables from create_all so VECTOR(768) is never emitted.
    for tbl_name in ("gemini_kb_chunks", "gemini_kb_documents", "gemini_kb_collections"):
        tbl = Base.metadata.tables.get(tbl_name)
        if tbl is not None:
            Base.metadata.remove(tbl)
    return False


@asynccontextmanager
async def lifespan(app: FastAPI):
    pgvector_ok = await _ensure_pgvector()
    app.state.pgvector_enabled = pgvector_ok
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _migrate_schema()
    await _seed_database()
    from .gemini.services.agents_store import seed_builtin_agents
    from .gemini.services.tools_runtime import seed_builtin_tools
    await seed_builtin_agents()
    await seed_builtin_tools()
    # Make sure the LiveKit turn-detector model is available; download in
    # background if missing so the API stays responsive.
    await model_setup.ensure_downloaded_in_background()
    sweeper_task = asyncio.create_task(room_config_cache.run_sweeper())
    try:
        yield
    finally:
        sweeper_task.cancel()
        try:
            await sweeper_task
        except (asyncio.CancelledError, Exception):
            pass
        await engine.dispose()


app = FastAPI(title="AI Voice Cost Calculator", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
)

app.include_router(auth.router,          prefix="/api/auth",   tags=["auth"])
app.include_router(models_route.router,  prefix="/api",        tags=["models"])
app.include_router(token_route.router,   prefix="/api",        tags=["token"])
app.include_router(admin_route.router,   prefix="/api/admin",  tags=["admin"])
app.include_router(config_routes.router, prefix="/api/config", tags=["config"])
app.include_router(tts_route.router,     prefix="/api",        tags=["tts"])
app.include_router(fx_route.router,      prefix="/api",        tags=["fx"])
app.include_router(setup_route.router,   prefix="/api/setup",  tags=["setup"])
# Internal endpoints — agent worker only, NOT for browser use.
# Protected by X-Internal-Secret header inside the route.
app.include_router(internal_route.router, prefix="/internal", tags=["internal"])
app.include_router(ultravox.router,       prefix="/api/ultravox",  tags=["ultravox"])
app.include_router(whatsapp.router,       prefix="/api/whatsapp",  tags=["whatsapp"])
app.include_router(gemini_call.router,    prefix="/api/gemini",    tags=["gemini"])
app.include_router(twilio_bridge.router,  prefix="/api/twilio",    tags=["twilio"])
app.include_router(vobiz_bridge.router,   prefix="/api/vobiz",     tags=["vobiz"])
app.include_router(tata_bridge.router,    prefix="/api/tata",      tags=["tata"])
app.include_router(gemini_calls.router,   prefix="/api/gemini-calls", tags=["gemini-calls"])
app.include_router(voice_samples.router,  prefix="/api/voice-samples", tags=["voice-samples"])
app.include_router(gemini_agents.router,  prefix="/api/agents", tags=["agents"])
app.include_router(gemini_tools_route.router, prefix="/api/tools", tags=["tools"])
app.include_router(gemini_ambience.router, prefix="/api/ambience", tags=["ambience"])
app.include_router(gemini_kb_route.router, prefix="/api/kb", tags=["kb"])
app.include_router(gemini_calendar.router, prefix="/api/google-calendar", tags=["google-calendar"])


@app.get("/health")
def health():
    return {"ok": True, "service": "ai-voice-cost-calculator"}
