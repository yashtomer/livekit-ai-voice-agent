"""
Server-side call recorder: a time-aligned mono mix of the caller and the agent.

The two legs arrive as PCM16 mono at different sample rates (caller 16 kHz,
agent 24 kHz) and at different wall-clock moments. Each incoming chunk is
resampled to a common ``RECORD_RATE`` and overlaid into one growable buffer at
the byte offset matching *when it arrived*, so both voices land roughly where
they actually occurred in the conversation. ``save()`` writes the buffer to a
WAV under ``RECORDINGS_DIR``.

Everything here is best-effort: a recorder failure must never break a live call.
"""
from __future__ import annotations

import audioop
import logging
import os
import time
import wave
from pathlib import Path

log = logging.getLogger("call_recorder")

RECORD_RATE = 16000  # storage rate — good speech quality, half the size of 24 kHz

# We stamp each leg when its audio reaches the server, but the agent's audio is
# *heard* later than that — it still has to travel downlink and sit in the
# client's playback/jitter buffer. The caller's audio, by contrast, is stamped
# after only its uplink delay. Left uncorrected, the agent lands too early and
# overlaps the tail of the caller's sentence. Nudging the agent leg later by this
# much restores the gap that was actually heard. Tune via env if needed.
AGENT_DELAY_MS = max(0, int(os.environ.get("GEMINI_RECORD_AGENT_DELAY_MS", "250")))

# Default to <repo>/backend/recordings; override with GEMINI_RECORDINGS_DIR.
RECORDINGS_DIR = Path(
    os.environ.get("GEMINI_RECORDINGS_DIR")
    or (Path(__file__).resolve().parents[3] / "recordings")
)


def recording_path(filename: str) -> Path:
    """Absolute path of a stored recording file (used by the serving route)."""
    return RECORDINGS_DIR / filename


class CallRecorder:
    """Accumulates caller + agent PCM into one time-aligned mono mix."""

    __slots__ = ("call_id", "enabled", "_t0", "_buf", "_state", "_end", "_delay")

    def __init__(self, call_id: int | None, agent_delay_ms: int | None = None):
        self.call_id = call_id
        self.enabled = call_id is not None
        self._t0 = time.monotonic()
        self._buf = bytearray()
        # Per-source ratecv state so resampling stays continuous across chunks.
        self._state: dict[str, object | None] = {"caller": None, "agent": None}
        # Per-source write cursor (byte position just past the last chunk) so a
        # leg never overlaps *itself* if it arrives faster than real-time.
        self._end: dict[str, int] = {"caller": 0, "agent": 0}
        # Per-source playback-latency compensation (seconds). Only the agent is
        # delayed — see AGENT_DELAY_MS.
        d = (AGENT_DELAY_MS if agent_delay_ms is None else max(0, agent_delay_ms)) / 1000.0
        self._delay: dict[str, float] = {"caller": 0.0, "agent": d}

    def _add(self, source: str, pcm16: bytes, src_rate: int) -> None:
        if not self.enabled or not pcm16:
            return
        try:
            if src_rate != RECORD_RATE:
                pcm16, self._state[source] = audioop.ratecv(
                    pcm16, 2, 1, src_rate, RECORD_RATE, self._state[source]
                )
            # Align the two legs by arrival time (plus each leg's latency
            # compensation), but never let one leg overlap itself: a bursty
            # stream appends contiguously instead of piling up.
            elapsed = time.monotonic() - self._t0 + self._delay[source]
            time_off = int(elapsed * RECORD_RATE) * 2
            offset = max(time_off, self._end[source])
            end = offset + len(pcm16)
            self._end[source] = end
            if len(self._buf) < end:
                self._buf.extend(b"\x00" * (end - len(self._buf)))
            existing = bytes(self._buf[offset:end])
            self._buf[offset:end] = audioop.add(existing, pcm16, 2)
        except Exception:
            log.exception("recorder add (%s) failed", source)

    def add_caller(self, pcm16: bytes, src_rate: int) -> None:
        self._add("caller", pcm16, src_rate)

    def add_agent(self, pcm16: bytes, src_rate: int) -> None:
        self._add("agent", pcm16, src_rate)

    def save(self) -> str | None:
        """Write the WAV and return its filename (or None if nothing recorded)."""
        if not self.enabled or not self._buf:
            return None
        try:
            RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
            filename = f"call_{self.call_id}.wav"
            path = RECORDINGS_DIR / filename
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(RECORD_RATE)
                w.writeframes(bytes(self._buf))
            log.info("📼 saved recording %s (%.1fs)", filename, len(self._buf) / 2 / RECORD_RATE)
            return filename
        except Exception:
            log.exception("recorder save failed for call %s", self.call_id)
            return None
