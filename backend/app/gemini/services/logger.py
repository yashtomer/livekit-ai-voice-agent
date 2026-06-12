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

# Categorized end reasons surfaced in the calls UI (gemini_call_logs.end_reason).
REASON_COMPLETED          = "COMPLETED"            # call finished normally
REASON_CLIENT_DISCONNECTED = "CLIENT_DISCONNECTED"  # caller/browser hung up
REASON_AGENT_ENDED        = "AGENT_ENDED"          # AI agent ended the call
REASON_NETWORK_ISSUE      = "NETWORK_ISSUE"        # socket drop / connection reset / timeout
REASON_MODEL_ERROR        = "MODEL_ERROR"          # Gemini 5xx / unavailable / overloaded
REASON_INTERNAL_ERROR     = "INTERNAL_ERROR"       # anything else

# Reasons that warrant a "we'll call you back" WhatsApp to the customer.
_WHATSAPP_REASONS = {REASON_NETWORK_ISSUE, REASON_MODEL_ERROR, REASON_INTERNAL_ERROR}

# LOCAL TESTING ONLY: when set, browser calls (which carry no phone number)
# become eligible for the disconnect WhatsApp and the notice is sent to THIS
# number — start a browser call, cut it mid-conversation, and confirm the SMS
# lands. Leave unset in production; browser calls are then never notified.
WHATSAPP_TEST_NUMBER = os.environ.get("WHATSAPP_TEST_NUMBER", "").strip()


