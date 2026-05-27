from datetime import datetime
from typing import Any, Optional
from sqlalchemy import Boolean, DateTime, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column
from ...db import Base


class GeminiTool(Base):
    """A tool/function that agents can invoke during a live session.

    Tools come in two flavours:
      - is_builtin=True  → dispatched via the Python registry in agent_tools.py
                          (url is null). E.g. get_doctors_by_department.
      - is_builtin=False → dispatched as an HTTP request to `url`, with the
                          tool's parameter values mapped into query string (GET)
                          or JSON body (POST). Response is forwarded back to
                          Gemini verbatim as the tool result.
    """
    __tablename__ = "gemini_tools"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)  # LLM-facing
    http_method: Mapped[str] = mapped_column(String(8), nullable=False, default="GET")
    url: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    headers: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)  # {header: value}
    parameters: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    # list of {name, type, required, description}
    response_schema: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    # list of {key, type, description} — for LLM documentation
    is_builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, onupdate=func.now())
