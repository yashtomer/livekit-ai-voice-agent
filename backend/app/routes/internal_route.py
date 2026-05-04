"""Internal server-to-server endpoints. NOT exposed to the browser via
the frontend; protected by a shared secret in the X-Internal-Secret
header. The agent worker uses this to fetch per-room API keys without
them ever touching the LiveKit JWT."""
import hmac
import logging
from fastapi import APIRouter, Header, HTTPException

from ..config import INTERNAL_AGENT_SECRET
from ..services import room_config_cache

router = APIRouter()
logger = logging.getLogger("internal-route")


def _check_secret(provided: str | None) -> None:
    if not provided or not hmac.compare_digest(provided, INTERNAL_AGENT_SECRET):
        raise HTTPException(status_code=401, detail="Invalid internal secret")


@router.get("/room-config/{room_name}")
async def get_room_config(
    room_name: str,
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
):
    """Fetch and atomically evict the config bundle for `room_name`.
    Single-use: a second call for the same room returns 404."""
    _check_secret(x_internal_secret)
    config = await room_config_cache.pop(room_name)
    if config is None:
        # Either never inserted, already consumed, or TTL expired. The
        # agent treats this as a non-fatal warning and continues with
        # whatever public config is in the LiveKit metadata (free
        # providers will still work).
        raise HTTPException(status_code=404, detail="Room config not found or already consumed")
    return config
