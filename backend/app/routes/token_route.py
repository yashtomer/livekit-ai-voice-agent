import os
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from ..db import get_db
from ..models.user import User, UserRole
from ..models.api_key import UserAPIKey
from ..models.admin_setting import AdminSetting
from ..models.call_session import CallSession
from ..schemas.config import TokenRequest, TokenResponse
from ..services.livekit_svc import build_token
from ..services.encryption import decrypt_key
from .auth import get_current_user

router = APIRouter()

FREE_PROVIDERS = {"whisper_local", "piper_local", "edge", "voicebox", "ollama"}

ENV_KEY_MAP = {
    "openai": "OPENAI_API_KEY",
    "groq": "GROQ_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_API_KEY",
    "deepgram": "DEEPGRAM_API_KEY",
    "elevenlabs": "ELEVENLABS_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "azure": "AZURE_SPEECH_KEY",
}


async def _resolve_api_key(provider: str, user: User, db: AsyncSession) -> str | None:
    result = await db.execute(
        select(UserAPIKey).where(
            UserAPIKey.user_id == user.id,
            UserAPIKey.provider == provider,
        )
    )
    key_row = result.scalar_one_or_none()
    if key_row:
        return decrypt_key(key_row.encrypted_key)

    if user.role == UserRole.admin:
        env_var = ENV_KEY_MAP.get(provider)
        if env_var:
            return os.environ.get(env_var)

    return None


async def _read_int_setting(db: AsyncSession, key: str, default: int) -> int:
    result = await db.execute(select(AdminSetting).where(AdminSetting.key == key))
    row = result.scalar_one_or_none()
    if not row:
        return default
    try:
        return int(row.value)
    except (TypeError, ValueError):
        return default


@router.post("/token", response_model=TokenResponse)
async def create_token(
    req: TokenRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    call_limit_s = await _read_int_setting(db, "call_limit_seconds", 60)
    max_concurrent = await _read_int_setting(db, "max_concurrent_calls_per_user", 2)
    max_per_day = await _read_int_setting(db, "max_calls_per_day_per_user", 50)

    # Quota enforcement (admins exempt). `ended_at` isn't reliably set today,
    # so "active" = started within the last call_limit window.
    if user.role != UserRole.admin:
        now = datetime.now(timezone.utc)
        active_window_start = now - timedelta(seconds=call_limit_s + 30)
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

        active = (await db.execute(
            select(func.count()).select_from(CallSession).where(
                CallSession.user_id == user.id,
                CallSession.started_at >= active_window_start,
            )
        )).scalar() or 0
        if active >= max_concurrent:
            raise HTTPException(
                status_code=429,
                detail=f"Concurrent-call limit reached ({max_concurrent}). End an active call or contact your admin.",
            )

        today_count = (await db.execute(
            select(func.count()).select_from(CallSession).where(
                CallSession.user_id == user.id,
                CallSession.started_at >= today_start,
            )
        )).scalar() or 0
        if today_count >= max_per_day:
            raise HTTPException(
                status_code=429,
                detail=f"Daily call limit reached ({max_per_day}). Try again tomorrow or contact your admin.",
            )

    stt = dict(req.stt)
    llm = dict(req.llm)
    tts = dict(req.tts)

    for cfg_dict in [stt, llm, tts]:
        provider = cfg_dict.get("provider", "")
        if provider and provider not in FREE_PROVIDERS:
            api_key = await _resolve_api_key(provider, user, db)
            if api_key:
                cfg_dict["api_key"] = api_key
            else:
                raise HTTPException(
                    status_code=400,
                    detail=f"No API key configured for provider '{provider}'. "
                    "Add it via the configuration panel.",
                )

    if tts.get("provider") == "azure":
        tts.setdefault("azure_region", os.environ.get("AZURE_SPEECH_REGION", "eastus"))

    try:
        token, url, room_name, identity = build_token(user.id, stt, llm, tts, call_limit_s)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Token generation failed: {e}")

    session = CallSession(
        user_id=user.id,
        room_name=room_name,
        stt_config={k: v for k, v in stt.items() if k != "api_key"},
        llm_config={k: v for k, v in llm.items() if k != "api_key"},
        tts_config={k: v for k, v in tts.items() if k != "api_key"},
    )
    db.add(session)
    await db.commit()

    return TokenResponse(
        token=token,
        url=url,
        room=room_name,
        identity=identity,
        call_limit_seconds=call_limit_s,
    )
