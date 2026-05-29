"""
Extract plain text from uploaded knowledge-base documents.

Supported:
  - PDF   via PyMuPDF (per-page text preserved for page-number citations)
  - TXT   raw decode
  - MD    raw decode (markdown is left intact; the LLM handles it fine)

PDFs with no extractable text (scanned image-only PDFs) return an empty list
and the caller can mark the document `failed`. OCR is out of scope for v1.
"""

from __future__ import annotations

import logging

log = logging.getLogger("kb.extract")


def extract_pdf(raw: bytes) -> list[tuple[int, str]]:
    """Return [(page_number, text), ...] for a PDF byte stream."""
    import fitz  # PyMuPDF
    pages: list[tuple[int, str]] = []
    with fitz.open(stream=raw, filetype="pdf") as doc:
        for i, page in enumerate(doc, start=1):
            text = page.get_text("text") or ""
            text = text.strip()
            if text:
                pages.append((i, text))
    return pages


def extract_text_file(raw: bytes) -> list[tuple[int, str]]:
    """Plain text / markdown: single 'page'."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1", errors="replace")
    text = text.strip()
    return [(1, text)] if text else []


def extract(raw: bytes, *, mime_type: str | None = None,
            filename: str | None = None) -> list[tuple[int, str]]:
    """Dispatch to the right extractor based on mime/filename."""
    mt = (mime_type or "").lower()
    name = (filename or "").lower()

    if mt == "application/pdf" or name.endswith(".pdf"):
        return extract_pdf(raw)
    if mt.startswith("text/") or name.endswith((".txt", ".md", ".markdown")):
        return extract_text_file(raw)

    # Default: try text decode; if it looks binary, fail.
    try:
        return extract_text_file(raw)
    except Exception:
        raise ValueError(f"Unsupported document type: mime={mime_type!r} name={filename!r}")


def total_chars(pages: list[tuple[int, str]]) -> int:
    return sum(len(p[1]) for p in pages)