def classify_disconnect(exc: BaseException | None) -> str:
    """Map a teardown exception to a categorized end reason.

    Mirrors the reconnect-classification the bridges already use:
      - socket drops (1006/1011, ConnectionClosed/Reset, BrokenPipe, timeouts) → NETWORK_ISSUE
      - Gemini 5xx / unavailable / overloaded                                   → MODEL_ERROR
      - everything else                                                          → INTERNAL_ERROR
    Pass exc=None for a clean finish → COMPLETED.
    """
    if exc is None:
        return REASON_COMPLETED
    code = getattr(exc, "code", None)
    msg = str(exc)
    exc_type = type(exc).__name__
    if (
        "ConnectionClosed" in exc_type
        or "APIError" in exc_type
        or isinstance(exc, (ConnectionResetError, BrokenPipeError, TimeoutError))
        or "TimeoutError" in exc_type
        or code in (1006, 1011)
        or "abnormal closure" in msg or "1006" in msg or "1011" in msg
    ):
        return REASON_NETWORK_ISSUE
    if (
        "ServerError" in exc_type
        or code in (500, 503)
        or "503" in msg or "500" in msg
        or "UNAVAILABLE" in msg or "high demand" in msg or "overloaded" in msg
    ):
        return REASON_MODEL_ERROR
    return REASON_INTERNAL_ERROR


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
    reason: Optional[str] = None,
    error_message: Optional[str] = None,
    api_key: Optional[str] = None,
) -> None:
    if not call_id:
        return
    # Default the categorized reason from the coarse status when not supplied.
    if reason is None:
        reason = REASON_INTERNAL_ERROR if status == "error" else REASON_COMPLETED
    transcript = None
    call_type = None
    phone_number = None
    try:
        async with SessionLocal() as db:
            row = (await db.execute(select(GeminiCallLog).where(GeminiCallLog.id == call_id))).scalar_one_or_none()
            if not row or row.status != "active":
                return
            ended = datetime.utcnow()
            row.ended_at = ended
            row.status = status
            row.end_reason = reason
            if error_message:
                row.error_message = error_message[:1000]
            if row.started_at:
                started = row.started_at
                row.duration_s = max(0, int((ended - started).total_seconds()))
            transcript = list(row.transcript or [])
            call_type = row.call_type
            phone_number = row.phone_number
            await db.commit()
    except Exception:
        log.exception("gemini_logger.end_call failed")
        return

    # Post-call AI analysis. Runs once on a clean end; besides the summary it
    # yields a `resolved` verdict we reuse to gate the caller-disconnect SMS.
    # Best-effort: never let a failure here affect the call.
    analysis: Optional[dict] = None
    if status == "ended" and api_key and transcript:
        try:
            analysis = await _generate_summary(call_id, transcript, api_key)
        except Exception as exc:
            # Non-fatal: the call/transcript are already saved, only the AI summary
            # is missing. The summary model (gemini-2.5-flash) periodically returns
            # 503 "high demand" — log one concise line, not a scary stack trace.
            log.warning("post-call summary skipped for call %d: %s", call_id, str(exc)[:160])

    # Decide whether to WhatsApp the caller a "we'll call you back" notice.
    #   • our-side break (network / model / internal) → always notify.
    #   • caller hung up (CLIENT_DISCONNECTED)        → notify ONLY if the
    #       conversation wasn't resolved. The verdict comes from the post-call
    #       judge above; if it couldn't decide (judge failed, no transcript,
    #       short call) `resolved` is None → fail SAFE and notify.
    #   • agent ended the call / clean COMPLETED      → never notify.
    # Best-effort: a failed WhatsApp send must never affect call teardown.
    #
    # Recipient: real phone calls use their own number. Browser calls have none,
    # so they're notified ONLY when WHATSAPP_TEST_NUMBER is set (local testing) —
    # the notice then goes to that test number.
    sms_to = phone_number or (WHATSAPP_TEST_NUMBER if call_type == "browser" else "")
    send_sms = False
    if call_type and sms_to:
        if reason in _WHATSAPP_REASONS:
            send_sms = True
        elif reason == REASON_CLIENT_DISCONNECTED:
            resolved = analysis.get("resolved") if isinstance(analysis, dict) else None
            send_sms = resolved is not True

    # One line that explains the SMS decision — invaluable when a call "should"
    # have notified but didn't (usually because it ended AGENT_ENDED/COMPLETED,
    # not CLIENT_DISCONNECTED, or the judge ruled the call resolved).
    log.info("📨 call %d sms decision: type=%s reason=%s resolved=%s → send=%s",
             call_id, call_type, reason,
             (analysis or {}).get("resolved") if isinstance(analysis, dict) else None,
             send_sms)

    if send_sms:
        try:
            from .whatsapp import send_whatsapp_template
            await send_whatsapp_template(sms_to)
        except Exception as exc:
            log.warning("WhatsApp disconnect notify skipped for call %d: %s", call_id, str(exc)[:160])


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
    '  "resolved"  : true or false. true ONLY if the caller\'s request/need was '
    "fully handled before the call ended (their question was answered or their "
    "task was completed). false if the caller hung up or the call was cut off "
    "before their issue was resolved, or the conversation ended mid-task with an "
    "open request. When unsure, prefer false.\n"
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


async def _generate_summary(call_id: int, transcript: list[dict], api_key: str) -> Optional[dict]:
    """Run the post-call analysis. Persists summary/sentiment/extracted and returns
    the parsed verdict dict (incl. a `resolved` bool) so callers can gate follow-ups.
    Returns None when there is nothing to analyse."""
    convo = _transcript_to_text(transcript)
    if not convo.strip():
        return None

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
    # Resolution verdict gates the caller-disconnect WhatsApp. Keep it strictly
    # boolean; anything else (missing/garbled) stays None so the caller path can
    # fail safe (treat as unresolved → notify).
    resolved = data.get("resolved")
    if not isinstance(resolved, bool):
        resolved = None

    try:
        async with SessionLocal() as db:
            row = (await db.execute(select(GeminiCallLog).where(GeminiCallLog.id == call_id))).scalar_one_or_none()
            if not row:
                return None
            row.summary = summary
            row.sentiment = sentiment
            row.extracted = extracted
            await db.commit()
            log.info("📝 call %d analysed: sentiment=%s resolved=%s", call_id, sentiment, resolved)
    except Exception:
        log.exception("gemini_logger._generate_summary persist failed")

    return {"summary": summary, "sentiment": sentiment, "extracted": extracted, "resolved": resolved}
