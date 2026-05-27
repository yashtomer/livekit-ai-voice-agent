"""
CRUD API for dynamic Gemini tools (HTTP-callable functions).

Routes (mounted under /api/tools):
  GET    /         — list all tools
  POST   /         — create a new tool
  GET    /{id}     — get one tool
  PATCH  /{id}     — update fields (builtin: url/method locked, others editable)
  DELETE /{id}     — delete (forbidden if is_builtin)
  POST   /{id}/test — fire the tool with the supplied args and return its response (preview)
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, constr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ...db import get_db
from ..models.tool import GeminiTool
from ..services.tools_runtime import dispatch_tool_call

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────

class ToolParam(BaseModel):
    name: constr(strip_whitespace=True, min_length=1, max_length=64)
    type: constr(strip_whitespace=True, max_length=16) = "string"
    required: bool = False
    description: constr(strip_whitespace=True, max_length=500) = ""


class ToolResponseKey(BaseModel):
    key: constr(strip_whitespace=True, min_length=1, max_length=64)
    type: constr(strip_whitespace=True, max_length=16) = "string"
    description: constr(strip_whitespace=True, max_length=500) = ""


class ToolCreate(BaseModel):
    name: constr(strip_whitespace=True, min_length=1, max_length=128)
    description: constr(strip_whitespace=True, min_length=1)
    http_method: constr(strip_whitespace=True, max_length=8) = "GET"
    url: constr(strip_whitespace=True, max_length=2000)
    headers: dict[str, str] = Field(default_factory=dict)
    parameters: List[ToolParam] = Field(default_factory=list)
    response_schema: List[ToolResponseKey] = Field(default_factory=list)


class ToolUpdate(BaseModel):
    name: Optional[constr(strip_whitespace=True, min_length=1, max_length=128)] = None
    description: Optional[constr(strip_whitespace=True, min_length=1)] = None
    http_method: Optional[constr(strip_whitespace=True, max_length=8)] = None
    url: Optional[constr(strip_whitespace=True, max_length=2000)] = None
    headers: Optional[dict[str, str]] = None
    parameters: Optional[List[ToolParam]] = None
    response_schema: Optional[List[ToolResponseKey]] = None


class ToolTestRequest(BaseModel):
    args: dict[str, Any] = Field(default_factory=dict)


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(name: str) -> str:
    s = _SLUG_RE.sub("_", name.lower()).strip("_")
    return s or f"tool_{int(datetime.utcnow().timestamp())}"


def _serialize(row: GeminiTool) -> dict:
    return {
        "id": row.id,
        "slug": row.slug,
        "name": row.name,
        "description": row.description,
        "http_method": row.http_method,
        "url": row.url,
        "headers": row.headers or {},
        "parameters": row.parameters or [],
        "response_schema": row.response_schema or [],
        "is_builtin": row.is_builtin,
        "created_at": row.created_at.isoformat() + "Z" if row.created_at else None,
        "updated_at": row.updated_at.isoformat() + "Z" if row.updated_at else None,
    }


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("/")
async def list_tools(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(GeminiTool).order_by(GeminiTool.is_builtin.desc(), GeminiTool.created_at.asc())
    )).scalars().all()
    return {"items": [_serialize(r) for r in rows]}


@router.post("/")
async def create_tool(body: ToolCreate, db: AsyncSession = Depends(get_db)):
    base_slug = _slugify(body.name)
    slug = base_slug
    i = 1
    while (await db.execute(select(GeminiTool.id).where(GeminiTool.slug == slug))).scalar_one_or_none():
        i += 1
        slug = f"{base_slug}_{i}"
    row = GeminiTool(
        slug=slug,
        name=body.name,
        description=body.description,
        http_method=body.http_method.upper(),
        url=body.url,
        headers=body.headers,
        parameters=[p.model_dump() for p in body.parameters],
        response_schema=[r.model_dump() for r in body.response_schema],
        is_builtin=False,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _serialize(row)


@router.get("/{tool_id}")
async def get_tool(tool_id: int, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(GeminiTool).where(GeminiTool.id == tool_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Tool not found")
    return _serialize(row)


@router.patch("/{tool_id}")
async def update_tool(tool_id: int, body: ToolUpdate, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(GeminiTool).where(GeminiTool.id == tool_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Tool not found")
    data = body.model_dump(exclude_unset=True)
    if "http_method" in data:
        data["http_method"] = data["http_method"].upper()
    if "parameters" in data and data["parameters"] is not None:
        data["parameters"] = [p if isinstance(p, dict) else p.model_dump() for p in data["parameters"]]
    if "response_schema" in data and data["response_schema"] is not None:
        data["response_schema"] = [r if isinstance(r, dict) else r.model_dump() for r in data["response_schema"]]
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    return _serialize(row)


@router.delete("/{tool_id}")
async def delete_tool(tool_id: int, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(GeminiTool).where(GeminiTool.id == tool_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Tool not found")
    if row.is_builtin:
        raise HTTPException(400, "Built-in tools cannot be deleted")
    await db.delete(row)
    await db.commit()
    return {"status": "deleted", "id": tool_id}


@router.post("/{tool_id}/test")
async def test_tool(tool_id: int, body: ToolTestRequest, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(GeminiTool).where(GeminiTool.id == tool_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Tool not found")
    result = await dispatch_tool_call([row.id], row.slug, body.args)
    return {"tool": row.slug, "args": body.args, "result": result}
