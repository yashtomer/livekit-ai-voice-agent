"""
Per-call cost estimation: Gemini Live token usage + telephony minutes.

Rates below reflect the project's current providers but are fully overridable
via environment variables — update them if your contract changes.

Gemini 3.1 Flash Live Preview (audio-to-audio), paid tier, per 1M tokens:
    input  audio  $3.00   |  output audio  $12.00
(text-only tokens are cheaper — $0.75 in / $4.50 out — but a voice call is
audio-dominated, so we price all tokens at the audio rate as a close estimate.)

Telephony is billed in INR by the carriers:
    TATA  — ₹1100 / number / month, UNLIMITED calls → per-call marginal cost ₹0
            (the monthly rent is a fixed cost, not attributable per call).
    Vobiz — ₹500 / month rent (fixed) + ₹0.45 / minute per call.
Browser calls have no carrier leg.

Costs are reported in BOTH USD and INR. The USD→INR rate is the live one from
/api/fx-rate (passed into estimate_cost); DEFAULT_USD_INR_RATE is only a fallback.
"""
from __future__ import annotations

import os


def _f(env: str, default: float) -> float:
    try:
        return float(os.environ.get(env, default))
    except (TypeError, ValueError):
        return float(default)


# Gemini Live token rates (USD per 1,000,000 tokens) — audio rates.
GEMINI_INPUT_USD_PER_1M = _f("GEMINI_INPUT_USD_PER_1M", 3.00)
GEMINI_OUTPUT_USD_PER_1M = _f("GEMINI_OUTPUT_USD_PER_1M", 12.00)

# Fallback USD → INR rate. The live rate normally comes from /api/fx-rate
# (frankfurter.dev / ECB) and is passed into estimate_cost(); this constant is
# only used when no live rate is supplied.
DEFAULT_USD_INR_RATE = _f("USD_INR_RATE", 86.0)

# Per-call telephony cost (INR per minute) by call_type. TATA is unlimited on a
# flat monthly rent, so its marginal per-minute cost is 0.
TELEPHONY_INR_PER_MIN = {
    "browser": _f("TELEPHONY_INR_PER_MIN_BROWSER", 0.0),
    "tata":    _f("TELEPHONY_INR_PER_MIN_TATA",    0.0),
    "vobiz":   _f("TELEPHONY_INR_PER_MIN_VOBIZ",   0.45),
    "twilio":  _f("TELEPHONY_INR_PER_MIN_TWILIO",  1.20),
}

# Fixed monthly rentals (INR) — informational; not charged per call.
MONTHLY_RENT_INR = {
    "tata":  _f("MONTHLY_RENT_INR_TATA",  1100.0),
    "vobiz": _f("MONTHLY_RENT_INR_VOBIZ", 500.0),
}


def estimate_cost(*, call_type: str | None, input_tokens: int | None,
                  output_tokens: int | None, duration_s: int | None,
                  usd_inr_rate: float | None = None) -> dict:
    """Return a cost breakdown dict for one call, in USD and INR.

    Pass ``usd_inr_rate`` (the live /api/fx-rate value); falls back to
    DEFAULT_USD_INR_RATE when not supplied.
    """
    input_tokens = int(input_tokens or 0)
    output_tokens = int(output_tokens or 0)
    rate = usd_inr_rate or DEFAULT_USD_INR_RATE

    gemini_usd = (
        input_tokens * GEMINI_INPUT_USD_PER_1M
        + output_tokens * GEMINI_OUTPUT_USD_PER_1M
    ) / 1_000_000

    minutes = (duration_s or 0) / 60.0
    telephony_inr = minutes * TELEPHONY_INR_PER_MIN.get(call_type or "", 0.0)

    gemini_inr = gemini_usd * rate
    telephony_usd = telephony_inr / rate if rate else 0.0

    cost_usd = gemini_usd + telephony_usd
    cost_inr = gemini_inr + telephony_inr

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "telephony_min": round(minutes, 2),
        "usd_inr_rate": round(rate, 4),
        # USD
        "gemini_usd": round(gemini_usd, 6),
        "telephony_usd": round(telephony_usd, 6),
        "cost_usd": round(cost_usd, 6),
        # INR
        "gemini_inr": round(gemini_inr, 4),
        "telephony_inr": round(telephony_inr, 4),
        "cost_inr": round(cost_inr, 4),
    }


class UsageTracker:
    """Accumulates Gemini Live token usage across a call, surviving reconnects.

    The Live API reports ``usage_metadata`` cumulatively *within a session*; on a
    reconnect the counters reset to zero. We detect a reset (a counter that goes
    *down*) and roll the finished session's totals into a committed sum, so the
    final figure spans every session the call went through.
    """

    __slots__ = ("_cin", "_cout", "_sin", "_sout")

    def __init__(self):
        self._cin = self._cout = 0   # committed totals from prior sessions
        self._sin = self._sout = 0   # current session's latest cumulative counts

    def update(self, usage_metadata) -> None:
        if usage_metadata is None:
            return
        pin = int(getattr(usage_metadata, "prompt_token_count", 0) or 0)
        pout = int(
            getattr(usage_metadata, "response_token_count", None)
            or getattr(usage_metadata, "candidates_token_count", None)
            or 0
        )
        if pin < self._sin or pout < self._sout:   # counters dropped → session reset
            self._cin += self._sin
            self._cout += self._sout
            self._sin = self._sout = 0
        self._sin = max(self._sin, pin)
        self._sout = max(self._sout, pout)

    @property
    def input_tokens(self) -> int:
        return self._cin + self._sin

    @property
    def output_tokens(self) -> int:
        return self._cout + self._sout
