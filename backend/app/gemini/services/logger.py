"""
Lightweight async helper for recording Gemini Live call sessions and transcripts.

Used by gemini_call (browser), twilio_bridge, and vobiz_bridge.
Failures are logged and swallowed — logging must never break a live call.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import select

from ...db import SessionLocal
from ..models.call_log import GeminiCallLog

log = logging.getLogger("gemini_logger")


async def start_call(
    *,
    call_type: str,
    direction: Optional[str] = None,
    phone_number: Optional[str] = None,
    language: Optional[str] = None,
    voice: Optional[str] = None,
    system_prompt: Optional[str] = None,
) -> Optional[int]:
    try:
        async with SessionLocal() as db:
            row = GeminiCallLog(
                call_type=call_type,
                direction=direction,
                phone_number=phone_number,
                language=language,
                voice=voice,
                system_prompt=system_prompt,
                transcript=[],
                status="active",
                started_at=datetime.utcnow(),
            )
            db.add(row)
            await db.commit()
            await db.refresh(row)
            return row.id
    except Exception:
        log.exception("gemini_logger.start_call failed")
        return None


async def add_transcript(call_id: Optional[int], role: str, text: str) -> None:
    if not call_id or not text:
        return
    try:
        async with SessionLocal() as db:
            row = (await db.execute(select(GeminiCallLog).where(GeminiCallLog.id == call_id))).scalar_one_or_none()
            if not row:
                return
            entries = list(row.transcript or [])
            entries.append({
                "role": role,
                "text": text,
                "ts": datetime.utcnow().isoformat() + "Z",
            })
            row.transcript = entries
            await db.commit()
    except Exception:
        log.exception("gemini_logger.add_transcript failed")


async def end_call(call_id: Optional[int], *, status: str = "ended", error_message: Optional[str] = None) -> None:
    if not call_id:
        return
    try:
        async with SessionLocal() as db:
            row = (await db.execute(select(GeminiCallLog).where(GeminiCallLog.id == call_id))).scalar_one_or_none()
            if not row or row.status != "active":
                return
            ended = datetime.utcnow()
            row.ended_at = ended
            row.status = status
            if error_message:
                row.error_message = error_message[:1000]
            if row.started_at:
                started = row.started_at
                row.duration_s = max(0, int((ended - started).total_seconds()))
            await db.commit()
    except Exception:
        log.exception("gemini_logger.end_call failed")
