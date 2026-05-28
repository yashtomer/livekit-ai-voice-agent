"""
Registered ambience choices. Each entry has:

  slug        — stable identifier stored on Agent rows
  label       — human-readable name shown in the UI
  category    — 'always' | 'tool_call' | 'both'   (drives which picker shows it)
  description — short hint shown next to the option

Procedural generators live in ``synth.py``; real WAVs (if present) override
the procedural sound for the same slug.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class AmbienceDef:
    slug: str
    label: str
    category: str          # 'always' | 'tool_call' | 'both'
    description: str


AMBIENCE_REGISTRY: tuple[AmbienceDef, ...] = (
    AmbienceDef("office_busy",   "Busy office",          "always",    "Open-plan office: low chatter, periodic phone ring."),
    AmbienceDef("office_quiet",  "Quiet office",         "always",    "Distant keyboards and HVAC hum."),
    AmbienceDef("call_center",   "Call center",          "always",    "Several agents talking on calls in the background."),
    AmbienceDef("cafe",          "Cafe",                 "always",    "Coffee shop: cups, light chatter, espresso machine."),
    AmbienceDef("elevator",      "Elevator music",       "always",    "Soft instrumental hold-music."),
    AmbienceDef("street",        "Street / outdoor",     "always",    "Distant traffic and wind."),

    AmbienceDef("typing",        "Typing",               "tool_call", "Mechanical keyboard typing, played during tool calls."),
    AmbienceDef("mouse_clicks",  "Mouse clicks",         "tool_call", "Sporadic mouse clicks — searching a system."),
    AmbienceDef("processing",    "Processing beeps",     "tool_call", "Soft computer beeps — looking something up."),
    AmbienceDef("paper_shuffle", "Paper shuffle",        "tool_call", "Pages turning — checking a file."),
)


def list_ambience() -> list[dict]:
    """JSON-serializable description of every registered ambience."""
    return [
        {"slug": a.slug, "label": a.label, "category": a.category, "description": a.description}
        for a in AMBIENCE_REGISTRY
    ]


def by_slug(slug: str | None) -> AmbienceDef | None:
    if not slug:
        return None
    for a in AMBIENCE_REGISTRY:
        if a.slug == slug:
            return a
    return None


def slugs(category: str | None = None) -> Iterable[str]:
    for a in AMBIENCE_REGISTRY:
        if category is None or a.category in (category, "both"):
            yield a.slug
