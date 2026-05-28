"""
Procedural generators for the built-in ambient sounds.

Each generator returns a fixed-length (LOOP_SECONDS) PCM16 mono buffer
at 16 kHz. The mixer resamples and loops as needed.

We seed the PRNG per-slug so repeated calls (e.g. across worker restarts)
yield byte-identical loops — important for cache stability on disk.
"""

from __future__ import annotations
import array
import math
import random
from typing import Callable

GEN_RATE = 16000          # internal generator rate
LOOP_SECONDS = 8          # length of one synthesized loop
INT16_MAX = 32767
INT16_MIN = -32768


def _clip(v: float) -> int:
    if v > INT16_MAX: return INT16_MAX
    if v < INT16_MIN: return INT16_MIN
    return int(v)


def _make_buffer(seed: int) -> tuple[array.array, random.Random]:
    """Allocate an int16 array sized for one loop, with a deterministic PRNG."""
    n = GEN_RATE * LOOP_SECONDS
    buf = array.array("h", [0] * n)
    return buf, random.Random(seed)


def _pink_noise(buf: array.array, rng: random.Random, amplitude: float) -> None:
    """Cheap pink-ish noise via summed low-pass white noise."""
    n = len(buf)
    b0 = b1 = b2 = 0.0
    for i in range(n):
        w = (rng.random() * 2 - 1) * amplitude * INT16_MAX
        b0 = 0.99 * b0 + w * 0.0555179
        b1 = 0.96 * b1 + w * 0.2942
        b2 = 0.57 * b2 + w * 0.1848
        buf[i] = _clip(buf[i] + b0 + b1 + b2)


def _add_tone(buf: array.array, freq: float, amplitude: float, phase: float = 0.0) -> None:
    n = len(buf)
    step = 2 * math.pi * freq / GEN_RATE
    a = amplitude * INT16_MAX
    for i in range(n):
        buf[i] = _clip(buf[i] + a * math.sin(phase + step * i))


def _add_event(buf: array.array, start: int, samples: list[int]) -> None:
    end = min(start + len(samples), len(buf))
    j = 0
    for i in range(start, end):
        buf[i] = _clip(buf[i] + samples[j])
        j += 1


def _click(amp: float = 0.5, ms: int = 18) -> list[int]:
    """A short decaying click — keystroke-like."""
    n = max(1, int(GEN_RATE * ms / 1000))
    out: list[int] = []
    for i in range(n):
        env = (1.0 - i / n) ** 2
        v = (random.random() * 2 - 1) * env * amp * INT16_MAX
        out.append(_clip(v))
    return out


def _ring(amp: float = 0.25) -> list[int]:
    """A brief two-tone telephone ring (0.6 s)."""
    n = int(GEN_RATE * 0.6)
    out: list[int] = []
    for i in range(n):
        env = math.sin(math.pi * i / n) ** 2  # bell envelope
        v = amp * INT16_MAX * env * (
            0.5 * math.sin(2 * math.pi * 440 * i / GEN_RATE) +
            0.5 * math.sin(2 * math.pi * 480 * i / GEN_RATE)
        )
        out.append(_clip(v))
    return out


def _cup_clink(amp: float = 0.35) -> list[int]:
    """High-pitched dampened sine: ceramic clink."""
    n = int(GEN_RATE * 0.18)
    out: list[int] = []
    for i in range(n):
        env = math.exp(-i / (GEN_RATE * 0.04))
        v = amp * INT16_MAX * env * math.sin(2 * math.pi * 2100 * i / GEN_RATE)
        out.append(_clip(v))
    return out


# ── Public generators (one per slug) ─────────────────────────────────────────

def _gen_office_busy() -> bytes:
    buf, rng = _make_buffer(seed=1001)
    _pink_noise(buf, rng, amplitude=0.02)
    # A few low chatter tones varying in pitch
    for _ in range(30):
        f = 120 + rng.random() * 80
        start = rng.randint(0, len(buf) - GEN_RATE)
        n = int(GEN_RATE * (0.4 + rng.random() * 0.8))
        a = 0.03
        for i in range(n):
            if start + i >= len(buf): break
            env = math.sin(math.pi * i / n)
            buf[start + i] = _clip(buf[start + i] + a * INT16_MAX * env * math.sin(2 * math.pi * f * i / GEN_RATE))
    # A couple of ring bursts
    _add_event(buf, GEN_RATE * 2, _ring(0.14))
    _add_event(buf, GEN_RATE * 6, _ring(0.10))
    return buf.tobytes()


def _gen_office_quiet() -> bytes:
    buf, rng = _make_buffer(seed=1002)
    _add_tone(buf, freq=60, amplitude=0.008)   # very low HVAC hum
    # Occasional keyboard taps — clean, no noise floor
    for _ in range(14):
        _add_event(buf, rng.randint(0, len(buf) - 1), _click(0.14, 16))
    return buf.tobytes()


