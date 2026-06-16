"""
Per-call cost estimation: Gemini Live token usage + telephony minutes.

Rates below reflect the project's current providers but are fully overridable
via environment variables — update them if your contract changes.

Gemini 3.1 Flash Live Preview, paid tier, per 1M tokens, SPLIT BY MODALITY:
    input  audio  $3.00   |  input  text  $0.75
    output audio  $12.00  |  output text  $4.50
We read the per-modality token breakdown from usage_metadata
(prompt_tokens_details / response_tokens_details) and price each modality at its
own rate. This is the true billing model: the audio part equals Google's
per-minute audio price, while the TEXT part captures the system prompt, the
knowledge-base/RAG context, tool definitions + results (all text input) and the
thinking/text replies (text output) — none of which the audio rate covers.

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


# Gemini Live rates (USD per 1,000,000 tokens), split by modality.
GEMINI_AUDIO_IN_USD_PER_1M = _f("GEMINI_AUDIO_IN_USD_PER_1M", 3.00)
GEMINI_TEXT_IN_USD_PER_1M = _f("GEMINI_TEXT_IN_USD_PER_1M", 0.75)
GEMINI_AUDIO_OUT_USD_PER_1M = _f("GEMINI_AUDIO_OUT_USD_PER_1M", 12.00)
GEMINI_TEXT_OUT_USD_PER_1M = _f("GEMINI_TEXT_OUT_USD_PER_1M", 4.50)

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


def estimate_cost(*, call_type: str | None, token_usage: dict | None,
                  input_seconds: float | None, output_seconds: float | None,
                  duration_s: int | None, usd_inr_rate: float | None = None) -> dict:
    """Return a cost breakdown dict for one call, in USD and INR.

    ``token_usage`` is the modality split from UsageTracker.totals():
    {audio_in, text_in, audio_out, text_out}. Gemini is priced per modality;
    audio_in/out seconds are carried for display only.
    """
    tu = token_usage or {}
    ai = int(tu.get("audio_in") or 0)
    ti = int(tu.get("text_in") or 0)
    ao = int(tu.get("audio_out") or 0)
    to = int(tu.get("text_out") or 0)
    rate = usd_inr_rate or DEFAULT_USD_INR_RATE

    gemini_usd = (
        ai * GEMINI_AUDIO_IN_USD_PER_1M
        + ti * GEMINI_TEXT_IN_USD_PER_1M
        + ao * GEMINI_AUDIO_OUT_USD_PER_1M
        + to * GEMINI_TEXT_OUT_USD_PER_1M
    ) / 1_000_000

    minutes = (duration_s or 0) / 60.0
    telephony_inr = minutes * TELEPHONY_INR_PER_MIN.get(call_type or "", 0.0)

    gemini_inr = gemini_usd * rate
    telephony_usd = telephony_inr / rate if rate else 0.0

    cost_usd = gemini_usd + telephony_usd
    cost_inr = gemini_inr + telephony_inr

    return {
        # token modality split (audio = spoken, text = prompt/KB/tools/thinking)
        "audio_in_tokens": ai,
        "text_in_tokens": ti,
        "audio_out_tokens": ao,
        "text_out_tokens": to,
        "input_tokens": ai + ti,
        "output_tokens": ao + to,
        "total_tokens": ai + ti + ao + to,
        "input_audio_min": round((input_seconds or 0) / 60.0, 3),
        "output_audio_min": round((output_seconds or 0) / 60.0, 3),
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


class AudioMeter:
    """Tallies audio streamed to/from Gemini (PCM16 mono), for display minutes.

    seconds = bytes / (sample_rate × 2). Input is the caller audio we send to
    Gemini; output is the agent audio Gemini returns.
    """

    __slots__ = ("_in_bytes", "_out_bytes", "_in_rate", "_out_rate")

    def __init__(self, input_rate: int = 16000, output_rate: int = 24000):
        self._in_bytes = 0
        self._out_bytes = 0
        self._in_rate = input_rate
        self._out_rate = output_rate

    def add_input(self, pcm16: bytes) -> None:
        if pcm16:
            self._in_bytes += len(pcm16)

    def add_output(self, pcm16: bytes) -> None:
        if pcm16:
            self._out_bytes += len(pcm16)

    @property
    def input_seconds(self) -> float:
        return self._in_bytes / (self._in_rate * 2)

    @property
    def output_seconds(self) -> float:
        return self._out_bytes / (self._out_rate * 2)


def _split_modality(details, total: int) -> tuple[int, int]:
    """Split a token total into (audio, text) using the modality details list.

    Each detail is a ModalityTokenCount with ``.modality`` (AUDIO/TEXT/…) and
    ``.token_count``. Unknown modalities (image/video/document) are bucketed as
    text. When no details are present we fall back to all-audio (a voice call is
    audio-dominated), which keeps older SDKs from zero-pricing the call.
    """
    if not details:
        return total, 0
    audio = text = 0
    for d in details:
        mod = str(getattr(d, "modality", "") or "").upper()
        cnt = int(getattr(d, "token_count", 0) or 0)
        if "AUDIO" in mod:
            audio += cnt
        else:
            text += cnt
    return audio, text


class UsageTracker:
    """Accumulates Gemini Live token usage by modality, surviving reconnects.

    The Live API reports ``usage_metadata`` cumulatively *within a session*; on a
    reconnect the counters reset to zero. We detect a reset (the prompt/response
    total going *down*) and roll the finished session's per-modality totals into a
    committed sum, so the final figures span every session the call went through.
    """

    __slots__ = ("_c", "_s", "_sin", "_sout")

    _KEYS = ("audio_in", "text_in", "audio_out", "text_out")

    def __init__(self):
        self._c = {k: 0 for k in self._KEYS}   # committed (prior sessions)
        self._s = {k: 0 for k in self._KEYS}   # current session latest cumulative
        self._sin = 0                          # current session prompt total
        self._sout = 0                         # current session response total

    def update(self, usage_metadata) -> None:
        if usage_metadata is None:
            return
        um = usage_metadata
        pin = int(getattr(um, "prompt_token_count", 0) or 0)
        pout = int(
            getattr(um, "response_token_count", None)
            or getattr(um, "candidates_token_count", None)
            or 0
        )
        if pin < self._sin or pout < self._sout:   # totals dropped → session reset
            for k in self._KEYS:
                self._c[k] += self._s[k]
                self._s[k] = 0
            self._sin = self._sout = 0
        self._sin = max(self._sin, pin)
        self._sout = max(self._sout, pout)

        ai, ti = _split_modality(getattr(um, "prompt_tokens_details", None), pin)
        ao, to = _split_modality(getattr(um, "response_tokens_details", None), pout)
        self._s["audio_in"] = max(self._s["audio_in"], ai)
        self._s["text_in"] = max(self._s["text_in"], ti)
        self._s["audio_out"] = max(self._s["audio_out"], ao)
        self._s["text_out"] = max(self._s["text_out"], to)

    def totals(self) -> dict:
        return {k: self._c[k] + self._s[k] for k in self._KEYS}

    @property
    def input_tokens(self) -> int:
        return self._c["audio_in"] + self._s["audio_in"] + self._c["text_in"] + self._s["text_in"]

    @property
    def output_tokens(self) -> int:
        return self._c["audio_out"] + self._s["audio_out"] + self._c["text_out"] + self._s["text_out"]
