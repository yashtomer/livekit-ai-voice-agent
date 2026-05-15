import json
import logging
import os
from typing import Any, Dict

import httpx
from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models.api_key import UserAPIKey
from ..models.user import User
from ..services.encryption import decrypt_key
from .auth import get_current_user

logger = logging.getLogger("ultravox")

router = APIRouter()

ULTRAVOX_API_KEY = os.environ.get("ULTRAVOX_API_KEY")


async def create_ultravox_call(medium: Dict[str, Any] = None, api_key: str = None):
    key = api_key or ULTRAVOX_API_KEY
    if not key:
        raise ValueError("Ultravox API key not configured")

    if medium is None:
        medium = {"serverWebSocket": {"inputSampleRate": 48000, "outputSampleRate": 48000}}

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://api.ultravox.ai/api/calls",
            json={
                "systemPrompt": "You are a helpful AI voice assistant. Greet the caller warmly and ask how you can help them today. Keep responses concise.",
                "voice": "Mark",
                "medium": medium,
            },
            headers={"X-API-Key": key, "Content-Type": "application/json"},
            timeout=30.0,
        )
        resp.raise_for_status()
        return resp.json()


@router.post("/create-web-call")
async def create_web_call(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await db.execute(
            select(UserAPIKey).where(
                UserAPIKey.user_id == user.id, UserAPIKey.provider == "ultravox"
            )
        )
        api_key_entry = result.scalar_one_or_none()
        api_key = decrypt_key(api_key_entry.encrypted_key) if api_key_entry else None

        uv_call = await create_ultravox_call(medium={"webRtc": {}}, api_key=api_key)
        return {"joinUrl": uv_call["joinUrl"]}
    except Exception as e:
        logger.error(f"Create web call error: {e}")
        return Response(
            content=json.dumps({"error": str(e)}),
            status_code=500,
            media_type="application/json",
        )
