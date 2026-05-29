"""
Ingest a knowledge-base document:

  extract → chunk → embed → insert chunks

Runs in the background (FastAPI BackgroundTasks). Updates the document row's
``status`` so the UI can poll for progress.
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy import select, update

from ...db import SessionLocal
from ..models.kb import GeminiKbCollection, GeminiKbDocument, GeminiKbChunk
from .chunking import Chunk, chunk_pages
from .embeddings import embed_texts
from .extract import extract, total_chars

log = logging.getLogger("kb.pipeline")


async def _set_status(doc_id: int, *, status: str, error: str | None = None,
                      char_count: int | None = None, chunk_count: int | None = None,
                      indexed_at: datetime | None = None) -> None:
    async with SessionLocal() as db:
        values: dict = {"status": status}
        if error is not None:
            values["error"] = error
        if char_count is not None:
            values["char_count"] = char_count
        if chunk_count is not None:
            values["chunk_count"] = chunk_count
        if indexed_at is not None:
            values["indexed_at"] = indexed_at
        await db.execute(
            update(GeminiKbDocument).where(GeminiKbDocument.id == doc_id).values(**values)
        )
        await db.commit()


async def _recompute_collection_counts(collection_id: int) -> None:
    """Refresh denormalized counters on the parent collection."""
    async with SessionLocal() as db:
        docs = (await db.execute(
            select(GeminiKbDocument).where(GeminiKbDocument.collection_id == collection_id)
        )).scalars().all()
        doc_count = len(docs)
        chunk_count = sum(d.chunk_count or 0 for d in docs)
        await db.execute(
            update(GeminiKbCollection)
            .where(GeminiKbCollection.id == collection_id)
            .values(document_count=doc_count, chunk_count=chunk_count)
        )
        await db.commit()


async def ingest_document(doc_id: int) -> None:
    """Background task: process a freshly-uploaded KB document."""
    log.info("Ingest start doc=%d", doc_id)
    try:
        await _set_status(doc_id, status="processing")

        async with SessionLocal() as db:
            doc = (await db.execute(
                select(GeminiKbDocument).where(GeminiKbDocument.id == doc_id)
            )).scalar_one_or_none()
            if not doc:
                log.warning("Ingest: doc %d not found", doc_id)
                return
            col = (await db.execute(
                select(GeminiKbCollection).where(GeminiKbCollection.id == doc.collection_id)
            )).scalar_one_or_none()
            if not col:
                await _set_status(doc_id, status="failed", error="Parent collection missing")
                return

            collection_id = doc.collection_id
            chunk_size = col.chunk_size or 600
            chunk_overlap = col.chunk_overlap or 80

            # 1. Extract — prefer raw bytes; fall back to pasted text.
            if doc.raw_bytes:
                pages = extract(doc.raw_bytes, mime_type=doc.mime_type, filename=doc.filename)
            elif doc.raw_text:
                pages = [(1, doc.raw_text)]
            else:
                await _set_status(doc_id, status="failed", error="Document has no content")
                return

        if not pages:
            await _set_status(doc_id, status="failed",
                              error="No text extracted (scanned PDF? OCR is not supported yet)")
            return

        char_count = total_chars(pages)

        # 2. Chunk
        chunks: list[Chunk] = chunk_pages(pages, chunk_size=chunk_size, overlap=chunk_overlap)
        if not chunks:
            await _set_status(doc_id, status="failed", error="Extraction produced no chunks")
            return

        # 3. Embed
        contents = [c.content for c in chunks]
        try:
            vectors = await embed_texts(contents)
        except Exception as e:
            log.exception("Embedding failed for doc %d", doc_id)
            await _set_status(doc_id, status="failed", error=f"Embedding error: {e}")
            return
        if len(vectors) != len(chunks):
            await _set_status(doc_id, status="failed",
                              error=f"Embedding returned {len(vectors)} vectors for {len(chunks)} chunks")
            return

        # 4. Insert chunk rows in one transaction
        async with SessionLocal() as db:
            rows = [
                GeminiKbChunk(
                    document_id=doc_id,
                    collection_id=collection_id,
                    chunk_index=c.index,
                    page_number=c.page_number,
                    content=c.content,
                    token_count=c.word_count,
                    embedding=vec,
                )
                for c, vec in zip(chunks, vectors)
            ]
            db.add_all(rows)
            await db.commit()

        await _set_status(doc_id, status="ready",
                          char_count=char_count,
                          chunk_count=len(chunks),
                          indexed_at=datetime.utcnow())
        await _recompute_collection_counts(collection_id)
        log.info("Ingest done doc=%d chunks=%d chars=%d", doc_id, len(chunks), char_count)

    except Exception as e:
        log.exception("Unhandled ingest error for doc %d", doc_id)
        try:
            await _set_status(doc_id, status="failed", error=str(e)[:2000])
        except Exception:
            pass
