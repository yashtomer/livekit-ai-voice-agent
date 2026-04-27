from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete as sa_delete
from ..db import get_db
from ..models.model_entry import ModelEntry
from ..models.admin_setting import AdminSetting
from ..models.user import User, UserRole
from ..schemas.model import ModelEntryCreate, ModelEntryUpdate, ModelEntryResponse
from ..services.model_sync import sync_models
from ..services.auth import hash_password
from ..seed_data import SEED_MODELS, compute_profile_for
from .auth import require_admin
from .. import log_buffer
from pydantic import BaseModel

router = APIRouter()


class SettingUpdate(BaseModel):
    value: str


class UserCreate(BaseModel):
    email: str
    password: str
    role: str = "customer"


class UserUpdate(BaseModel):
    role: str | None = None
    is_active: bool | None = None


@router.get("/models", response_model=list[ModelEntryResponse])
async def list_all_models(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(ModelEntry).order_by(ModelEntry.sort_order))
    return [ModelEntryResponse.model_validate(m) for m in result.scalars().all()]


@router.post("/models", response_model=ModelEntryResponse, status_code=201)
async def create_model(
    data: ModelEntryCreate,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    entry = ModelEntry(**data.model_dump())
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return ModelEntryResponse.model_validate(entry)


@router.patch("/models/{model_id}", response_model=ModelEntryResponse)
async def update_model(
    model_id: int,
    data: ModelEntryUpdate,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(ModelEntry).where(ModelEntry.id == model_id))
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Model not found")
    payload = data.model_dump(exclude_none=True)
    # Any meaningful field change makes this row admin-owned, so future
    # re-seeds don't clobber it. Toggling `enabled` alone doesn't transfer
    # ownership — admins routinely disable seed rows.
    owning_keys = {"label", "price_per_hour", "config", "compute_profile", "min_vram_gb", "sort_order"}
    if entry.is_seed and (payload.keys() & owning_keys):
        entry.is_seed = False
    for key, value in payload.items():
        setattr(entry, key, value)
    await db.commit()
    await db.refresh(entry)
    return ModelEntryResponse.model_validate(entry)


@router.post("/models/{model_id}/reset_to_seed", response_model=ModelEntryResponse)
async def reset_to_seed(
    model_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Re-apply seed values to a row and mark it seed-managed again."""
    result = await db.execute(select(ModelEntry).where(ModelEntry.id == model_id))
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Model not found")

    seed_row = next(
        (r for r in SEED_MODELS if r[1] == entry.provider and r[2] == entry.model_id),
        None,
    )
    if not seed_row:
        raise HTTPException(
            status_code=400,
            detail="No matching seed entry — this row was created by an admin and has no seed default.",
        )

    model_type, provider, mid, label, price_per_hour, config, sort_order = seed_row
    profile, vram = compute_profile_for(provider, config)
    entry.model_type = model_type
    entry.label = label
    entry.price_per_hour = price_per_hour
    entry.config = config
    entry.sort_order = sort_order
    entry.compute_profile = profile
    entry.min_vram_gb = vram
    entry.is_seed = True
    await db.commit()
    await db.refresh(entry)
    return ModelEntryResponse.model_validate(entry)


@router.delete("/models/{model_id}", status_code=204)
async def delete_model(
    model_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(sa_delete(ModelEntry).where(ModelEntry.id == model_id))
    await db.commit()


@router.post("/sync")
async def sync(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    # Re-run seed reconcile (picks up edits to seed_data.py without restart),
    # then refresh dynamic Ollama models.
    from ..main import reconcile_seed_models
    seed_summary = await reconcile_seed_models(db)
    await db.commit()
    ollama = await sync_models(db)
    return {
        "added": [f"seed: {x}" for x in seed_summary["added"]] + [f"ollama: {x}" for x in ollama["added"]],
        "updated": [f"seed: {x}" for x in seed_summary["updated"]] + [f"ollama: {x}" for x in ollama["updated"]],
        "disabled": [f"seed: {x}" for x in seed_summary["disabled"]],
        "errors": ollama["errors"],
    }


class OllamaPullRequest(BaseModel):
    model: str


class VoiceboxAddPresetRequest(BaseModel):
    engine: str
    voice_id: str
    name: str | None = None
    language: str = "en"


@router.post("/ollama/pull")
async def ollama_pull(
    body: OllamaPullRequest,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Trigger an Ollama model pull, then re-sync the catalog so the new model
    appears in the admin grid."""
    import httpx
    from ..config import OLLAMA_URL

    name = body.model.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Model name required.")

    try:
        async with httpx.AsyncClient(timeout=600.0) as c:
            r = await c.post(f"{OLLAMA_URL}/api/pull", json={"name": name, "stream": False})
            if r.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"Ollama pull failed: {r.text[:200]}")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach Ollama at {OLLAMA_URL}: {e}")

    summary = await sync_models(db)
    return {
        "message": f"Pulled {name}. Sync added {len(summary['added'])} / updated {len(summary['updated'])}.",
        "sync": summary,
    }


# ── Voicebox proxies ────────────────────────────────────────────────────────
# Voicebox runs on a private port (127.0.0.1 only). Proxying through the
# backend keeps the host port off the public surface AND avoids CORS hassles.

VOICEBOX_PRESET_ENGINES = ["kokoro", "qwen_custom_voice"]


async def _voicebox_request(method: str, path: str, **kw):
    import httpx
    from ..config import VOICEBOX_URL
    try:
        async with httpx.AsyncClient(timeout=15.0) as c:
            r = await c.request(method, f"{VOICEBOX_URL}{path}", **kw)
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail=r.text[:300])
            return r.json() if r.content else None
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Voicebox unreachable at {VOICEBOX_URL}: {e}")


