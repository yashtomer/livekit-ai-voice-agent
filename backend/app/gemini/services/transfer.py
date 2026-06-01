"""
Warm-transfer ("hand off to a human") helpers for the phone bridges.

The agent can call the `transfer_call` tool when a caller asks for a human or
gets frustrated. The bridge intercepts that call and uses the telephony
provider's REST API to redirect the live call to a configured human-agent
number.

Target number resolution order:
  1. explicit `override` (e.g. per-call config)
  2. HUMAN_AGENT_NUMBER env var

Both providers do a blind redirect of the in-progress call to a <Dial> to the
human number. The agent typically says "connecting you now" first, so from the
caller's point of view it is a warm hand-off.
"""
from __future__ import annotations

import logging
import os

log = logging.getLogger("transfer")

HUMAN_AGENT_NUMBER = os.environ.get("HUMAN_AGENT_NUMBER", "").strip()


def resolve_transfer_number(override: str | None = None) -> str | None:
    num = (override or "").strip() or HUMAN_AGENT_NUMBER
    return num or None


def _dial_twiml(to_number: str, message: str = "Please hold while I connect you to a human agent.") -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<Response><Say>{message}</Say><Dial>{to_number}</Dial></Response>"
    )


async def twilio_transfer(call_sid: str | None, to_number: str | None, reason: str = "") -> dict:
    """Redirect a live Twilio call to a human agent via the REST API."""
    import asyncio

    account_sid = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
    api_key = os.environ.get("TWILIO_API_KEY", "").strip()
    api_secret = os.environ.get("TWILIO_API_SECRET", "").strip()
    auth_token = os.environ.get("TWILIO_AUTH_TOKEN", "").strip()

    if not call_sid:
        return {"status": "error", "message": "No active call to transfer."}
    if not to_number:
        return {"status": "error", "message": "No human-agent number is configured (set HUMAN_AGENT_NUMBER)."}
    if not account_sid or not (api_key and api_secret or auth_token):
        return {"status": "error", "message": "Twilio credentials are not configured for transfer."}

    def _do() -> None:
        from twilio.rest import Client
        # Prefer API key/secret auth; fall back to account SID + auth token.
        if api_key and api_secret:
            client = Client(api_key, api_secret, account_sid)
        else:
            client = Client(account_sid, auth_token)
        client.calls(call_sid).update(twiml=_dial_twiml(to_number))

    try:
        await asyncio.to_thread(_do)
        log.info("Twilio transfer: call %s → %s (%s)", call_sid, to_number, reason)
        return {"status": "ok", "message": f"Transferring the caller to a human agent at {to_number}.", "transferred_to": to_number}
    except Exception as e:
        log.exception("Twilio transfer failed")
        return {"status": "error", "message": f"Transfer failed: {e}"}


async def vobiz_transfer(call_uuid: str | None, to_number: str | None, host: str, reason: str = "") -> dict:
    """Redirect a live Vobiz (Plivo-compatible) call to a human agent.

    Uses the Plivo-style call-transfer API: POST the in-progress call's a-leg
    to an answer URL that returns a <Dial> to the human number.
    """
    import aiohttp

    auth_id = os.environ.get("VOBIZ_AUTH_ID", "").strip()
    auth_token = os.environ.get("VOBIZ_AUTH_TOKEN", "").strip()

    if not call_uuid:
        return {"status": "error", "message": "No active call to transfer."}
    if not to_number:
        return {"status": "error", "message": "No human-agent number is configured (set HUMAN_AGENT_NUMBER)."}
    if not auth_id or not auth_token:
        return {"status": "error", "message": "Vobiz credentials are not configured for transfer."}

    from urllib.parse import quote
    # Redirect the live call to new XML (a <Dial> to the human) — mirrors the
    # outbound-call API: auth via X-Auth headers, `answer_url` is the new XML URL.
    answer_url = f"https://{host}/api/vobiz/transfer?to={quote(to_number)}"
    url = f"https://api.vobiz.ai/api/v1/Account/{auth_id}/Call/{call_uuid}/"
    # Vobiz (Plivo-style) transfer: redirect the a-leg (the caller) to new XML.
    payload = {
        "legs": "aleg",
        "aleg_url": answer_url,
        "aleg_method": "POST",
    }
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as s:
            async with s.post(url, json=payload, headers={
                "X-Auth-ID": auth_id,
                "X-Auth-Token": auth_token,
            }) as resp:
                body = await resp.text()
                log.info("Vobiz transfer → %s %s", resp.status, body[:300])
                if resp.status >= 400:
                    return {"status": "error", "message": f"Transfer failed ({resp.status}): {body[:200]}"}
        log.info("Vobiz transfer: call %s → %s (%s)", call_uuid, to_number, reason)
        return {"status": "ok", "message": f"Transferring the caller to a human agent at {to_number}.", "transferred_to": to_number}
    except Exception as e:
        log.exception("Vobiz transfer failed")
        return {"status": "error", "message": f"Transfer failed: {e}"}
