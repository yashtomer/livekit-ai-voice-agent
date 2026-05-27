"""
Read-only API for browsing past Gemini Live call sessions.

Routes (mounted under /api/gemini-calls):
  GET /          — list calls (newest first)
  GET /{id}      — single call with full transcript
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models.gemini_call_log import GeminiCallLog

router = APIRouter()


def _row_summary(row: GeminiCallLog) -> dict:
    transcript = row.transcript or []
    return {
        "id": row.id,
        "call_type": row.call_type,
        "direction": row.direction,
        "phone_number": row.phone_number,
        "language": row.language,
        "voice": row.voice,
        "status": row.status,
        "started_at": row.started_at.isoformat() + "Z" if row.started_at else None,
        "ended_at": row.ended_at.isoformat() + "Z" if row.ended_at else None,
        "duration_s": row.duration_s,
        "turn_count": len(transcript),
    }


@router.get("/")
async def list_calls(limit: int = 100, db: AsyncSession = Depends(get_db)):
    limit = max(1, min(limit, 500))
    rows = (await db.execute(
        select(GeminiCallLog).order_by(GeminiCallLog.started_at.desc()).limit(limit)
    )).scalars().all()
    return {"items": [_row_summary(r) for r in rows]}


@router.get("/{call_id}")
async def get_call(call_id: int, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(GeminiCallLog).where(GeminiCallLog.id == call_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    data = _row_summary(row)
    data["system_prompt"] = row.system_prompt
    data["transcript"] = row.transcript or []
    data["error_message"] = row.error_message
    return data
