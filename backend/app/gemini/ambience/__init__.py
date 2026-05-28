"""
Background ambience for Gemini voice calls.

Each ambient sound is a continuous 16-bit PCM mono stream that the
:class:`AmbientMixer` adds into the agent's outgoing audio.

Sounds can come from two places:

  1. A real WAV file dropped into ``assets/{slug}.wav`` (mono, any sample rate).
     Loaded once, resampled to the target rate at first use, looped forever.
  2. A built-in procedural generator (no audio asset needed) — keeps the demo
     working out of the box. Replace with real loops by dropping a WAV in.
"""

from .registry import AMBIENCE_REGISTRY, AmbienceDef, list_ambience
from .mixer import AmbientMixer

__all__ = ["AMBIENCE_REGISTRY", "AmbienceDef", "list_ambience", "AmbientMixer"]
