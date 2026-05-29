"""
CRUD API for dynamic Gemini agents.

Routes (mounted under /api/agents):
  GET    /            — list all agents
  POST   /            — create a new agent (sets is_builtin=False)
  GET    /{id}        — get one agent
  PATCH  /{id}        — update fields (builtin agents: prompt/voice/language/desc only; name/slug locked)
  DELETE /{id}        — delete (forbidden if is_builtin)
  POST   /{id}/default-phone  — mark this agent as the default phone agent (clears others)
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, constr
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ...db import get_db
from ..models.agent import GeminiAgent

router = APIRouter()


# ── Pydantic schemas ─────────────────────────────────────────────────────────

class AgentCreate(BaseModel):
    name: constr(strip_whitespace=True, min_length=1, max_length=128)
    description: Optional[constr(strip_whitespace=True, max_length=255)] = None
    system_prompt: constr(strip_whitespace=True, min_length=1)
    language: constr(strip_whitespace=True, min_length=1, max_length=16) = "en"
    voice: constr(strip_whitespace=True, min_length=1, max_length=64) = "Aoede"
    tool_ids: list[int] = []
    kb_collection_ids: list[int] = []
    ambient_always: Optional[constr(strip_whitespace=True, max_length=64)] = None
    ambient_tool_call: Optional[constr(strip_whitespace=True, max_length=64)] = None
    ambient_volume: Optional[float] = Field(default=0.15, ge=0.0, le=1.0)


class AgentUpdate(BaseModel):
    name: Optional[constr(strip_whitespace=True, min_length=1, max_length=128)] = None
    description: Optional[constr(strip_whitespace=True, max_length=255)] = None
    system_prompt: Optional[constr(strip_whitespace=True, min_length=1)] = None
    language: Optional[constr(strip_whitespace=True, min_length=1, max_length=16)] = None
    voice: Optional[constr(strip_whitespace=True, min_length=1, max_length=64)] = None
    tool_ids: Optional[list[int]] = None
    kb_collection_ids: Optional[list[int]] = None
    ambient_always: Optional[str] = None
    ambient_tool_call: Optional[str] = None
    ambient_volume: Optional[float] = Field(default=None, ge=0.0, le=1.0)


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(name: str) -> str:
    s = _SLUG_RE.sub("_", name.lower()).strip("_")
    return s or f"agent_{int(datetime.utcnow().timestamp())}"


def _serialize(row: GeminiAgent) -> dict:
    return {
        "id": row.id,
        "slug": row.slug,
        "name": row.name,
        "description": row.description,
        "system_prompt": row.system_prompt,
        "language": row.language,
        "voice": row.voice,
        "tool_ids": list(row.tool_ids or []),
        "kb_collection_ids": list(getattr(row, "kb_collection_ids", None) or []),
        "ambient_always":    row.ambient_always,
        "ambient_tool_call": row.ambient_tool_call,
        "ambient_volume":    row.ambient_volume,
        "is_builtin": row.is_builtin,
        "is_default_phone": row.is_default_phone,
        "created_at": row.created_at.isoformat() + "Z" if row.created_at else None,
        "updated_at": row.updated_at.isoformat() + "Z" if row.updated_at else None,
    }


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("/")
async def list_agents(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(GeminiAgent).order_by(GeminiAgent.is_builtin.desc(), GeminiAgent.created_at.asc())
    )).scalars().all()
    return {"items": [_serialize(r) for r in rows]}


@router.post("/")
async def create_agent(body: AgentCreate, db: AsyncSession = Depends(get_db)):
    base_slug = _slugify(body.name)
    slug = base_slug
    i = 1
    while (await db.execute(select(GeminiAgent.id).where(GeminiAgent.slug == slug))).scalar_one_or_none():
        i += 1
        slug = f"{base_slug}_{i}"
    row = GeminiAgent(
        slug=slug,
        name=body.name,
        description=body.description,
        system_prompt=body.system_prompt,
        language=body.language,
        voice=body.voice,
        tool_ids=list(body.tool_ids or []),
        kb_collection_ids=list(body.kb_collection_ids or []),
        ambient_always=body.ambient_always or None,
        ambient_tool_call=body.ambient_tool_call or None,
        ambient_volume=body.ambient_volume if body.ambient_volume is not None else 0.15,
        is_builtin=False,
        is_default_phone=False,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _serialize(row)


@router.get("/{agent_id}")
async def get_agent(agent_id: int, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(GeminiAgent).where(GeminiAgent.id == agent_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Agent not found")
    return _serialize(row)


@router.patch("/{agent_id}")
async def update_agent(agent_id: int, body: AgentUpdate, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(GeminiAgent).where(GeminiAgent.id == agent_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Agent not found")
    data = body.model_dump(exclude_unset=True)
    if row.is_builtin and "name" in data:
        # Lock the display name of built-in agents
        data.pop("name", None)
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    return _serialize(row)


@router.delete("/{agent_id}")
async def delete_agent(agent_id: int, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(GeminiAgent).where(GeminiAgent.id == agent_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Agent not found")
    if row.is_builtin:
        raise HTTPException(400, "Built-in agents cannot be deleted")
    if row.is_default_phone:
        raise HTTPException(400, "Cannot delete the default phone agent. Mark another agent as default first.")
    await db.delete(row)
    await db.commit()
    return {"status": "deleted", "id": agent_id}


@router.post("/{agent_id}/default-phone")
async def set_default_phone(agent_id: int, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(GeminiAgent).where(GeminiAgent.id == agent_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Agent not found")
    await db.execute(update(GeminiAgent).values(is_default_phone=False))
    row.is_default_phone = True
    await db.commit()
    await db.refresh(row)
    return _serialize(row)
