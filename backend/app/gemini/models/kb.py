from datetime import datetime
from typing import Optional

from sqlalchemy import (
    BigInteger, DateTime, ForeignKey, Integer, LargeBinary, String, Text, func
)
from sqlalchemy.orm import Mapped, mapped_column

from ...db import Base

# pgvector's SQLAlchemy adapter — installed via `pgvector` Python package.
try:
    from pgvector.sqlalchemy import Vector
except ImportError:  # noqa: F401 — graceful boot if extension/lib missing
    Vector = None   # type: ignore[assignment]


EMBED_DIM = 768  # gemini-embedding-001 truncated to 768 via output_dimensionality


class GeminiKbCollection(Base):
    __tablename__ = "gemini_kb_collections"

    id:              Mapped[int] = mapped_column(Integer, primary_key=True)
    slug:            Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name:            Mapped[str] = mapped_column(String(128), nullable=False)
    description:     Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    embedding_model: Mapped[str] = mapped_column(String(64), nullable=False, default="gemini-embedding-001")
    chunk_size:      Mapped[int] = mapped_column(Integer, nullable=False, default=600)
    chunk_overlap:   Mapped[int] = mapped_column(Integer, nullable=False, default=80)
    document_count:  Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    chunk_count:     Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at:      Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at:      Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, onupdate=func.now())


class GeminiKbDocument(Base):
    __tablename__ = "gemini_kb_documents"

    id:            Mapped[int] = mapped_column(Integer, primary_key=True)
    collection_id: Mapped[int] = mapped_column(Integer, ForeignKey("gemini_kb_collections.id", ondelete="CASCADE"), nullable=False, index=True)
    source:        Mapped[str] = mapped_column(String(16), nullable=False)   # 'upload' | 'text'
    filename:      Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    mime_type:     Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    sha256:        Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    char_count:    Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    chunk_count:   Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status:        Mapped[str] = mapped_column(String(16), nullable=False, default="pending")  # pending | processing | ready | failed
    error:         Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    raw_bytes:     Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    raw_text:      Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at:    Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    indexed_at:    Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class GeminiKbChunk(Base):
    __tablename__ = "gemini_kb_chunks"

    id:            Mapped[int] = mapped_column(BigInteger, primary_key=True)
    document_id:   Mapped[int] = mapped_column(Integer, ForeignKey("gemini_kb_documents.id", ondelete="CASCADE"), nullable=False, index=True)
    collection_id: Mapped[int] = mapped_column(Integer, ForeignKey("gemini_kb_collections.id", ondelete="CASCADE"), nullable=False, index=True)
    chunk_index:   Mapped[int] = mapped_column(Integer, nullable=False)
    page_number:   Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    content:       Mapped[str] = mapped_column(Text, nullable=False)
    token_count:   Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Embedding is mapped only when the pgvector library is available; falls
    # back to a deferred column otherwise so the rest of the app can boot.
    if Vector is not None:
        embedding: Mapped[Optional[list[float]]] = mapped_column(Vector(EMBED_DIM), nullable=True)
