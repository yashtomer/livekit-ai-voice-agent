from datetime import datetime
from typing import Any, Optional
from sqlalchemy import Boolean, DateTime, Float, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column
from ...db import Base


class GeminiAgent(Base):
    __tablename__ = "gemini_agents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(String(16), nullable=False, default="en")
    voice: Mapped[str] = mapped_column(String(64), nullable=False, default="Aoede")
    tool_ids: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)  # list[int]
    # Knowledge-base collections the agent can search via the search_knowledge_base tool.
    kb_collection_ids: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)  # list[int]
    # Ambient sound mixed into the agent's outgoing audio.
    # `ambient_always`     — plays softly under every reply (null = off).
    # `ambient_tool_call`  — plays only during tool-call dispatch (null = off).
    # Volume in [0, 1] applied to whichever ambient is currently active.
    ambient_always: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    ambient_tool_call: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    ambient_volume: Mapped[float] = mapped_column(Float, nullable=False, default=0.15)
    is_builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_default_phone: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, onupdate=func.now())
