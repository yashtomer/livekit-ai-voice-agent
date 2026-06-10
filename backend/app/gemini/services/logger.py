"""
Lightweight async helper for recording Gemini Live call sessions and transcripts.

Used by gemini_call (browser), twilio_bridge, and vobiz_bridge.
Failures are logged and swallowed — logging must never break a live call.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import select

from ...db import SessionLocal
from ..models.call_log import GeminiCallLog

log = logging.getLogger("gemini_logger")

SUMMARY_MODEL = os.environ.get("GEMINI_SUMMARY_MODEL", "gemini-2.5-flash")


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


async def add_tool_event(call_id: Optional[int], name: str, args: dict, result: Any,
                          request: Optional[dict] = None) -> None:
    """Record a tool/function call in the transcript timeline (role='tool').

    Stored inline with the conversation so the call history can show what the
    agent looked up and what it got back, in order. `request` carries the actual
    outgoing call metadata (kind/method/url/payload) for display.
    """
    if not call_id or not name:
        return
    try:
        # Keep the stored result compact — a short JSON-ish preview is enough
        # for the timeline; the full payload lives only in the live session.
        preview = result
        if isinstance(result, (dict, list)):
            import json as _json
            preview = _json.dumps(result)[:600]
        elif result is not None:
            preview = str(result)[:600]
        async with SessionLocal() as db:
            row = (await db.execute(select(GeminiCallLog).where(GeminiCallLog.id == call_id))).scalar_one_or_none()
            if not row:
                return
            entries = list(row.transcript or [])
            entries.append({
                "role": "tool",
                "name": name,
                "args": args or {},
                "request": request or None,
                "result": preview,
                "ts": datetime.utcnow().isoformat() + "Z",
            })
            row.transcript = entries
            await db.commit()
    except Exception:
        log.exception("gemini_logger.add_tool_event failed")


async def end_call(
    call_id: Optional[int],
    *,
    status: str = "ended",
    error_message: Optional[str] = None,
    api_key: Optional[str] = None,
) -> None:
    if not call_id:
        return
    transcript = None
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
            transcript = list(row.transcript or [])
            await db.commit()
    except Exception:
        log.exception("gemini_logger.end_call failed")
        return

    # Best-effort post-call analysis. Never let a failure here affect the call.
    if status == "ended" and api_key and transcript:
        try:
            await _generate_summary(call_id, transcript, api_key)
        except Exception as exc:
            # Non-fatal: the call/transcript are already saved, only the AI summary
            # is missing. The summary model (gemini-2.5-flash) periodically returns
            # 503 "high demand" — log one concise line, not a scary stack trace.
            log.warning("post-call summary skipped for call %d: %s", call_id, str(exc)[:160])


# ── Post-call AI analysis ─────────────────────────────────────────────────────

_SUMMARY_INSTRUCTION = (
    "You analyse a finished voice-call transcript between a USER (caller) and a "
    "MODEL (AI agent). TOOL lines are function calls the agent made.\n"
    "Return ONLY a JSON object (no markdown fences) with exactly these keys:\n"
    '  "summary"   : a 1-2 sentence recap of what happened and any outcome.\n'
    '  "sentiment" : one of "positive", "neutral", "negative" — the caller\'s overall mood.\n'
    '  "extracted" : an object of the key facts captured during the call '
    "(e.g. names, dates, times, order IDs, intent, resolution). Use null/empty "
    "object if nothing concrete was captured.\n"
)


def _transcript_to_text(transcript: list[dict]) -> str:
    lines: list[str] = []
    for e in transcript:
        role = (e.get("role") or "").upper()
        if role == "TOOL":
            lines.append(f"TOOL: {e.get('name')}({e.get('args')}) -> {e.get('result')}")
        else:
            txt = (e.get("text") or "").strip()
            if txt:
                lines.append(f"{role}: {txt}")
    return "\n".join(lines)[:12000]


async def _generate_summary(call_id: int, transcript: list[dict], api_key: str) -> None:
    convo = _transcript_to_text(transcript)
    if not convo.strip():
        return

    import asyncio

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)

    # The summary model occasionally returns 503 "high demand". Retry a few times
    # with backoff before giving up — the summary is best-effort but cheap to retry.
    resp = None
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            resp = await client.aio.models.generate_content(
                model=SUMMARY_MODEL,
                contents=convo,
                config=types.GenerateContentConfig(
                    system_instruction=_SUMMARY_INSTRUCTION,
                    response_mime_type="application/json",
                    temperature=0.2,
                ),
            )
            break
        except Exception as exc:
            last_exc = exc
            msg = str(exc)
            retryable = "503" in msg or "UNAVAILABLE" in msg or "high demand" in msg or "overloaded" in msg
            if not retryable or attempt == 2:
                raise
            await asyncio.sleep(1.5 * (attempt + 1))
    if resp is None:  # defensive: loop always either breaks or raises
        raise last_exc or RuntimeError("summary generation failed")

    import json as _json
    raw = (resp.text or "").strip()
    try:
        data = _json.loads(raw)
    except Exception:
        # Tolerate stray markdown fences.
        cleaned = raw.strip().lstrip("`").removeprefix("json").strip().rstrip("`").strip()
        data = _json.loads(cleaned)

    summary = (data.get("summary") or "").strip()[:2000] or None
    sentiment = (data.get("sentiment") or "").strip().lower() or None
    if sentiment not in ("positive", "neutral", "negative"):
        sentiment = None
    extracted = data.get("extracted")
    if not isinstance(extracted, (dict, list)):
        extracted = None

    try:
        async with SessionLocal() as db:
            row = (await db.execute(select(GeminiCallLog).where(GeminiCallLog.id == call_id))).scalar_one_or_none()
            if not row:
                return
            row.summary = summary
            row.sentiment = sentiment
            row.extracted = extracted
            await db.commit()
            log.info("📝 call %d analysed: sentiment=%s", call_id, sentiment)
    except Exception:
        log.exception("gemini_logger._generate_summary persist failed")
