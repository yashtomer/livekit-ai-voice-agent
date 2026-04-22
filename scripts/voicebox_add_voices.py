"""Bulk-add Voicebox voice profiles from the built-in preset catalogs.

Unlike scripts/voicebox_bootstrap.py (which creates a minimal 5-voice set
for new users), this script discovers every preset voice Voicebox exposes
and creates a profile for each one missing. Running it against a fresh
Voicebox adds 50+ profiles in a few seconds — the underlying Kokoro model
is already loaded so no downloads happen.

Filter what gets added with command-line flags:

    # All English Kokoro voices (28 voices, default)
    uv run python scripts/voicebox_add_voices.py

    # All languages (50+ voices, adds es/fr/it/ja/pt/hi/zh)
    uv run python scripts/voicebox_add_voices.py --lang all

    # Specific languages
    uv run python scripts/voicebox_add_voices.py --lang en,ja,es

    # Add voices from a different engine (downloads model first if needed).
    # Available engines: kokoro, qwen-tts-1.7B, qwen-tts-0.6B, luxtts,
    #                    chatterbox-tts, chatterbox-turbo, tada-1b, tada-3b-ml
    uv run python scripts/voicebox_add_voices.py --engine luxtts

    # List what would be added without touching anything
    uv run python scripts/voicebox_add_voices.py --dry-run

    # Override VB url (default: http://localhost:17493)
    VOICEBOX_URL=http://remote:17493 uv run python scripts/voicebox_add_voices.py
"""
from __future__ import annotations

import argparse
import os
import sys

import httpx

VOICEBOX_URL = os.environ.get("VOICEBOX_URL", "http://localhost:17493")

# Readable language labels shown in profile names
LANG_LABELS = {
    "en": "EN", "es": "ES", "fr": "FR", "it": "IT",
    "ja": "JA", "pt": "PT", "hi": "HI", "zh": "ZH",
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--engine", default="kokoro",
                   help="TTS engine to pull preset voices from (default: kokoro)")
    p.add_argument("--lang", default="en",
                   help="Comma-separated languages to include, or 'all' (default: en)")
    p.add_argument("--dry-run", action="store_true",
                   help="Print what would be created but don't POST /profiles")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    # Pre-flight: is Voicebox up?
    try:
        httpx.get(f"{VOICEBOX_URL}/health", timeout=3.0).raise_for_status()
    except httpx.HTTPError as e:
        print(f"✗ Voicebox not reachable at {VOICEBOX_URL}: {e}")
        print("  Start it first: cd voicebox && docker compose up -d")
        return 1

    # Fetch the engine's preset catalog
    print(f"→ Fetching {args.engine} presets from {VOICEBOX_URL}...")
    try:
        r = httpx.get(f"{VOICEBOX_URL}/profiles/presets/{args.engine}", timeout=5.0)
        r.raise_for_status()
        presets = r.json().get("voices", [])
    except httpx.HTTPStatusError as e:
        print(f"✗ Engine '{args.engine}' not available: HTTP {e.response.status_code}")
        print(f"  Tip: check /models/status — you may need to download it first:")
        print(f"    curl -X POST {VOICEBOX_URL}/models/download -H 'content-type: application/json' \\")
        print(f"         -d '{{\"model_name\":\"{args.engine}\"}}'")
        return 1
    except Exception as e:
        print(f"✗ Could not fetch presets: {e}")
        return 1

    if not presets:
        print(f"  ⚠ No preset voices in {args.engine} catalog")
        return 0

    # Language filter
    wanted_langs = None if args.lang == "all" else {x.strip() for x in args.lang.split(",") if x.strip()}
    if wanted_langs:
        presets = [v for v in presets if v.get("language", "en") in wanted_langs]

    print(f"  {len(presets)} preset voice(s) match filter (engine={args.engine}, lang={args.lang})")

    # Diff against existing profiles to avoid duplicate-name conflicts
    existing = {p["name"] for p in httpx.get(f"{VOICEBOX_URL}/profiles", timeout=5.0).json()}
    print(f"  {len(existing)} profile(s) already exist")

    created = skipped = failed = 0
    for v in presets:
        voice_id = v["voice_id"]
        voice_name = v.get("name", voice_id)
        lang = v.get("language", "en")
        lang_tag = LANG_LABELS.get(lang, lang.upper())
        # Voicebox/Kokoro voice_id convention: {lang}{gender}_{name} where
        # first letter after lang is 'f' (female) or 'm' (male). Split on '_'.
        gender = "F" if len(voice_id) >= 2 and voice_id[1] == "f" else "M"

        # Human-friendly profile name; disambiguate by language if non-English
        if lang == "en":
            profile_name = f"Kokoro · {voice_name}"
        else:
            profile_name = f"Kokoro · {voice_name} ({lang_tag})"

        description = f"{gender} · {lang_tag} · Kokoro preset"

        if profile_name in existing:
            skipped += 1
            continue

        if args.dry_run:
            print(f"  [dry-run] would create '{profile_name}'  {gender} {lang_tag}")
            created += 1
            continue

        try:
            r = httpx.post(
                f"{VOICEBOX_URL}/profiles",
                json={
                    "name": profile_name,
                    "description": description,
                    "language": lang,
                    "voice_type": "preset",
                    "preset_engine": args.engine,
                    "preset_voice_id": voice_id,
                    "default_engine": args.engine,
                },
                timeout=10.0,
            )
            r.raise_for_status()
            print(f"  ✓ {profile_name}  ({gender} {lang_tag})")
            created += 1
        except httpx.HTTPStatusError as e:
            print(f"  ✗ {profile_name}: HTTP {e.response.status_code}: {e.response.text[:120]}")
            failed += 1
        except Exception as e:
            print(f"  ✗ {profile_name}: {e}")
            failed += 1

    print()
    action = "would create" if args.dry_run else "created"
    print(f"Summary: {created} {action} · {skipped} skipped (already exist) · {failed} failed")
    if not args.dry_run and created:
        print("Reload http://localhost:8000 — new voices appear in the TTS dropdown.")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
