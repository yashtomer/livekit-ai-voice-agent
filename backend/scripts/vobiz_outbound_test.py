"""
Trigger an outbound Vobiz call that routes audio through the Gemini bridge.

Usage (from inside backend container):
    docker compose -f docker-compose-dev.yml exec backend \\
        uv run python scripts/vobiz_outbound_test.py +91XXXXXXXXXX

Flow:
    1. POST to https://api.vobiz.ai/api/v1/Account/<auth_id>/Call/
    2. Vobiz dials `to` from `from` (your trial number).
    3. When the recipient answers, Vobiz hits answer_url
       (https://<PUBLIC_HOST>/api/vobiz/voice).
    4. That webhook returns XML telling Vobiz to open a WebSocket to
       /api/vobiz/stream → our existing Gemini bridge picks it up.

Env vars (from .env):
    VOBIZ_AUTH_ID         from console.vobiz.ai → API → Auth
    VOBIZ_AUTH_TOKEN      same
    VOBIZ_PHONE_NUMBER    your trial number (the `from` for outbound)
    PUBLIC_HOST           https-reachable hostname of your backend
                          e.g. aivoice.aeologic.in or *.ngrok-free.app
"""

import os
import sys
import json
import asyncio

import aiohttp


VOBIZ_AUTH_ID    = os.environ.get("VOBIZ_AUTH_ID", "").strip()
VOBIZ_AUTH_TOKEN = os.environ.get("VOBIZ_AUTH_TOKEN", "").strip()
FROM_NUMBER      = os.environ.get("VOBIZ_PHONE_NUMBER", "").strip()
PUBLIC_HOST      = os.environ.get("PUBLIC_HOST", "").strip()


async def main(to_number: str):
    for name, val in [
        ("VOBIZ_AUTH_ID", VOBIZ_AUTH_ID),
        ("VOBIZ_AUTH_TOKEN", VOBIZ_AUTH_TOKEN),
        ("VOBIZ_PHONE_NUMBER", FROM_NUMBER),
        ("PUBLIC_HOST", PUBLIC_HOST),
    ]:
        if not val:
            print(f"ERROR: {name} not set in .env", file=sys.stderr)
            sys.exit(1)

    url = f"https://api.vobiz.ai/api/v1/Account/{VOBIZ_AUTH_ID}/Call/"
    answer_url = f"https://{PUBLIC_HOST}/api/vobiz/voice"
    hangup_url = f"https://{PUBLIC_HOST}/api/vobiz/status"

    payload = {
        "from": FROM_NUMBER.lstrip("+"),  # Vobiz expects digits, no +
        "to":   to_number.lstrip("+"),
        "answer_url":    answer_url,
        "answer_method": "POST",
        "hangup_url":    hangup_url,
        "hangup_method": "POST",
        "caller_name":   "Gemini Healthcare Agent",
        "time_limit":    600,  # 10 min cap
    }

    print(f"Calling Vobiz API: {url}")
    print(f"Payload: {json.dumps(payload, indent=2)}")
    print(f"Answer URL  → {answer_url}")
    print()

    async with aiohttp.ClientSession() as session:
        async with session.post(
            url,
            json=payload,
            headers={
                "X-Auth-ID":    VOBIZ_AUTH_ID,
                "X-Auth-Token": VOBIZ_AUTH_TOKEN,
                "Content-Type": "application/json",
            },
        ) as resp:
            body = await resp.text()
            print(f"Status: {resp.status}")
            print(f"Response: {body}")

            if resp.status >= 400:
                sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: vobiz_outbound_test.py +91XXXXXXXXXX", file=sys.stderr)
        sys.exit(1)
    asyncio.run(main(sys.argv[1]))
