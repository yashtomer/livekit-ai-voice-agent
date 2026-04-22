"""Bootstrap Voicebox with ready-to-use preset profiles.

Voicebox starts with zero voice profiles. This script:
  1. If Voicebox is running in Docker (container `voicebox`), fixes the
     volume-ownership permission bug where HuggingFace cache + data dirs
     are created as root but the container runs as non-root.
  2. Creates a handful of Kokoro-based preset profiles so you can pick
     'Voicebox · Bella' (or similar) in the voice agent's TTS dropdown.

Usage:
    # Native:
    cd voicebox && just dev-backend &
    uv run python scripts/voicebox_bootstrap.py

    # Docker:
    cd voicebox && docker compose up -d
    uv run python scripts/voicebox_bootstrap.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

import httpx

VOICEBOX_URL = os.environ.get("VOICEBOX_URL", "http://localhost:17493")
DOCKER_CONTAINER_NAME = "voicebox"


def fix_docker_permissions() -> None:
    """If Voicebox is running as a Docker container, chown its mount points
    to the non-root `voicebox` user so Kokoro/Qwen can write to the HF cache
    and `/app/data/generations`. No-op if Docker isn't available or container
    isn't running."""
    docker_bin = shutil.which("docker")
    if not docker_bin:
        return
    try:
        r = subprocess.run(
            [docker_bin, "ps", "--filter", f"name={DOCKER_CONTAINER_NAME}", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=5,
        )
        if DOCKER_CONTAINER_NAME not in r.stdout:
            return  # not a dockerized Voicebox
    except Exception:
        return

    print(f"→ Detected Docker container '{DOCKER_CONTAINER_NAME}' — fixing volume permissions...")
    for target in ("/home/voicebox/.cache", "/app/data"):
        try:
            subprocess.run(
                [docker_bin, "exec", "-u", "root", DOCKER_CONTAINER_NAME,
                 "chown", "-R", "voicebox:voicebox", target],
                check=True, capture_output=True, text=True, timeout=30,
            )
            print(f"  ✓ chown {target}")
        except subprocess.CalledProcessError as e:
            print(f"  ⚠ chown {target} failed: {e.stderr.strip()[:120]}")
        except Exception as e:
            print(f"  ⚠ chown {target} error: {e}")

# Subset of Kokoro preset voices to bootstrap. The rest can be added via the
# Tauri desktop UI or more REST calls — see /profiles/presets/kokoro for the
# full catalog.
DEFAULT_KOKORO_VOICES = [
    ("af_bella",   "Kokoro · Bella",   "Friendly female — good default"),
    ("am_michael", "Kokoro · Michael", "Clear male voice"),
    ("af_heart",   "Kokoro · Heart",   "Expressive female"),
    ("af_nicole",  "Kokoro · Nicole",  "Calm female"),
    ("am_onyx",    "Kokoro · Onyx",    "Deep male"),
]


def main() -> int:
    print(f"→ Checking Voicebox at {VOICEBOX_URL}...")
    try:
        r = httpx.get(f"{VOICEBOX_URL}/health", timeout=3.0)
        r.raise_for_status()
    except httpx.HTTPError as e:
        print(f"✗ Voicebox not reachable: {e}")
        print("  Start it first:  cd voicebox && docker compose up -d   # or:  just dev-backend")
        return 1

    # Auto-fix Docker volume permissions (no-op if running natively)
    fix_docker_permissions()

    print("→ Verifying Kokoro preset voices are available...")
    try:
        r = httpx.get(f"{VOICEBOX_URL}/profiles/presets/kokoro", timeout=5.0)
        r.raise_for_status()
        available = {v["voice_id"] for v in r.json().get("voices", [])}
        print(f"  {len(available)} Kokoro preset voice(s) available")
    except Exception as e:
        print(f"  ✗ Could not fetch Kokoro presets: {e}")
        return 1

    print("→ Fetching existing profiles...")
    existing = {p["name"] for p in httpx.get(f"{VOICEBOX_URL}/profiles", timeout=5.0).json()}
    print(f"  {len(existing)} existing profile(s)")

    created = skipped = failed = 0
    for voice_id, name, description in DEFAULT_KOKORO_VOICES:
        if name in existing:
            print(f"  ✓ '{name}' already exists — skipping")
            skipped += 1
            continue
        if voice_id not in available:
            print(f"  ⚠ Kokoro voice '{voice_id}' not available — skipping")
            continue
        try:
            r = httpx.post(
                f"{VOICEBOX_URL}/profiles",
                json={
                    "name": name,
                    "description": description,
                    "language": "en",
                    "voice_type": "preset",
                    "preset_engine": "kokoro",
                    "preset_voice_id": voice_id,
                    "default_engine": "kokoro",
                },
                timeout=10.0,
            )
            r.raise_for_status()
            print(f"  ✓ Created '{name}' (id={r.json()['id'][:8]})")
            created += 1
        except httpx.HTTPStatusError as e:
            print(f"  ✗ {name}: HTTP {e.response.status_code}: {e.response.text[:160]}")
            failed += 1
        except Exception as e:
            print(f"  ✗ {name}: {e}")
            failed += 1

    print()
    print(f"Summary: {created} created · {skipped} skipped · {failed} failed")
    print("Reload http://localhost:8000 — Voicebox voices should appear in the TTS dropdown.")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