@router.get("/voicebox/profiles")
async def voicebox_list_profiles(_admin: User = Depends(require_admin)):
    return await _voicebox_request("GET", "/profiles")


@router.get("/voicebox/presets")
async def voicebox_list_all_presets(_admin: User = Depends(require_admin)):
    """List preset voices across every engine that supports them."""
    out = {}
    for engine in VOICEBOX_PRESET_ENGINES:
        try:
            out[engine] = await _voicebox_request("GET", f"/profiles/presets/{engine}")
        except HTTPException:
            out[engine] = {"engine": engine, "voices": [], "error": "unavailable"}
    return {"engines": out}


@router.post("/voicebox/profiles")
async def voicebox_add_preset(
    body: VoiceboxAddPresetRequest,
    _admin: User = Depends(require_admin),
):
    """Add a Voicebox profile from a built-in preset voice."""
    if body.engine not in VOICEBOX_PRESET_ENGINES:
        raise HTTPException(status_code=400, detail=f"Engine must be one of {VOICEBOX_PRESET_ENGINES}")
    payload = {
        "name": body.name or body.voice_id,
        "language": body.language,
        "voice_type": "preset",
        "preset_engine": body.engine,
        "preset_voice_id": body.voice_id,
        "default_engine": body.engine,
    }
    return await _voicebox_request("POST", "/profiles", json=payload)


@router.delete("/voicebox/profiles/{profile_id}")
async def voicebox_delete_profile(
    profile_id: str,
    _admin: User = Depends(require_admin),
):
    return await _voicebox_request("DELETE", f"/profiles/{profile_id}")


@router.get("/settings")
async def get_settings(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(AdminSetting))
    return {s.key: s.value for s in result.scalars().all()}


@router.patch("/settings/{key}")
async def update_setting(
    key: str,
    body: SettingUpdate,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(AdminSetting).where(AdminSetting.key == key))
    setting = result.scalar_one_or_none()
    if not setting:
        setting = AdminSetting(key=key, value=body.value)
        db.add(setting)
    else:
        setting.value = body.value
    await db.commit()
    return {"key": key, "value": body.value}


@router.get("/users")
async def list_users(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User))
    return [
        {"id": u.id, "email": u.email, "role": u.role, "is_active": u.is_active}
        for u in result.scalars().all()
    ]


@router.post("/users", status_code=201)
async def create_user(
    data: UserCreate,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import select as sa_select
    result = await db.execute(sa_select(User).where(User.email == data.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already exists")
    role = UserRole(data.role) if data.role in ("admin", "customer") else UserRole.customer
    user = User(
        email=data.email,
        password_hash=hash_password(data.password),
        role=role,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return {"id": user.id, "email": user.email, "role": user.role}


@router.patch("/users/{user_id}")
async def update_user(
    user_id: int,
    data: UserUpdate,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Prevent disabling the last active admin
    if data.is_active is False and user.role == UserRole.admin:
        active_admins = await db.execute(
            select(User).where(User.role == UserRole.admin, User.is_active == True, User.id != user_id)
        )
        if not active_admins.scalar_one_or_none():
            raise HTTPException(
                status_code=400,
                detail="Cannot disable the last active admin account. Activate another admin first.",
            )

    # Prevent demoting the last active admin
    if data.role is not None and data.role != "admin" and user.role == UserRole.admin and user.is_active:
        active_admins = await db.execute(
            select(User).where(User.role == UserRole.admin, User.is_active == True, User.id != user_id)
        )
        if not active_admins.scalar_one_or_none():
            raise HTTPException(
                status_code=400,
                detail="Cannot demote the last active admin account.",
            )

    if data.role is not None:
        user.role = UserRole(data.role)
    if data.is_active is not None:
        user.is_active = data.is_active
    await db.commit()
    return {"id": user.id, "email": user.email, "role": user.role, "is_active": user.is_active}


@router.get("/logs")
async def get_logs(
    tail: int = Query(default=200, ge=10, le=500),
    _admin: User = Depends(require_admin),
):
    return {"lines": log_buffer.get_lines(tail)}


@router.delete("/logs", status_code=204)
async def clear_logs(_admin: User = Depends(require_admin)):
    log_buffer.clear()
