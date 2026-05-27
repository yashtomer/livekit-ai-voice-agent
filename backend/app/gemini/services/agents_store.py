"""
Read/write access to the gemini_agents table.

Used by:
  - /api/agents routes (CRUD)
  - twilio_bridge / vobiz_bridge (resolve default phone agent at call time)
  - startup seed (populate built-in agents on first boot)
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import select

from ...db import SessionLocal
from ..agents import AGENTS, DEFAULT_PHONE_AGENT
from ..models.agent import GeminiAgent

log = logging.getLogger("agents_store")


# Built-in seed metadata. The system_prompt text is sourced from agents.py.
_BUILTIN_SEED = [
    {
        "slug": "healthcare_booking",
        "name": "Healthcare Booking",
        "description": "Medical appointment booking — strict one question per turn, uses get_doctors_by_department tool.",
        "voice": "Aoede",
        "is_default_phone": True,
    },
    {
        "slug": "general_assistant",
        "name": "General Assistant",
        "description": "Friendly, concise voice assistant for general questions.",
        "voice": "Aoede",
        "is_default_phone": False,
    },
    {
        "slug": "customer_support",
        "name": "Customer Support",
        "description": "QuickKart e-commerce support agent (Maya). Warm, empathetic, solution-oriented.",
        "voice": "Kore",
        "is_default_phone": False,
    },
    {
        "slug": "sales_agent",
        "name": "Sales Agent",
        "description": "SoftNest outbound sales agent (Riya). Confident, consultative, not pushy.",
        "voice": "Zephyr",
        "is_default_phone": False,
    },
]


async def seed_builtin_agents() -> None:
    """Insert built-in agents on first boot. Idempotent — only inserts rows
    whose slug is missing."""
    try:
        async with SessionLocal() as db:
            existing = (await db.execute(select(GeminiAgent.slug))).scalars().all()
            existing_set = set(existing)
            added = 0
            for seed in _BUILTIN_SEED:
                if seed["slug"] in existing_set:
                    continue
                prompt = AGENTS.get(seed["slug"], DEFAULT_PHONE_AGENT)
                db.add(GeminiAgent(
                    slug=seed["slug"],
                    name=seed["name"],
                    description=seed["description"],
                    system_prompt=prompt,
                    language="en",
                    voice=seed["voice"],
                    is_builtin=True,
                    is_default_phone=seed["is_default_phone"],
                ))
                added += 1
            if added:
                await db.commit()
                log.info("Seeded %d built-in agents", added)
    except Exception:
        log.exception("seed_builtin_agents failed")


async def get_default_phone_agent() -> Optional[GeminiAgent]:
    """Return the agent currently marked is_default_phone. Falls back to None."""
    try:
        async with SessionLocal() as db:
            row = (await db.execute(
                select(GeminiAgent).where(GeminiAgent.is_default_phone.is_(True)).limit(1)
            )).scalar_one_or_none()
            return row
    except Exception:
        log.exception("get_default_phone_agent failed")
        return None
