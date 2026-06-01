from datetime import datetime
from typing import Any, Optional
from sqlalchemy import DateTime, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column
from ...db import Base


class GeminiCallLog(Base):
    __tablename__ = "gemini_call_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    call_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)  # browser | twilio | vobiz
    direction: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)     # inbound | outbound | None
    phone_number: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    language: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    voice: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    system_prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    transcript: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")  # active | ended | error
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    duration_s: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Post-call AI analysis (generated once at end_call from the transcript).
    # summary       — 1–2 sentence recap of the call.
    # sentiment     — overall caller sentiment: positive | neutral | negative.
    # extracted     — structured fields pulled from the conversation (free-form
    #                 key/value object, e.g. {patient_name, doctor, date, time}).
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sentiment: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    extracted: Mapped[Any] = mapped_column(JSON, nullable=True)
