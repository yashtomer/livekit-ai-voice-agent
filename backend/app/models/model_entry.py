import enum
from datetime import datetime
from typing import Any, Optional
from sqlalchemy import Boolean, DateTime, Enum, Float, Integer, JSON, String, func
from sqlalchemy.orm import Mapped, mapped_column
from ..db import Base


class ModelType(str, enum.Enum):
    stt = "stt"
    llm = "llm"
    tts = "tts"


class ModelEntry(Base):
    __tablename__ = "model_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    model_type: Mapped[ModelType] = mapped_column(Enum(ModelType), nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False)
    label: Mapped[str] = mapped_column(String(500), nullable=False)
    price_per_hour: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True)
    config: Mapped[Optional[Any]] = mapped_column(JSON, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=100)
    # Hardware footprint hint used by the cost estimator to pick a server tier.
    # One of: none | cpu_light | cpu_heavy | gpu_small | gpu_mid | gpu_large.
    compute_profile: Mapped[str] = mapped_column(
        String(32), default="none", nullable=False
    )
    min_vram_gb: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # True when the row was inserted/updated from SEED_MODELS. Flipped to False
    # the moment an admin PATCHes the row, so future re-seeds don't clobber.
    is_seed: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
