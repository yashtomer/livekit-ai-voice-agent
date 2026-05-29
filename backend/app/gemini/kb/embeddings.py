"""Embedding wrapper for Google gemini-embedding-001 via google-genai SDK."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Sequence

log = logging.getLogger("kb.embeddings")

# gemini-embedding-001 is the current GA embedding model. It defaults to 3072
# dims but supports Matryoshka truncation via output_dimensionality — we request
# 768 to match the pgvector column (VECTOR(768)).
EMBED_MODEL = os.environ.get("KB_EMBED_MODEL", "gemini-embedding-001")
EMBED_DIM = 768
BATCH_SIZE = 100


def _server_key() -> str:
    return os.environ.get("GOOGLE_API_KEY", "").strip()


async def embed_texts(texts: Sequence[str], api_key: str | None = None) -> list[list[float]]:
    """Embed a batch of strings; returns one 768-dim vector per input.

    Uses the server's GOOGLE_API_KEY by default. Pass ``api_key`` to use a
    user-specific key (e.g. for billing isolation).

    Raises RuntimeError if no key is configured.
    """
    if not texts:
        return []
    key = (api_key or _server_key())
    if not key:
        raise RuntimeError("No GOOGLE_API_KEY configured for embedding")

    from google import genai
    from google.genai import types
    client = genai.Client(api_key=key)
    cfg = types.EmbedContentConfig(output_dimensionality=EMBED_DIM)

    out: list[list[float]] = []
    for i in range(0, len(texts), BATCH_SIZE):
        batch = list(texts[i:i + BATCH_SIZE])
        # google-genai SDK is sync; run in a thread so we don't block the event loop.
        resp = await asyncio.to_thread(
            client.models.embed_content,
            model=EMBED_MODEL,
            contents=batch,
            config=cfg,
        )
        # `resp.embeddings` is a list of Embedding objects with `.values`.
        for e in (resp.embeddings or []):
            vals = list(e.values or [])
            # gemini-embedding-001 returns UN-normalized vectors for non-default
            # dims; L2-normalize so cosine distance behaves correctly.
            norm = sum(v * v for v in vals) ** 0.5
            if norm > 0:
                vals = [v / norm for v in vals]
            out.append(vals)
    if len(out) != len(texts):
        log.warning("Embedding count mismatch: got %d, expected %d", len(out), len(texts))
    return out


async def embed_one(text: str, api_key: str | None = None) -> list[float]:
    """Embed a single string. Returns a 768-dim vector, or [] on failure."""
    res = await embed_texts([text], api_key=api_key)
    return res[0] if res else []
