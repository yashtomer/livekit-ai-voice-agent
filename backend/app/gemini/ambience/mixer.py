"""
Mix ambient PCM into an outgoing audio stream.

Usage:
    mixer = AmbientMixer(slug="office_busy", target_rate=24000, volume=0.15)
    out = mixer.mix(pcm16_bytes)            # adds N samples of ambient under the voice

`pcm16_bytes` must be little-endian 16-bit mono at ``target_rate``. The mixer
keeps a per-instance loop pointer, so each call session has its own playback
position and the loop seam stays inaudible across chunks.

Loading priority:
  1. ``backend/app/gemini/ambience/assets/{slug}.wav``  (mono, any sample rate)
  2. Procedural generator from ``synth.py``

Resampled PCM16 buffers are cached per (slug, target_rate) tuple so subsequent
sessions on the same sample rate pay zero CPU on load.
"""

from __future__ import annotations
import audioop
import logging
import threading
import wave
from pathlib import Path

from .synth import GEN_RATE, GENERATORS

log = logging.getLogger("ambient_mixer")

ASSET_DIR = Path(__file__).resolve().parent / "assets"

# Cache: (slug, target_rate) → PCM16 bytes ready to be looped at that rate.
_cache: dict[tuple[str, int], bytes] = {}
_cache_lock = threading.Lock()


def _load_wav_pcm16(path: Path) -> tuple[bytes, int, int]:
    """Read a WAV → (raw PCM16 bytes, sample_rate, channels). Converts to mono PCM16."""
    with wave.open(str(path), "rb") as w:
        rate = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        raw = audioop.lin2lin(raw, sw, 2)
    if ch == 2:
        raw = audioop.tomono(raw, 2, 0.5, 0.5)
    return raw, rate, 1


def _resample(pcm16: bytes, src_rate: int, dst_rate: int) -> bytes:
    if src_rate == dst_rate:
        return pcm16
    out, _ = audioop.ratecv(pcm16, 2, 1, src_rate, dst_rate, None)
    return out


def _load_buffer(slug: str, target_rate: int) -> bytes:
    """Return the ambient loop PCM16 buffer at ``target_rate`` (cached)."""
    key = (slug, target_rate)
    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None:
            return cached

    pcm: bytes
    src_rate: int

    # Real asset takes priority over the procedural generator
    wav_path = ASSET_DIR / f"{slug}.wav"
    if wav_path.is_file():
        try:
            pcm, src_rate, _ = _load_wav_pcm16(wav_path)
            log.info("Ambient %s loaded from %s (%d Hz, %d bytes)", slug, wav_path.name, src_rate, len(pcm))
        except Exception:
            log.exception("Failed to load %s; falling back to procedural generator", wav_path)
            wav_path = None  # type: ignore[assignment]
    else:
        wav_path = None  # type: ignore[assignment]

    if not wav_path:
        gen = GENERATORS.get(slug)
        if gen is None:
            log.warning("Unknown ambient slug %r — using silence", slug)
            buf = b"\x00\x00" * target_rate  # 1 s of silence
            with _cache_lock:
                _cache[key] = buf
            return buf
        pcm = gen()
        src_rate = GEN_RATE

    out = _resample(pcm, src_rate, target_rate)
    with _cache_lock:
        _cache[key] = out
    return out


class AmbientMixer:
    """Streamingly mixes a looped ambient buffer into outgoing PCM16 audio."""

    __slots__ = ("slug", "target_rate", "volume", "_buf", "_pos", "_enabled")

    def __init__(self, slug: str | None, target_rate: int, volume: float):
        self.slug = slug
        self.target_rate = target_rate
        self.volume = max(0.0, min(1.0, volume))
        self._pos = 0
        self._enabled = bool(slug) and self.volume > 0
        self._buf = _load_buffer(slug, target_rate) if self._enabled else b""

    @property
    def enabled(self) -> bool:
        return self._enabled

    def mix(self, voice_pcm16: bytes) -> bytes:
        """Return voice + ambient, same length as ``voice_pcm16``."""
        if not self._enabled or not voice_pcm16:
            return voice_pcm16

        need = len(voice_pcm16)
        buf = self._buf
        n = len(buf)
        # Build a slice of ambient sized exactly `need`, wrapping the loop pointer.
        if self._pos + need <= n:
            slice_ = buf[self._pos:self._pos + need]
            self._pos += need
        else:
            head = buf[self._pos:]
            remaining = need - len(head)
            wraps, tail_len = divmod(remaining, n)
            slice_ = head + (buf * wraps) + buf[:tail_len]
            self._pos = tail_len
        if self._pos >= n:
            self._pos = 0

        # Scale ambient by volume, then add to voice (audioop saturates on overflow).
        scaled = audioop.mul(slice_, 2, self.volume)
        return audioop.add(voice_pcm16, scaled, 2)
