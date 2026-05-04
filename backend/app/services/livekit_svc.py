import json
import secrets
from datetime import timedelta
from livekit import api as lk_api
from ..config import (
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
    LIVEKIT_PUBLIC_URL,
    ROOM_CONFIG_TTL_SECONDS,
)
from . import room_config_cache


def _strip_secret(cfg: dict) -> dict:
    """Drop fields that must not leave the server (api_key, etc.)."""
    SECRET_FIELDS = {"api_key", "azure_region"}
    return {k: v for k, v in cfg.items() if k not in SECRET_FIELDS}


async def build_token(
    user_id: int,
    stt: dict,
    llm: dict,
    tts: dict,
    call_limit_s: int = 60,
) -> tuple[str, str, str, str]:
    identity = f"user-{user_id}"
    room_name = f"voice-{secrets.token_hex(4)}"

    # Stash the FULL config (including api_keys) in a server-side, single-use
    # cache keyed by room_name. The agent worker pulls this over an
    # authenticated server-to-server channel when it joins the room — so
    # secrets never land in the LiveKit JWT or the browser.
    full_config = {"stt": stt, "llm": llm, "tts": tts}
    await room_config_cache.put(room_name, full_config, ROOM_CONFIG_TTL_SECONDS)

    # Public metadata embedded in the JWT — safe for the browser to see.
    # Provider/model/voice are non-secret and the agent uses them as a
    # fallback if the internal fetch fails (free providers still work).
    public_metadata = json.dumps({
        "stt": _strip_secret(stt),
        "llm": _strip_secret(llm),
        "tts": _strip_secret(tts),
    })

    token = (
        lk_api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(identity)
        .with_metadata(public_metadata)
        .with_ttl(timedelta(seconds=call_limit_s + 30))
        .with_grants(lk_api.VideoGrants(
            room_join=True,
            room=room_name,
            can_publish=True,
            can_subscribe=True,
            can_publish_data=True,
        ))
        .to_jwt()
    )
    # Browser uses LIVEKIT_PUBLIC_URL for WebRTC; backend talks to the internal
    # ws://livekit-server:7880 separately for any worker-side calls.
    return token, LIVEKIT_PUBLIC_URL, room_name, identity
