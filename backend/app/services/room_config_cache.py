"""In-memory, single-use cache for per-room agent config (including the
user's API keys). Lives only as long as the call setup needs it: the
backend `put`s the bundle when minting a LiveKit token, the agent
`pop`s it once when joining the room. A background sweeper evicts
unclaimed entries so a user clicking Start Call but never connecting
doesn't leak credentials in memory indefinitely.

Single-process by design — if backend ever scales horizontally, swap
this for a Redis-backed implementation with the same put/pop contract.
"""
import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger("room-config-cache")

_store: dict[str, tuple[dict[str, Any], float]] = {}
_lock = asyncio.Lock()


async def put(room_name: str, config: dict[str, Any], ttl_seconds: int) -> None:
    expires_at = time.monotonic() + ttl_seconds
    async with _lock:
        _store[room_name] = (config, expires_at)


async def pop(room_name: str) -> dict[str, Any] | None:
    """Atomically fetch and evict the entry. Returns None if missing or expired."""
    async with _lock:
        entry = _store.pop(room_name, None)
    if entry is None:
        return None
    config, expires_at = entry
    if time.monotonic() > expires_at:
        return None
    return config


async def sweep_expired() -> int:
    now = time.monotonic()
    async with _lock:
        expired = [k for k, (_, exp) in _store.items() if now > exp]
        for k in expired:
            _store.pop(k, None)
    if expired:
        logger.info(f"swept {len(expired)} expired room-config entries")
    return len(expired)


async def run_sweeper(interval_seconds: int = 60) -> None:
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            await sweep_expired()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning(f"sweeper iteration failed: {e}")
