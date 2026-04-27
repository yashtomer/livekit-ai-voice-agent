import json
import secrets
from datetime import timedelta
from livekit import api as lk_api
from ..config import LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_PUBLIC_URL


def build_token(
    user_id: int,
    stt: dict,
    llm: dict,
    tts: dict,
    call_limit_s: int = 60,
) -> tuple[str, str, str]:
    identity = f"user-{user_id}"
    room_name = f"voice-{secrets.token_hex(4)}"

    # Strip api_key before embedding in metadata (agent reads it from config,
    # but we don't want raw keys stored long-term in room metadata)
    def strip_api_key(cfg: dict) -> dict:
        return {k: v for k, v in cfg.items() if k != "api_key"}

    metadata_json = json.dumps({
        "stt": stt,
        "llm": llm,
        "tts": tts,
    })

    token = (
        lk_api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(identity)
        .with_metadata(metadata_json)
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
