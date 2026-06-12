"""
Outbound WhatsApp notifications via the Meta Cloud API.

Used to notify a customer when their phone call (Tata in/outbound) dropped due
to a network/model/internal error, so we can promise a callback.

We send a *template* message (not free-form text): free-form text only delivers
inside Meta's 24-hour customer-service window, so a cold outbound number would be
rejected. A pre-approved template delivers to any number.

Config (env):
  WHATSAPP_PHONE_NUMBER_ID    — sender's WhatsApp phone-number id (Graph API path)
  WHATSAPP_ACCESS_TOKEN       — permanent/system-user access token
  WHATSAPP_DISCONNECT_TEMPLATE — approved template name (default: hello_world)
  WHATSAPP_TEMPLATE_LANG       — template language code (default: en_US)

Failures are logged and swallowed — a notification must never break call teardown.
"""
from __future__ import annotations

import logging
import os

import httpx

log = logging.getLogger("gemini_whatsapp")

GRAPH_VERSION = os.environ.get("WHATSAPP_GRAPH_VERSION", "v18.0")


def _digits(number: str) -> str:
    """Normalise to digits only (Meta wants E.164 without '+'). Best-effort."""
    return "".join(ch for ch in (number or "") if ch.isdigit())


def _to_e164(number: str | None) -> str:
    """Best-effort E.164 (digits only, no '+') for the WhatsApp Cloud API.

    Telephony providers (e.g. Tata) often report numbers in national format —
    `09522272781` (trunk 0) or a bare 10-digit `9522272781`. Meta needs the full
    country-coded form `919522272781`, so we strip a leading international-access
    `00`/trunk `0` and prepend WHATSAPP_DEFAULT_COUNTRY_CODE to local numbers.

    Numbers that already carry a country code (anything longer than the local
    length) are passed through untouched, so non-Indian numbers still work.
    """
    d = _digits(number)
    if not d:
        return ""
    cc = (os.environ.get("WHATSAPP_DEFAULT_COUNTRY_CODE", "91").strip() or "91")
    if d.startswith("00"):          # 00<cc><number> international-access prefix
        d = d[2:]
    elif d.startswith("0"):         # national trunk prefix, e.g. 0XXXXXXXXXX
        d = d.lstrip("0")
    if len(d) == 10:                # bare national subscriber number → add cc
        d = cc + d
    return d


async def send_whatsapp_template(
    to: str | None,
    *,
    template: str | None = None,
    lang: str | None = None,
) -> bool:
    """Send an approved WhatsApp template to `to`. Returns True on success.

    Never raises — returns False (and logs) on any misconfiguration or API error.
    """
    phone_number_id = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "").strip()
    token = os.environ.get("WHATSAPP_ACCESS_TOKEN", "").strip()
    template = (template or os.environ.get("WHATSAPP_DISCONNECT_TEMPLATE", "hello_world")).strip()
    lang = (lang or os.environ.get("WHATSAPP_TEMPLATE_LANG", "en_US")).strip()

    to_digits = _to_e164(to)
    if not (phone_number_id and token and to_digits):
        log.info(
            "WhatsApp notify skipped (phone_id=%s token=%s to=%s)",
            bool(phone_number_id), bool(token), to_digits or None,
        )
        return False

    url = f"https://graph.facebook.com/{GRAPH_VERSION}/{phone_number_id}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": to_digits,
        "type": "template",
        "template": {"name": template, "language": {"code": lang}},
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code < 300:
                log.info("WhatsApp template '%s' sent to %s", template, to_digits)
                return True
            log.warning(
                "WhatsApp template send failed (%s) to %s: %s",
                r.status_code, to_digits, r.text[:300],
            )
            return False
    except Exception as exc:
        log.warning("WhatsApp template send error to %s: %s", to_digits, exc)
        return False
