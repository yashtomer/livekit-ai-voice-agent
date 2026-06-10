"""
Google Calendar integration for appointment booking.

Single shared calendar model: one Google account (credentials in .env) holds all
bookings on GOOGLE_CALENDAR_ID. "Doctors" are local metadata (DOCTORS roster);
each booking is a calendar event tagged with the doctor's name in the summary and
in extendedProperties so we can filter per doctor. Availability for a day is the
fixed business-hour slots (CALENDAR_OPEN_HOUR..CALENDAR_CLOSE_HOUR) minus the slots
already taken by that doctor's events.

We talk to Google's REST API directly with aiohttp (no google-api-python-client
dependency): the refresh token is exchanged for a short-lived access token which we
cache in-process until shortly before it expires.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta
from typing import Any, Optional
from zoneinfo import ZoneInfo

import aiohttp

from ... import config

log = logging.getLogger("google_calendar")

_TOKEN_URL = "https://oauth2.googleapis.com/token"
_API_BASE = "https://www.googleapis.com/calendar/v3"

# Doctor roster (local metadata). Matches the Calendar UI. `id` is a stable slug
# used to tag/filter events; `name` is what the agent and UI display.
DOCTORS: list[dict[str, str]] = [
    {"id": "john_smith",     "name": "Dr. John Smith",     "department": "General Physician"},
    {"id": "emily_johnson",  "name": "Dr. Emily Johnson",  "department": "General Physician"},
    {"id": "michael_brown",  "name": "Dr. Michael Brown",  "department": "Cardiology"},
    {"id": "sarah_davis",    "name": "Dr. Sarah Davis",    "department": "Cardiology"},
    {"id": "david_wilson",   "name": "Dr. David Wilson",   "department": "Orthopedics"},
]

_DOCTOR_BY_ID = {d["id"]: d for d in DOCTORS}


def _tz() -> ZoneInfo:
    try:
        return ZoneInfo(config.CALENDAR_TIMEZONE)
    except Exception:
        return ZoneInfo("UTC")


def resolve_doctor(value: str | None) -> Optional[dict[str, str]]:
    """Match a doctor by id, exact name, or loose substring (case-insensitive)."""
    if not value:
        return None
    v = value.strip().lower()
    if v in _DOCTOR_BY_ID:
        return _DOCTOR_BY_ID[v]
    for d in DOCTORS:
        if d["name"].lower() == v:
            return d
    # Loose contains match (e.g. "smith", "john smith", "dr smith")
    for d in DOCTORS:
        name = d["name"].lower()
        if v in name or name.replace("dr. ", "") in v:
            return d
    return None


# ── OAuth token (cached) ──────────────────────────────────────────────────────

_token_cache: dict[str, Any] = {"access_token": None, "expires_at": 0.0}


def is_configured() -> bool:
    return bool(
        config.GOOGLE_CLIENT_ID
        and config.GOOGLE_CLIENT_SECRET
        and config.GOOGLE_REFRESH_TOKEN
    )


async def get_access_token(force: bool = False) -> str:
    """Return a valid access token, refreshing via the stored refresh token when
    the cached one is missing or about to expire (60s safety margin)."""
    if not is_configured():
        raise RuntimeError("Google Calendar is not configured (missing client id/secret/refresh token).")
    now = time.time()
    if not force and _token_cache["access_token"] and _token_cache["expires_at"] - 60 > now:
        return _token_cache["access_token"]

    data = {
        "client_id": config.GOOGLE_CLIENT_ID,
        "client_secret": config.GOOGLE_CLIENT_SECRET,
        "refresh_token": config.GOOGLE_REFRESH_TOKEN,
        "grant_type": "refresh_token",
    }
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
        async with session.post(_TOKEN_URL, data=data) as resp:
            body = await resp.json()
            if resp.status != 200 or "access_token" not in body:
                raise RuntimeError(f"Token refresh failed ({resp.status}): {body}")
            _token_cache["access_token"] = body["access_token"]
            _token_cache["expires_at"] = now + int(body.get("expires_in", 3600))
            return _token_cache["access_token"]


async def _auth_headers() -> dict[str, str]:
    token = await get_access_token()
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ── Events ────────────────────────────────────────────────────────────────────

def _event_to_dict(ev: dict[str, Any]) -> dict[str, Any]:
    start = ev.get("start", {})
    end = ev.get("end", {})
    props = (ev.get("extendedProperties") or {}).get("private") or {}
    return {
        "id": ev.get("id"),
        "summary": ev.get("summary"),
        "description": ev.get("description"),
        "start": start.get("dateTime") or start.get("date"),
        "end": end.get("dateTime") or end.get("date"),
        "doctor_id": props.get("doctor_id"),
        "doctor": props.get("doctor"),
        "patient": props.get("patient"),
        "department": props.get("department"),
        "html_link": ev.get("htmlLink"),
        "status": ev.get("status"),
    }


async def list_events(time_min: datetime, time_max: datetime) -> list[dict[str, Any]]:
    """List events on the configured calendar within [time_min, time_max)."""
    headers = await _auth_headers()
    params = {
        "timeMin": time_min.astimezone(_tz()).isoformat(),
        "timeMax": time_max.astimezone(_tz()).isoformat(),
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": "2500",
    }
    url = f"{_API_BASE}/calendars/{config.GOOGLE_CALENDAR_ID}/events"
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
        async with session.get(url, headers=headers, params=params) as resp:
            body = await resp.json()
            if resp.status != 200:
                raise RuntimeError(f"list_events failed ({resp.status}): {body}")
            return [_event_to_dict(e) for e in body.get("items", [])]


async def create_event(
    *,
    summary: str,
    start: datetime,
    end: datetime,
    description: str | None = None,
    private_props: dict[str, str] | None = None,
) -> dict[str, Any]:
    headers = await _auth_headers()
    payload: dict[str, Any] = {
        "summary": summary,
        "start": {"dateTime": start.astimezone(_tz()).isoformat(), "timeZone": config.CALENDAR_TIMEZONE},
        "end": {"dateTime": end.astimezone(_tz()).isoformat(), "timeZone": config.CALENDAR_TIMEZONE},
    }
    if description:
        payload["description"] = description
    if private_props:
        payload["extendedProperties"] = {"private": private_props}
    url = f"{_API_BASE}/calendars/{config.GOOGLE_CALENDAR_ID}/events"
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
        async with session.post(url, headers=headers, json=payload) as resp:
            body = await resp.json()
            if resp.status not in (200, 201):
                raise RuntimeError(f"create_event failed ({resp.status}): {body}")
            return _event_to_dict(body)


# ── Slots / availability ──────────────────────────────────────────────────────

def _day_bounds(day: datetime) -> tuple[datetime, datetime]:
    tz = _tz()
    base = day.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    return base, base + timedelta(days=1)


def _hour_slots() -> list[int]:
    """Hourly slot start-hours within business hours, e.g. [9,10,...,16]."""
    return list(range(config.CALENDAR_OPEN_HOUR, config.CALENDAR_CLOSE_HOUR))


def parse_date(date_str: str) -> datetime:
    """Parse a YYYY-MM-DD (or ISO) date into a tz-aware midnight datetime."""
    tz = _tz()
    s = (date_str or "").strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            d = datetime.strptime(s, fmt)
            return d.replace(tzinfo=tz)
        except ValueError:
            continue
    # Last resort: ISO parse
    d = datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=tz)


def parse_time(time_str: str) -> tuple[int, int]:
    """Parse a clock string ('14:00', '2pm', '2:30 PM', '14') to (hour, minute)."""
    s = (time_str or "").strip().lower().replace(".", "")
    pm = "pm" in s
    am = "am" in s
    s = s.replace("am", "").replace("pm", "").strip()
    parts = s.split(":") if s else ["0"]
    hour = int(parts[0]) if parts[0] else 0
    minute = int(parts[1]) if len(parts) > 1 and parts[1] else 0
    if pm and hour < 12:
        hour += 12
    if am and hour == 12:
        hour = 0
    return hour, minute


def parse_time_to_hour(time_str: str) -> int:
    """Parse a clock string ('14:00', '2pm', '2:00 PM', '14') to an hour int."""
    return parse_time(time_str)[0]


async def get_availability_for_day(day: datetime) -> dict[str, Any]:
    """Compute, per doctor, the free hourly slots for a given day, plus the
    booked events on that day. Used by the Calendar UI's right-hand panel."""
    start, end = _day_bounds(day)
    try:
        events = await list_events(start, end)
    except Exception as e:
        log.exception("availability list_events failed")
        return {"status": "error", "message": str(e), "doctors": [], "events": []}

    tz = _tz()
    # Map doctor_id -> set of booked start-hours
    booked: dict[str, set[int]] = {d["id"]: set() for d in DOCTORS}
    for ev in events:
        did = ev.get("doctor_id")
        st = ev.get("start")
        if not did or did not in booked or not st:
            continue
        try:
            h = datetime.fromisoformat(st).astimezone(tz).hour
            booked[did].add(h)
        except Exception:
            pass

    doctors_out = []
    for d in DOCTORS:
        free = [h for h in _hour_slots() if h not in booked[d["id"]]]
        doctors_out.append({
            **d,
            "free_slots": [f"{h:02d}:00" for h in free],
            "free_count": len(free),
        })
    return {
        "status": "ok",
        "date": start.date().isoformat(),
        "open_hour": config.CALENDAR_OPEN_HOUR,
        "close_hour": config.CALENDAR_CLOSE_HOUR,
        "timezone": config.CALENDAR_TIMEZONE,
        "doctors": doctors_out,
        "events": events,
    }


