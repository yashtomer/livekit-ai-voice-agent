"""
Tool definitions for the Gemini Live voice agent.

How it works:
  - Each tool is a Python function plus a Gemini `FunctionDeclaration`.
  - We register them with `LiveConnectConfig(tools=[...])`.
  - When Gemini decides to call a tool, the session yields a `tool_call` event.
  - We run the matching local function and send the result back via
    `session.send_tool_response(...)`.

To add a new tool:
  1. Write the function below.
  2. Add a `types.FunctionDeclaration` for it in `FUNCTION_DECLARATIONS`.
  3. Register it in `TOOL_REGISTRY` keyed by the same name.

For now the doctor lookup is hard-coded; later replace with a DB query.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

log = logging.getLogger("agent_tools")


# ── Tool implementations ─────────────────────────────────────────────────────

def _roster_by_department() -> dict[str, list[dict[str, str]]]:
    """Build the department→doctors map from the Google Calendar roster so the
    names the agent offers always match what `book_appointment` can book."""
    from .services.google_calendar import DOCTORS as ROSTER
    out: dict[str, list[dict[str, str]]] = {}
    for d in ROSTER:
        out.setdefault(d["department"].lower(), []).append(
            {"name": d["name"], "department": d["department"]}
        )
    return out


def get_doctors_by_department(department: str) -> dict[str, Any]:
    """Return the list of doctors available in a given department.

    Sourced from the Google Calendar roster (see services/google_calendar.DOCTORS)
    so the offered names are exactly the ones `book_appointment` accepts. Matching
    is case-insensitive and tolerates common variants.
    """
    by_dept = _roster_by_department()
    key = (department or "").strip().lower()

    # Tolerate common variations → canonical roster department names.
    aliases = {
        "heart": "cardiology",
        "cardiac": "cardiology",
        "ortho": "orthopedics",
        "orthopaedics": "orthopedics",
        "bone": "orthopedics",
        "gp": "general physician",
        "general medicine": "general physician",
        "general": "general physician",
        "physician": "general physician",
        "family medicine": "general physician",
    }
    key = aliases.get(key, key)

    doctors = by_dept.get(key)
    if not doctors:
        return {
            "status": "not_found",
            "message": (
                f"No doctors found for '{department}'. "
                f"Available departments: {', '.join(sorted(by_dept.keys()))}."
            ),
        }

    return {
        "status": "ok",
        "department": key,
        "doctors": doctors,
    }


async def book_appointment(
    patient_name: str,
    doctor: str,
    date: str,
    time: str,
    department: str = "",
    reason: str = "",
    summary: str = "",
) -> dict[str, Any]:
    """Book a real appointment on the clinic's Google Calendar.

    Async builtin — the runtime awaits it. Delegates to the Google Calendar
    service which resolves the doctor, checks the slot, and creates the event.
    `summary` is a short recap/outcome of the call stored on the event.
    """
    from .services.google_calendar import book_appointment_event
    return await book_appointment_event(
        patient_name=patient_name,
        doctor=doctor,
        date=date,
        time_str=time,
        department=department or None,
        reason=reason or None,
        summary=summary or None,
    )


async def book_calendar_event(
    title: str,
    date: str,
    time: str,
    attendee_name: str = "",
    duration_minutes: int = 60,
    summary: str = "",
) -> dict[str, Any]:
    """Generic Google Calendar booking for ANY agent/domain (no clinic/doctor
    rules). Use for real-estate viewings, salon slots, demos, callbacks, etc.

    Async builtin — the runtime awaits it. `summary` is a short recap/outcome of
    the call stored in the event description.
    """
    from .services.google_calendar import book_generic_event
    return await book_generic_event(
        title=title,
        attendee_name=attendee_name or None,
        date=date,
        time_str=time,
        duration_minutes=duration_minutes or 60,
        summary=summary or None,
    )


def transfer_call(reason: str = "") -> dict[str, Any]:
    """Browser-call fallback for the transfer_call tool.

    On phone calls (Twilio/Vobiz) the bridge intercepts `transfer_call` and
    performs a real telephony transfer. On browser calls there is no PSTN leg
    to redirect, so we return a graceful message the agent can read out.
    """
    log.info("transfer_call requested (browser, no PSTN leg): reason=%r", reason)
    return {
        "status": "unavailable",
        "message": (
            "Live transfer to a human is only available on phone calls. "
            "Please offer to take a message or share a callback number."
        ),
    }


# ── Gemini FunctionDeclarations + registry ───────────────────────────────────

def _build_function_declarations():
    """Built lazily so importing this module doesn't require google-genai."""
    from google.genai import types

    return [
        types.FunctionDeclaration(
            name="get_doctors_by_department",
            description=(
                "Look up the doctors available in a specified medical department "
                "(e.g. cardiology, dermatology, pediatrics). Call this whenever "
                "the caller mentions which department or specialty they need so "
                "you can offer real doctor names."
            ),
            parameters={
                "type": "OBJECT",
                "properties": {
                    "department": {
                        "type": "STRING",
                        "description": (
                            "Department or medical specialty name, e.g. "
                            "'cardiology', 'orthopedics', 'ENT'."
                        ),
                    },
                },
                "required": ["department"],
            },
        ),
        types.FunctionDeclaration(
            name="book_appointment",
            description=(
                "Book a confirmed appointment on the clinic's Google Calendar. Call this "
                "once you have collected the caller's full name, the doctor they want, the "
                "department, and a date and time within clinic hours (09:00–17:00). Typically "
                "called near the end of the call to finalise the booking. Returns status='ok' "
                "with a confirmation message on success, or status='unavailable'/'error' "
                "(read the message out and offer another slot)."
            ),
            parameters={
                "type": "OBJECT",
                "properties": {
                    "patient_name": {"type": "STRING", "description": "The caller / patient's full name."},
                    "doctor": {"type": "STRING", "description": "Doctor name, e.g. 'Dr. John Smith' (or just 'Smith')."},
                    "date": {"type": "STRING", "description": "Appointment date as YYYY-MM-DD."},
                    "time": {"type": "STRING", "description": "Start time within 09:00–17:00, e.g. '14:00' or '2pm'."},
                    "department": {"type": "STRING", "description": "Department/specialty (optional; inferred from the doctor if omitted)."},
                    "reason": {"type": "STRING", "description": "Short reason for the visit (optional)."},
                },
                "required": ["patient_name", "doctor", "date", "time"],
            },
        ),
        types.FunctionDeclaration(
            name="transfer_call",
            description=(
                "Hand the call off to a live human agent. Call this when the caller "
                "explicitly asks to speak to a human/manager/person, OR when they are "
                "clearly frustrated or upset and you cannot resolve their issue. "
                "Before calling it, briefly tell the caller you're connecting them now. "
                "On phone calls this redirects the call to a human; on browser calls it "
                "is not available (you'll get status='unavailable')."
            ),
            parameters={
                "type": "OBJECT",
                "properties": {
                    "reason": {
                        "type": "STRING",
                        "description": "Short reason for the transfer (e.g. 'caller frustrated', 'requested manager').",
                    },
                },
                "required": [],
            },
        ),
    ]


# name → callable mapping used by the live-session tool dispatcher
TOOL_REGISTRY: dict[str, Callable[..., Any]] = {
    "get_doctors_by_department": get_doctors_by_department,
    "book_appointment": book_appointment,
    "book_calendar_event": book_calendar_event,
    "transfer_call": transfer_call,
}


def make_tools():
    """Return a list of `types.Tool` ready to drop into LiveConnectConfig."""
    from google.genai import types
    return [types.Tool(function_declarations=_build_function_declarations())]


def dispatch_tool_call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Run the tool function and return its result. Errors are wrapped so
    the agent gets a structured response instead of an exception."""
    fn = TOOL_REGISTRY.get(name)
    if fn is None:
        return {"status": "error", "message": f"Unknown tool: {name}"}
    try:
        return fn(**(args or {}))
    except Exception as e:
        log.exception("Tool %s failed", name)
        return {"status": "error", "message": str(e)}
