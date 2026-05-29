"""
Knowledge-base API (mounted under /api/kb).

  GET    /collections                          — list collections
  POST   /collections                          — create
  GET    /collections/{id}                     — one
  PATCH  /collections/{id}                     — rename / tune chunking
  DELETE /collections/{id}                     — drop collection + cascade docs/chunks

  GET    /collections/{id}/documents           — list docs
  POST   /collections/{id}/documents           — upload (multipart) OR JSON text body
  DELETE /collections/{id}/documents/{doc_id}  — drop one doc + its chunks
  POST   /collections/{id}/documents/{doc_id}/reindex — re-embed

  POST   /collections/{id}/search              — top-k similarity test (UI debug)
"""

from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field, constr
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ...db import get_db
from ..models.kb import GeminiKbChunk, GeminiKbCollection, GeminiKbDocument
from ..kb.pipeline import ingest_document, _recompute_collection_counts
from ..kb.search import search as kb_search

log = logging.getLogger("kb.routes")

router = APIRouter()

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(name: str) -> str:
    s = _SLUG_RE.sub("_", name.lower()).strip("_")
    return s or f"kb_{int(datetime.utcnow().timestamp())}"


# ── Schemas ─────────────────────────────────────────────────────────────────

class CollectionCreate(BaseModel):
    name: constr(strip_whitespace=True, min_length=1, max_length=128)
    description: Optional[constr(strip_whitespace=True, max_length=500)] = None
    chunk_size: int = Field(default=600, ge=100, le=4000)
    chunk_overlap: int = Field(default=80, ge=0, le=1000)


class CollectionUpdate(BaseModel):
    name: Optional[constr(strip_whitespace=True, min_length=1, max_length=128)] = None
    description: Optional[constr(strip_whitespace=True, max_length=500)] = None
    chunk_size: Optional[int] = Field(default=None, ge=100, le=4000)
    chunk_overlap: Optional[int] = Field(default=None, ge=0, le=1000)


class TextDocumentCreate(BaseModel):
    title: constr(strip_whitespace=True, min_length=1, max_length=255)
    content: constr(strip_whitespace=True, min_length=1)


class SearchRequest(BaseModel):
    query: constr(strip_whitespace=True, min_length=1, max_length=2000)
    top_k: int = Field(default=5, ge=1, le=25)


def _serialize_collection(row: GeminiKbCollection) -> dict:
    return {
        "id":             row.id,
        "slug":           row.slug,
        "name":           row.name,
        "description":    row.description,
        "embedding_model": row.embedding_model,
        "chunk_size":     row.chunk_size,
        "chunk_overlap":  row.chunk_overlap,
        "document_count": row.document_count,
        "chunk_count":    row.chunk_count,
        "created_at":     row.created_at.isoformat() + "Z" if row.created_at else None,
        "updated_at":     row.updated_at.isoformat() + "Z" if row.updated_at else None,
    }


def _serialize_document(row: GeminiKbDocument) -> dict:
    return {
        "id":           row.id,
        "collection_id": row.collection_id,
        "source":       row.source,
        "filename":     row.filename,
        "mime_type":    row.mime_type,
        "char_count":   row.char_count,
        "chunk_count":  row.chunk_count,
        "status":       row.status,
        "error":        row.error,
        "created_at":   row.created_at.isoformat() + "Z" if row.created_at else None,
        "indexed_at":   row.indexed_at.isoformat() + "Z" if row.indexed_at else None,
    }


# ── Collections ─────────────────────────────────────────────────────────────

@router.get("/collections")
async def list_collections(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(GeminiKbCollection).order_by(GeminiKbCollection.created_at.asc())
    )).scalars().all()
    return {"items": [_serialize_collection(r) for r in rows]}


