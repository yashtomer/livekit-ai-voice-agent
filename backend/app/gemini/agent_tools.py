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


# ── Static mock data (replace with DB later) ────────────────────────────────

_DOCTORS_BY_DEPARTMENT: dict[str, list[dict[str, str]]] = {
    "cardiology": [
        {"name": "Dr. Anjali Mehta",   "qualification": "MD, DM Cardiology"},
        {"name": "Dr. Rohan Khanna",   "qualification": "MD, DNB Cardiology"},
    ],
    "dermatology": [
        {"name": "Dr. Sneha Iyer",     "qualification": "MD Dermatology"},
        {"name": "Dr. Karan Verma",    "qualification": "MD, DDV"},
    ],
    "orthopedics": [
        {"name": "Dr. Vikram Singh",   "qualification": "MS Orthopedics"},
        {"name": "Dr. Priya Nair",     "qualification": "MS, DNB Orthopedics"},
    ],
    "pediatrics": [
        {"name": "Dr. Aarti Sharma",   "qualification": "MD Pediatrics"},
        {"name": "Dr. Suresh Gupta",   "qualification": "MD, DCH"},
    ],
    "neurology": [
        {"name": "Dr. Meera Krishnan", "qualification": "MD, DM Neurology"},
    ],
    "general medicine": [
        {"name": "Dr. Rajesh Kumar",   "qualification": "MBBS, MD General Medicine"},
        {"name": "Dr. Sunita Patel",   "qualification": "MBBS, MD"},
    ],
    "ent": [
        {"name": "Dr. Amit Joshi",     "qualification": "MS ENT"},
    ],
    "gynecology": [
        {"name": "Dr. Pooja Reddy",    "qualification": "MS, DGO"},
        {"name": "Dr. Lakshmi Rao",    "qualification": "MD Gynecology"},
    ],
}


# ── Tool implementations ─────────────────────────────────────────────────────

def get_doctors_by_department(department: str) -> dict[str, Any]:
    """Return the list of doctors available in a given department.

    Matching is case-insensitive and tolerates minor variants.
    """
    key = (department or "").strip().lower()

    # Tolerate common variations
    aliases = {
        "heart": "cardiology",
        "skin": "dermatology",
        "ortho": "orthopedics",
        "bone": "orthopedics",
        "child": "pediatrics",
        "paediatrics": "pediatrics",
        "brain": "neurology",
        "physician": "general medicine",
        "gp": "general medicine",
        "general": "general medicine",
        "ear nose throat": "ent",
        "women": "gynecology",
        "obgyn": "gynecology",
    }
    key = aliases.get(key, key)

    doctors = _DOCTORS_BY_DEPARTMENT.get(key)
    if not doctors:
        return {
            "status": "not_found",
            "message": (
                f"No doctors found for '{department}'. "
                f"Available departments: {', '.join(sorted(_DOCTORS_BY_DEPARTMENT.keys()))}."
            ),
        }

    return {
        "status": "ok",
        "department": key,
        "doctors": doctors,
    }


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
