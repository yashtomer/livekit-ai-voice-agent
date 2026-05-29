"""
Vector similarity search across one or more KB collections.

Returns the top-k closest chunks (by cosine distance) along with their
document/page metadata so the caller can cite sources.
"""

from __future__ import annotations

import logging
from typing import Iterable

from sqlalchemy import bindparam, text

from ...db import SessionLocal
from .embeddings import embed_one

log = logging.getLogger("kb.search")


def _vec_literal(vec: list[float]) -> str:
    """Format a vector as pgvector's textual `[v1,v2,...]` literal."""
    return "[" + ",".join(f"{v:.6f}" for v in vec) + "]"


async def search(
    *,
    collection_ids: Iterable[int],
    query: str,
    top_k: int = 5,
    api_key: str | None = None,
) -> list[dict]:
    """Embed ``query`` then return the top-k matching chunks across the given collections."""
    ids = [int(i) for i in collection_ids if i]
    if not ids or not query or not query.strip():
        return []

    vec = await embed_one(query.strip(), api_key=api_key)
    if not vec:
        return []

    sql = text("""
        SELECT
            c.id           AS chunk_id,
            c.document_id  AS document_id,
            c.collection_id AS collection_id,
            c.chunk_index  AS chunk_index,
            c.page_number  AS page_number,
            c.content      AS content,
            d.filename     AS filename,
            d.source       AS source,
            1 - (c.embedding <=> CAST(:qvec AS vector)) AS score
        FROM gemini_kb_chunks c
        JOIN gemini_kb_documents d ON d.id = c.document_id
        WHERE c.collection_id = ANY(:cids)
          AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> CAST(:qvec AS vector)
        LIMIT :k
    """).bindparams(
        bindparam("qvec"),
        bindparam("cids"),
        bindparam("k"),
    )

    async with SessionLocal() as db:
        result = await db.execute(sql, {
            "qvec": _vec_literal(vec),
            "cids": ids,
            "k":    int(top_k),
        })
        hits = [dict(r) for r in result.mappings().all()]
    log.info("KB search q=%r collections=%s -> %d hits", query[:60], ids, len(hits))
    return hits