def _gen_call_center() -> bytes:
    buf, rng = _make_buffer(seed=1003)
    _pink_noise(buf, rng, amplitude=0.018)
    # Layered chatter at multiple pitches & cadences
    for _ in range(50):
        f = 110 + rng.random() * 140
        start = rng.randint(0, len(buf) - GEN_RATE)
        n = int(GEN_RATE * (0.3 + rng.random() * 0.6))
        a = 0.025 + rng.random() * 0.015
        for i in range(n):
            if start + i >= len(buf): break
            env = math.sin(math.pi * i / n)
            buf[start + i] = _clip(buf[start + i] + a * INT16_MAX * env * math.sin(2 * math.pi * f * i / GEN_RATE))
    return buf.tobytes()


def _gen_cafe() -> bytes:
    buf, rng = _make_buffer(seed=1004)
    _pink_noise(buf, rng, amplitude=0.015)
    for _ in range(22):
        f = 130 + rng.random() * 90
        start = rng.randint(0, len(buf) - GEN_RATE)
        n = int(GEN_RATE * (0.3 + rng.random() * 0.5))
        for i in range(n):
            if start + i >= len(buf): break
            env = math.sin(math.pi * i / n)
            buf[start + i] = _clip(buf[start + i] + 0.02 * INT16_MAX * env * math.sin(2 * math.pi * f * i / GEN_RATE))
    # Cup clinks at random
    for _ in range(6):
        _add_event(buf, rng.randint(0, len(buf) - GEN_RATE), _cup_clink(0.22))
    return buf.tobytes()


def _gen_elevator() -> bytes:
    """Soft major-chord arpeggio over a smooth pad — NO noise floor (music)."""
    buf, rng = _make_buffer(seed=1005)
    # Pad
    for f in (220.0, 277.18, 329.63):  # A3, C#4, E4
        _add_tone(buf, freq=f, amplitude=0.05)
    # Slow arpeggio
    melody = [440.0, 554.37, 659.25, 554.37]  # A4 C#5 E5 C#5
    note_n = GEN_RATE * 2
    for k, f in enumerate(melody):
        start = k * note_n
        if start >= len(buf): break
        for i in range(note_n):
            if start + i >= len(buf): break
            env = math.sin(math.pi * i / note_n)
            buf[start + i] = _clip(buf[start + i] + 0.08 * INT16_MAX * env * math.sin(2 * math.pi * f * i / GEN_RATE))
    return buf.tobytes()


def _gen_street() -> bytes:
    buf, rng = _make_buffer(seed=1006)
    _pink_noise(buf, rng, amplitude=0.035)
    _add_tone(buf, freq=50, amplitude=0.025)   # distant traffic rumble
    _add_tone(buf, freq=80, amplitude=0.015)
    return buf.tobytes()


def _gen_typing() -> bytes:
    """Dense mechanical-keyboard typing — discrete clicks only, no noise floor."""
    buf, rng = _make_buffer(seed=2001)
    pos = 0
    while pos < len(buf):
        gap = int(GEN_RATE * (0.05 + rng.random() * 0.12))   # 50–170 ms between keys
        pos += gap
        if pos >= len(buf): break
        _add_event(buf, pos, _click(0.45 + rng.random() * 0.2, 14 + int(rng.random() * 8)))
    return buf.tobytes()


def _gen_mouse_clicks() -> bytes:
    """Sparse double-clicks only, no noise floor."""
    buf, rng = _make_buffer(seed=2002)
    pos = 0
    while pos < len(buf):
        pos += int(GEN_RATE * (0.4 + rng.random() * 1.2))
        if pos >= len(buf): break
        # mouse click = double-tap close together
        _add_event(buf, pos, _click(0.55, 10))
        _add_event(buf, pos + int(GEN_RATE * 0.08), _click(0.42, 9))
    return buf.tobytes()


def _gen_processing() -> bytes:
    """Soft computer-thinking beeps — discrete events only, no noise floor."""
    buf, rng = _make_buffer(seed=2003)
    for _ in range(20):
        f = 600 + rng.random() * 1400
        start = rng.randint(0, len(buf) - GEN_RATE)
        n = int(GEN_RATE * 0.08)
        for i in range(n):
            if start + i >= len(buf): break
            env = math.sin(math.pi * i / n)
            buf[start + i] = _clip(buf[start + i] + 0.18 * INT16_MAX * env * math.sin(2 * math.pi * f * i / GEN_RATE))
    return buf.tobytes()


def _gen_paper_shuffle() -> bytes:
    """Discrete rustle bursts only, no noise floor."""
    buf, rng = _make_buffer(seed=2004)
    # Bursts of higher-frequency rustle
    for _ in range(6):
        start = rng.randint(0, len(buf) - GEN_RATE)
        n = int(GEN_RATE * (0.3 + rng.random() * 0.5))
        for i in range(n):
            if start + i >= len(buf): break
            env = math.sin(math.pi * i / n)
            v = (rng.random() * 2 - 1) * env * 0.35 * INT16_MAX
            buf[start + i] = _clip(buf[start + i] + v)
    return buf.tobytes()


GENERATORS: dict[str, Callable[[], bytes]] = {
    "office_busy":   _gen_office_busy,
    "office_quiet":  _gen_office_quiet,
    "call_center":   _gen_call_center,
    "cafe":          _gen_cafe,
    "elevator":      _gen_elevator,
    "street":        _gen_street,
    "typing":        _gen_typing,
    "mouse_clicks":  _gen_mouse_clicks,
    "processing":    _gen_processing,
    "paper_shuffle": _gen_paper_shuffle,
}
