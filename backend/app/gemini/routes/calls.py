"""
Read-only API for browsing past Gemini Live call sessions.

Routes (mounted under /api/gemini-calls):
  GET /          — list calls (newest first)
  GET /stats     — aggregate analytics across all calls
  GET /{id}      — single call with full transcript
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...db import get_db
from ..models.call_log import GeminiCallLog

router = APIRouter()


def _row_summary(row: GeminiCallLog) -> dict:
    transcript = row.transcript or []
    # Conversational turns exclude tool events (which also live in the transcript).
    turn_count = sum(1 for t in transcript if (t.get("role") if isinstance(t, dict) else None) != "tool")
    return {
        "id": row.id,
        "call_type": row.call_type,
        "direction": row.direction,
        "phone_number": row.phone_number,
        "language": row.language,
        "voice": row.voice,
        "status": row.status,
        "end_reason": row.end_reason,
        "started_at": row.started_at.isoformat() + "Z" if row.started_at else None,
        "ended_at": row.ended_at.isoformat() + "Z" if row.ended_at else None,
        "duration_s": row.duration_s,
        "turn_count": turn_count,
        "summary": row.summary,
        "sentiment": row.sentiment,
    }


@router.get("/")
async def list_calls(limit: int = 20, offset: int = 0, db: AsyncSession = Depends(get_db)):
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    total = (await db.execute(select(func.count(GeminiCallLog.id)))).scalar_one()
    rows = (await db.execute(
        select(GeminiCallLog)
        .order_by(GeminiCallLog.started_at.desc())
        .limit(limit)
        .offset(offset)
    )).scalars().all()
    return {
        "items": [_row_summary(r) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/stats")
async def call_stats(db: AsyncSession = Depends(get_db)):
    """Aggregate analytics across all calls for the dashboard."""
    rows = (await db.execute(select(GeminiCallLog))).scalars().all()

    total = len(rows)
    ended = [r for r in rows if r.status == "ended"]
    errored = sum(1 for r in rows if r.status == "error")
    active = sum(1 for r in rows if r.status == "active")

    durations = [r.duration_s for r in ended if r.duration_s is not None]
    avg_duration = round(sum(durations) / len(durations)) if durations else 0
    total_duration = sum(durations)

    by_type: dict[str, int] = {}
    by_language: dict[str, int] = {}
    by_sentiment: dict[str, int] = {}
    by_voice: dict[str, int] = {}
    tool_usage: dict[str, int] = {}
    by_day: dict[str, int] = {}

    for r in rows:
        by_type[r.call_type] = by_type.get(r.call_type, 0) + 1
        if r.language:
            by_language[r.language] = by_language.get(r.language, 0) + 1
        if r.sentiment:
            by_sentiment[r.sentiment] = by_sentiment.get(r.sentiment, 0) + 1
        if r.voice:
            by_voice[r.voice] = by_voice.get(r.voice, 0) + 1
        if r.started_at:
            day = r.started_at.date().isoformat()
            by_day[day] = by_day.get(day, 0) + 1
        for t in (r.transcript or []):
            if isinstance(t, dict) and t.get("role") == "tool" and t.get("name"):
                tool_usage[t["name"]] = tool_usage.get(t["name"], 0) + 1

    def _top(d: dict[str, int], n: int = 8) -> list[dict]:
        return [{"key": k, "count": v} for k, v in sorted(d.items(), key=lambda kv: kv[1], reverse=True)[:n]]

    return {
        "total_calls": total,
        "ended_calls": len(ended),
        "active_calls": active,
        "errored_calls": errored,
        "avg_duration_s": avg_duration,
        "total_duration_s": total_duration,
        "by_type": _top(by_type),
        "by_language": _top(by_language),
        "by_sentiment": by_sentiment,
        "by_voice": _top(by_voice),
        "top_tools": _top(tool_usage),
        "calls_by_day": [{"day": k, "count": by_day[k]} for k in sorted(by_day.keys())][-30:],
    }


@router.get("/{call_id}")
async def get_call(call_id: int, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(GeminiCallLog).where(GeminiCallLog.id == call_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    data = _row_summary(row)
    data["system_prompt"] = row.system_prompt
    data["transcript"] = row.transcript or []
    data["error_message"] = row.error_message
    data["extracted"] = row.extracted
    return data
