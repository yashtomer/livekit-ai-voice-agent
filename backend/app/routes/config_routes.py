from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from ..db import get_db
from ..models.user import User
from ..models.api_key import UserAPIKey
from ..schemas.config import APIKeyRequest, APIKeyInfo
from ..services.encryption import encrypt_key
from .auth import get_current_user

router = APIRouter()

KNOWN_PROVIDERS = [
    "openai", "groq", "anthropic", "google",
    "deepgram", "elevenlabs", "deepseek", "azure",
]


@router.get("/keys", response_model=list[APIKeyInfo])
async def list_keys(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(UserAPIKey.provider).where(UserAPIKey.user_id == user.id)
    )
    configured = {row[0] for row in result.fetchall()}
    return [
        APIKeyInfo(provider=p, configured=p in configured)
        for p in KNOWN_PROVIDERS
    ]


@router.put("/keys/{provider}", response_model=APIKeyInfo)
async def save_key(
    provider: str,
    req: APIKeyRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if provider not in KNOWN_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")
    if not req.api_key.strip():
        raise HTTPException(status_code=400, detail="API key cannot be empty")

    encrypted = encrypt_key(req.api_key.strip())
    result = await db.execute(
        select(UserAPIKey).where(
            UserAPIKey.user_id == user.id, UserAPIKey.provider == provider
        )
    )
    existing = result.scalar_one_or_none()

    if existing:
        existing.encrypted_key = encrypted
    else:
        db.add(UserAPIKey(user_id=user.id, provider=provider, encrypted_key=encrypted))

    await db.commit()
    return APIKeyInfo(provider=provider, configured=True)


@router.delete("/keys/{provider}", response_model=APIKeyInfo)
async def delete_key(
    provider: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(
        delete(UserAPIKey).where(
            UserAPIKey.user_id == user.id, UserAPIKey.provider == provider
        )
    )
    await db.commit()
    return APIKeyInfo(provider=provider, configured=False)