async def book_appointment_event(
    *,
    patient_name: str,
    doctor: str,
    date: str,
    time_str: str,
    department: str | None = None,
    reason: str | None = None,
    summary: str | None = None,
) -> dict[str, Any]:
    """Resolve the doctor + slot and create a 1-hour calendar event. Returns a
    structured result (never raises) suitable for an LLM tool response.

    `summary` is a short recap / outcome of the call, stored in the event
    description for later reference."""
    if not is_configured():
        return {"status": "error", "message": "Google Calendar is not configured on the server."}

    doc = resolve_doctor(doctor)
    if not doc:
        names = ", ".join(d["name"] for d in DOCTORS)
        return {"status": "error", "message": f"Unknown doctor '{doctor}'. Available: {names}."}

    try:
        day = parse_date(date)
        hour = parse_time_to_hour(time_str)
    except Exception:
        return {"status": "error", "message": f"Could not parse date/time '{date} {time_str}'. Use date YYYY-MM-DD and a time like '14:00'."}

    if not (config.CALENDAR_OPEN_HOUR <= hour < config.CALENDAR_CLOSE_HOUR):
        return {
            "status": "error",
            "message": f"{hour:02d}:00 is outside clinic hours ({config.CALENDAR_OPEN_HOUR:02d}:00–{config.CALENDAR_CLOSE_HOUR:02d}:00).",
        }

    tz = _tz()
    start = day.replace(hour=hour, minute=0, second=0, microsecond=0, tzinfo=tz)
    end = start + timedelta(hours=1)

    # Conflict check: is this doctor already booked at this hour?
    try:
        day_start, day_end = _day_bounds(day)
        existing = await list_events(day_start, day_end)
        for ev in existing:
            if ev.get("doctor_id") == doc["id"] and ev.get("start"):
                if datetime.fromisoformat(ev["start"]).astimezone(tz).hour == hour:
                    return {
                        "status": "unavailable",
                        "message": f"{doc['name']} is already booked at {hour:02d}:00 on {start.date().isoformat()}. Please offer another slot.",
                    }
    except Exception:
        log.exception("conflict check failed; proceeding to create")

    dept = department or doc["department"]
    title = f"{doc['name']} — {patient_name}"
    desc_lines = [f"Patient: {patient_name}", f"Doctor: {doc['name']}", f"Department: {dept}"]
    if reason:
        desc_lines.append(f"Reason: {reason}")
    if summary:
        desc_lines.append(f"\nCall summary: {summary}")
    desc_lines.append("\nBooked via AI voice agent.")

    try:
        ev = await create_event(
            summary=title,
            start=start,
            end=end,
            description="\n".join(desc_lines),
            private_props={
                "doctor_id": doc["id"],
                "doctor": doc["name"],
                "patient": patient_name,
                "department": dept,
                "source": "voice_agent",
            },
        )
    except Exception as e:
        log.exception("book_appointment_event create failed")
        return {"status": "error", "message": f"Failed to create the appointment: {e}"}

    return {
        "status": "ok",
        "message": f"Appointment confirmed with {doc['name']} ({dept}) on {start.strftime('%A %d %b %Y')} at {hour:02d}:00.",
        "event_id": ev.get("id"),
        "doctor": doc["name"],
        "department": dept,
        "patient": patient_name,
        "start": ev.get("start"),
        "end": ev.get("end"),
        "html_link": ev.get("html_link"),
    }


