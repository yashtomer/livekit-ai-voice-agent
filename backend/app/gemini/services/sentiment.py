"""
Lightweight, zero-cost live sentiment scorer for caller utterances.

Used during a live call to drive the UI mood meter + avatar glow without an
extra LLM round-trip. It is intentionally a simple lexicon heuristic — the
authoritative post-call sentiment still comes from the Gemini analysis in
`logger.py`. This just needs to be instant and "good enough" to react in
real time as the caller speaks.

`score_text` returns:
  - label       : "positive" | "neutral" | "negative"
  - score       : float in [-1, 1]  (negative … positive)
  - frustration : float in [0, 1]   (how upset / escalation-worthy)
"""
from __future__ import annotations

import re

# Word → weight lexicons (lowercased, matched on word boundaries).
_POSITIVE = {
    "thanks": 1.0, "thank": 1.0, "great": 1.0, "perfect": 1.2, "awesome": 1.2,
    "excellent": 1.2, "good": 0.7, "nice": 0.7, "love": 1.2, "happy": 1.0,
    "appreciate": 1.0, "wonderful": 1.2, "helpful": 1.0, "amazing": 1.2,
    "yes": 0.3, "sure": 0.3, "okay": 0.2, "ok": 0.2, "cool": 0.7, "brilliant": 1.2,
}
_NEGATIVE = {
    "no": 0.3, "not": 0.4, "bad": 0.9, "terrible": 1.3, "awful": 1.3, "horrible": 1.3,
    "useless": 1.3, "worst": 1.3, "hate": 1.3, "annoyed": 1.1, "annoying": 1.1,
    "disappointed": 1.1, "slow": 0.7, "broken": 1.0, "wrong": 0.8, "problem": 0.6,
    "issue": 0.5, "unacceptable": 1.4, "ridiculous": 1.4, "waste": 1.2, "never": 0.6,
}
# Strong frustration / escalation markers — phrases matter most here.
_FRUSTRATION_PHRASES = [
    "speak to a human", "talk to a human", "real person", "speak to someone",
    "speak to a manager", "talk to a manager", "your manager", "a manager",
    "this is ridiculous", "not working", "doesn't work", "does not work",
    "i want a refund", "cancel my", "fed up", "sick of", "waste of time",
    "for the last time", "i already told you", "are you even listening",
    "stop", "useless", "frustrated", "angry", "furious",
]


def _word_hits(text: str, lex: dict[str, float]) -> float:
    total = 0.0
    for word, w in lex.items():
        if re.search(rf"\b{re.escape(word)}\b", text):
            total += w
    return total


def score_text(text: str) -> dict:
    t = (text or "").lower().strip()
    if not t:
        return {"label": "neutral", "score": 0.0, "frustration": 0.0}

    pos = _word_hits(t, _POSITIVE)
    neg = _word_hits(t, _NEGATIVE)

    frustration = 0.0
    for phrase in _FRUSTRATION_PHRASES:
        if phrase in t:
            frustration += 0.45
            neg += 1.0
    # Shouting / repeated punctuation amplifies frustration.
    if "!" in text:
        frustration += 0.15 * min(text.count("!"), 3)
    if len(t) > 3 and sum(c.isupper() for c in text) / max(1, len(text)) > 0.6:
        frustration += 0.3

    frustration = max(0.0, min(1.0, frustration))

    raw = pos - neg
    # Squash to [-1, 1].
    score = max(-1.0, min(1.0, raw / 3.0))
    if frustration >= 0.5:
        score = min(score, -0.5)

    if score > 0.25:
        label = "positive"
    elif score < -0.25 or frustration >= 0.5:
        label = "negative"
    else:
        label = "neutral"

    return {"label": label, "score": round(score, 2), "frustration": round(frustration, 2)}
