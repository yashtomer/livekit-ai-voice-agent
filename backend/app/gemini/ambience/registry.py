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
    # `always` — real recordings (assets/*.wav) override the procedural synth.
    AmbienceDef("office_busy",   "Busy office",          "always",    "Open-plan office background — looped recording."),
    AmbienceDef("office_quiet",  "Office environment",   "always",    "General office room tone — keyboards, movement, HVAC."),
    AmbienceDef("call_center",   "Call center",          "always",    "Distant people talking in the background."),
    AmbienceDef("cafe",          "Cafe",                 "always",    "Coffee shop: cups, light chatter, espresso machine."),
    AmbienceDef("elevator",      "Elevator music",       "always",    "Soft instrumental hold-music."),
    AmbienceDef("street",        "Street / outdoor",     "always",    "Distant traffic and wind."),

    # `tool_call` — played only while the agent runs a tool / looks something up.
    AmbienceDef("typing",          "Keyboard typing",    "tool_call", "Close mechanical keyboard typing — recording."),
    AmbienceDef("community_typing", "Community typing",   "tool_call", "A room of people typing on keyboards — recording."),
    AmbienceDef("paper_shuffle",   "Paper scroll",       "tool_call", "Shuffling and scrolling through papers — recording."),
    AmbienceDef("mouse_clicks",    "Mouse clicks",       "tool_call", "Sporadic mouse clicks — searching a system."),
    AmbienceDef("processing",      "Processing beeps",   "tool_call", "Soft computer beeps — looking something up."),
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
