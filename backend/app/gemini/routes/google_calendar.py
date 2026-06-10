"""
Google Calendar API for the Calendar view + manual bookings.

Routes (mounted under /api/google-calendar):
  GET  /status        — is the integration configured / can we reach Google?
  GET  /doctors       — the local doctor roster (id, name, department)
  GET  /events        — booked events in [start, end) (defaults to the current week)
  GET  /availability  — per-doctor free hourly slots for a given day (defaults today)
  POST /book          — manually create an appointment (same path the agent tool uses)

Single shared calendar: all reads/writes target GOOGLE_CALENDAR_ID via the
services/google_calendar helper. No auth dependency here, matching the sibling
gemini-calls routes.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..services import google_calendar as gcal

log = logging.getLogger("google_calendar_route")
router = APIRouter()


@router.get("/status")
async def status():
    configured = gcal.is_configured()
    if not configured:
        return {"configured": False, "connected": False, "message": "Google credentials not set in environment."}
    try:
        await gcal.get_access_token(force=False)
        return {
            "configured": True,
            "connected": True,
            "calendar_id": gcal_config_calendar_id(),
            "timezone": gcal_config_timezone(),
        }
    except Exception as e:
        log.warning("calendar status: token refresh failed: %s", e)
        return {"configured": True, "connected": False, "message": str(e)}


def gcal_config_calendar_id() -> str:
    from ... import config
    return config.GOOGLE_CALENDAR_ID


def gcal_config_timezone() -> str:
    from ... import config
    return config.CALENDAR_TIMEZONE


@router.get("/doctors")
async def doctors():
    return {"doctors": gcal.DOCTORS}


@router.get("/events")
async def events(
    start: Optional[str] = Query(None, description="ISO date/datetime; defaults to start of current week"),
    end: Optional[str] = Query(None, description="ISO date/datetime; defaults to start + 7 days"),
):
    tz = gcal._tz()
    if start:
        time_min = gcal.parse_date(start) if len(start) <= 10 else datetime.fromisoformat(start)
        if time_min.tzinfo is None:
            time_min = time_min.replace(tzinfo=tz)
    else:
        now = datetime.now(tz)
        # Start of the current week (Sunday), to match the calendar grid.
        time_min = (now - timedelta(days=(now.weekday() + 1) % 7)).replace(hour=0, minute=0, second=0, microsecond=0)
    if end:
        time_max = gcal.parse_date(end) if len(end) <= 10 else datetime.fromisoformat(end)
        if time_max.tzinfo is None:
            time_max = time_max.replace(tzinfo=tz)
    else:
        time_max = time_min + timedelta(days=7)

    try:
        items = await gcal.list_events(time_min, time_max)
    except Exception as e:
        log.exception("events failed")
        raise HTTPException(status_code=502, detail=str(e))
    return {"status": "ok", "start": time_min.isoformat(), "end": time_max.isoformat(), "events": items}


@router.get("/availability")
async def availability(date: Optional[str] = Query(None, description="YYYY-MM-DD; defaults to today")):
    tz = gcal._tz()
    day = gcal.parse_date(date) if date else datetime.now(tz)
    return await gcal.get_availability_for_day(day)


class BookRequest(BaseModel):
    patient_name: str
    doctor: str
    date: str
    time: str
    department: Optional[str] = None
    reason: Optional[str] = None


@router.post("/book")
async def book(req: BookRequest):
    result = await gcal.book_appointment_event(
        patient_name=req.patient_name,
        doctor=req.doctor,
        date=req.date,
        time_str=req.time,
        department=req.department,
        reason=req.reason,
    )
    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("message"))
    return result
