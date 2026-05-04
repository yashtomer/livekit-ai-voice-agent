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
from .services.auth import hash_password
from .seed_data import SEED_MODELS, compute_profile_for
from .routes import auth, models_route, token_route, admin_route, config_routes, tts_route, fx_route, setup_route, internal_route
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _migrate_schema()
    await _seed_database()
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


@app.get("/health")
def health():
    return {"ok": True, "service": "ai-voice-cost-calculator"}