@router.post("/collections")
async def create_collection(body: CollectionCreate, db: AsyncSession = Depends(get_db)):
    base = _slugify(body.name)
    slug = base
    i = 1
    while (await db.execute(select(GeminiKbCollection.id).where(GeminiKbCollection.slug == slug))).scalar_one_or_none():
        i += 1
        slug = f"{base}_{i}"
    row = GeminiKbCollection(
        slug=slug,
        name=body.name,
        description=body.description,
        chunk_size=body.chunk_size,
        chunk_overlap=body.chunk_overlap,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _serialize_collection(row)


@router.get("/collections/{collection_id}")
async def get_collection(collection_id: int, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(
        select(GeminiKbCollection).where(GeminiKbCollection.id == collection_id)
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Collection not found")
    return _serialize_collection(row)


@router.patch("/collections/{collection_id}")
async def update_collection(collection_id: int, body: CollectionUpdate,
                            db: AsyncSession = Depends(get_db)):
    row = (await db.execute(
        select(GeminiKbCollection).where(GeminiKbCollection.id == collection_id)
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Collection not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    return _serialize_collection(row)


@router.delete("/collections/{collection_id}")
async def delete_collection(collection_id: int, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(
        select(GeminiKbCollection).where(GeminiKbCollection.id == collection_id)
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Collection not found")
    await db.delete(row)
    await db.commit()
    return {"status": "deleted", "id": collection_id}


# ── Documents ───────────────────────────────────────────────────────────────

@router.get("/collections/{collection_id}/documents")
async def list_documents(collection_id: int, db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(GeminiKbDocument)
        .where(GeminiKbDocument.collection_id == collection_id)
        .order_by(GeminiKbDocument.created_at.desc())
    )).scalars().all()
    return {"items": [_serialize_document(r) for r in rows]}


@router.post("/collections/{collection_id}/documents")
async def upload_document(
    collection_id: int,
    background: BackgroundTasks,
    file: UploadFile | None = File(default=None),
    title: str | None = Form(default=None),
    content: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Add a document to a KB collection. Accepts either:

      • multipart with `file` field (PDF / TXT / MD)
      • multipart with `title` + `content` form fields (pasted text)
    """
    col = (await db.execute(
        select(GeminiKbCollection).where(GeminiKbCollection.id == collection_id)
    )).scalar_one_or_none()
    if not col:
        raise HTTPException(404, "Collection not found")

    if file is not None:
        raw = await file.read()
        if not raw:
            raise HTTPException(400, "Uploaded file is empty")
        sha = hashlib.sha256(raw).hexdigest()
        doc = GeminiKbDocument(
            collection_id=collection_id,
            source="upload",
            filename=file.filename or "file",
            mime_type=file.content_type or "",
            sha256=sha,
            raw_bytes=raw,
            status="pending",
        )
    elif content and title:
        body = content.strip()
        if not body:
            raise HTTPException(400, "Empty text content")
        sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
        doc = GeminiKbDocument(
            collection_id=collection_id,
            source="text",
            filename=title.strip(),
            mime_type="text/plain",
            sha256=sha,
            raw_text=body,
            status="pending",
        )
    else:
        raise HTTPException(400, "Provide either a file OR (title + content)")

    db.add(doc)
    await db.commit()
    await db.refresh(doc)

    # Kick off background ingestion.
    background.add_task(ingest_document, doc.id)
    return _serialize_document(doc)


@router.delete("/collections/{collection_id}/documents/{doc_id}")
async def delete_document(collection_id: int, doc_id: int,
                           db: AsyncSession = Depends(get_db)):
    row = (await db.execute(
        select(GeminiKbDocument).where(
            GeminiKbDocument.id == doc_id,
            GeminiKbDocument.collection_id == collection_id,
        )
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Document not found")
    await db.delete(row)
    await db.commit()
    await _recompute_collection_counts(collection_id)
    return {"status": "deleted", "id": doc_id}


@router.post("/collections/{collection_id}/documents/{doc_id}/reindex")
async def reindex_document(collection_id: int, doc_id: int,
                            background: BackgroundTasks,
                            db: AsyncSession = Depends(get_db)):
    row = (await db.execute(
        select(GeminiKbDocument).where(
            GeminiKbDocument.id == doc_id,
            GeminiKbDocument.collection_id == collection_id,
        )
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Document not found")
    # Wipe existing chunks before re-ingesting.
    await db.execute(delete(GeminiKbChunk).where(GeminiKbChunk.document_id == doc_id))
    await db.execute(
        update(GeminiKbDocument).where(GeminiKbDocument.id == doc_id)
        .values(status="pending", error=None, chunk_count=0, indexed_at=None)
    )
    await db.commit()
    background.add_task(ingest_document, doc_id)
    return {"status": "queued", "id": doc_id}


# ── Search (UI debug) ───────────────────────────────────────────────────────

@router.post("/collections/{collection_id}/search")
async def search_collection(collection_id: int, body: SearchRequest):
    hits = await kb_search(collection_ids=[collection_id], query=body.query, top_k=body.top_k)
    return {"items": hits}
