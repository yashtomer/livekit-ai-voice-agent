"""
Simple word-based chunker.

Token-accurate chunking needs a real tokenizer (tiktoken / sentencepiece) which
adds heavy deps. For the voice-agent KB workload we use word counts as a
reasonable proxy — ~1.3 words per token for English, so ``chunk_size=600 words``
is roughly 800 tokens, well within Gemini's context for retrieval.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

_WHITESPACE_RE = re.compile(r"\s+")


@dataclass
class Chunk:
    index: int
    content: str
    word_count: int
    page_number: int | None = None   # set when extractor supplies pagination


def _split_words(text: str) -> list[str]:
    return [w for w in _WHITESPACE_RE.split(text.strip()) if w]


def chunk_text(text: str, *, chunk_size: int = 600, overlap: int = 80,
               page_number: int | None = None) -> list[Chunk]:
    """Chunk a single block of text into overlapping word-windows."""
    if not text or not text.strip():
        return []
    words = _split_words(text)
    if not words:
        return []
    if chunk_size <= 0:
        chunk_size = 600
    if overlap >= chunk_size:
        overlap = chunk_size // 5

    chunks: list[Chunk] = []
    step = max(1, chunk_size - overlap)
    idx = 0
    for start in range(0, len(words), step):
        window = words[start:start + chunk_size]
        if not window:
            break
        content = " ".join(window)
        chunks.append(Chunk(
            index=idx,
            content=content,
            word_count=len(window),
            page_number=page_number,
        ))
        idx += 1
        if start + chunk_size >= len(words):
            break
    return chunks


def chunk_pages(pages: Iterable[tuple[int, str]], *, chunk_size: int = 600,
                overlap: int = 80) -> list[Chunk]:
    """Chunk a stream of (page_number, page_text) pairs, preserving page metadata."""
    out: list[Chunk] = []
    running_idx = 0
    for page_no, txt in pages:
        for c in chunk_text(txt, chunk_size=chunk_size, overlap=overlap, page_number=page_no):
            out.append(Chunk(
                index=running_idx,
                content=c.content,
                word_count=c.word_count,
                page_number=page_no,
            ))
            running_idx += 1
    return out