async def book_generic_event(
    *,
    title: str,
    attendee_name: str | None = None,
    date: str,
    time_str: str,
    duration_minutes: int = 60,
    summary: str | None = None,
) -> dict[str, Any]:
    """Create a generic Google Calendar event for ANY agent/domain (no doctor or
    clinic-hours validation). Used by the `book_calendar_event` tool so non-clinic
    agents (real estate, salon, etc.) can book appointments too.

    `summary` is a short recap/outcome of the call, stored in the event description.
    Returns a structured result and never raises."""
    if not is_configured():
        return {"status": "error", "message": "Google Calendar is not configured on the server."}

    try:
        day = parse_date(date)
        hour, minute = parse_time(time_str)
    except Exception:
        return {"status": "error", "message": f"Could not parse date/time '{date} {time_str}'. Use date YYYY-MM-DD and a time like '14:30'."}

    try:
        dur = int(duration_minutes or 60)
    except Exception:
        dur = 60
    if dur <= 0:
        dur = 60

    tz = _tz()
    start = day.replace(hour=hour, minute=minute, second=0, microsecond=0, tzinfo=tz)
    end = start + timedelta(minutes=dur)

    event_title = (title or "Appointment").strip()
    if attendee_name:
        event_title = f"{event_title} — {attendee_name}"
    desc_lines = []
    if attendee_name:
        desc_lines.append(f"With: {attendee_name}")
    if summary:
        desc_lines.append(f"Call summary: {summary}")
    desc_lines.append("\nBooked via AI voice agent.")

    try:
        ev = await create_event(
            summary=event_title,
            start=start,
            end=end,
            description="\n".join(desc_lines),
            private_props={
                "attendee": attendee_name or "",
                "call_summary": summary or "",
                "source": "voice_agent",
            },
        )
    except Exception as e:
        log.exception("book_generic_event create failed")
        return {"status": "error", "message": f"Failed to create the event: {e}"}

    return {
        "status": "ok",
        "message": f"Booked '{event_title}' on {start.strftime('%A %d %b %Y')} at {start.strftime('%H:%M')}.",
        "event_id": ev.get("id"),
        "title": event_title,
        "attendee": attendee_name,
        "start": ev.get("start"),
        "end": ev.get("end"),
        "html_link": ev.get("html_link"),
    }
