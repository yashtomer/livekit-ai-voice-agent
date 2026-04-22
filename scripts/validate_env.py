"""Validate every provider API key in .env by making a minimal read-only
request to each provider's API. Prints a PASS/FAIL report without exposing
the secrets.

Usage: uv run python scripts/validate_env.py
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

# ANSI colours for the terminal
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"

TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def mask(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 10:
        return "***"
    return value[:4] + "…" + value[-4:]


async def check_openai(client: httpx.AsyncClient, key: str) -> tuple[bool, str]:
    r = await client.get(
        "https://api.openai.com/v1/models",
        headers={"Authorization": f"Bearer {key}"},
    )
    if r.status_code == 200:
        n = len(r.json().get("data", []))
        return True, f"{n} models available"
    return False, f"HTTP {r.status_code}: {r.text[:120]}"


async def check_google(client: httpx.AsyncClient, key: str) -> tuple[bool, str]:
    r = await client.get(
        f"https://generativelanguage.googleapis.com/v1beta/models?key={key}"
    )
    if r.status_code == 200:
        models = r.json().get("models", [])
        gemini = [m for m in models if "gemini" in m.get("name", "")]
        return True, f"{len(gemini)} Gemini models accessible"
    return False, f"HTTP {r.status_code}: {r.text[:120]}"


async def check_groq(client: httpx.AsyncClient, key: str) -> tuple[bool, str]:
    r = await client.get(
        "https://api.groq.com/openai/v1/models",
        headers={"Authorization": f"Bearer {key}"},
    )
    if r.status_code == 200:
        return True, f"{len(r.json().get('data', []))} models available"
    return False, f"HTTP {r.status_code}: {r.text[:120]}"


async def check_anthropic(client: httpx.AsyncClient, key: str) -> tuple[bool, str]:
    r = await client.get(
        "https://api.anthropic.com/v1/models",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
    )
    if r.status_code == 200:
        return True, f"{len(r.json().get('data', []))} Claude models accessible"
    return False, f"HTTP {r.status_code}: {r.text[:120]}"


async def check_deepseek(client: httpx.AsyncClient, key: str) -> tuple[bool, str]:
    r = await client.get(
        "https://api.deepseek.com/v1/models",
        headers={"Authorization": f"Bearer {key}"},
    )
    if r.status_code == 200:
        return True, f"{len(r.json().get('data', []))} models available"
    return False, f"HTTP {r.status_code}: {r.text[:120]}"


async def check_deepgram(client: httpx.AsyncClient, key: str) -> tuple[bool, str]:
    r = await client.get(
        "https://api.deepgram.com/v1/projects",
        headers={"Authorization": f"Token {key}"},
    )
    if r.status_code == 200:
        projs = r.json().get("projects", [])
        return True, f"{len(projs)} project(s) accessible"
    return False, f"HTTP {r.status_code}: {r.text[:120]}"


async def check_elevenlabs(client: httpx.AsyncClient, key: str) -> tuple[bool, str]:
    # /v1/user returns account info including subscription tier & char budget
    r = await client.get(
        "https://api.elevenlabs.io/v1/user",
        headers={"xi-api-key": key},
    )
    if r.status_code == 200:
        data = r.json()
        sub = data.get("subscription", {})
        tier = sub.get("tier", "unknown")
        char_count = sub.get("character_count", 0)
        char_limit = sub.get("character_limit", 0)
        return True, f"tier={tier} · {char_count:,}/{char_limit:,} chars used"
    return False, f"HTTP {r.status_code}: {r.text[:120]}"


async def check_livekit() -> tuple[bool, str]:
    url = os.environ.get("LIVEKIT_URL", "")
    key = os.environ.get("LIVEKIT_API_KEY", "")
    secret = os.environ.get("LIVEKIT_API_SECRET", "")
    if not (url and key and secret):
        return False, "missing URL, KEY, or SECRET"
    # Try signing a token — purely local, validates the format
    try:
        from livekit import api
        token = (
            api.AccessToken(key, secret)
            .with_identity("validate-test")
            .with_grants(api.VideoGrants(room="test", room_join=True))
            .to_jwt()
        )
        return True, f"URL={url} · token signed ({len(token)} chars)"
    except Exception as e:
        return False, f"token signing failed: {e}"


CHECKS = [
    ("OPENAI_API_KEY",     check_openai,     "OpenAI (GPT-4o, Whisper, TTS)"),
    ("GOOGLE_API_KEY",     check_google,     "Google Gemini"),
    ("GROQ_API_KEY",       check_groq,       "Groq (Llama, Qwen, Whisper, Orpheus)"),
    ("ANTHROPIC_API_KEY",  check_anthropic,  "Anthropic (Claude)"),
    ("DEEPSEEK_API_KEY",   check_deepseek,   "DeepSeek"),
    ("DEEPGRAM_API_KEY",   check_deepgram,   "Deepgram (STT Nova-3)"),
    ("ELEVENLABS_API_KEY", check_elevenlabs, "ElevenLabs (TTS)"),
]


async def main() -> int:
    print()
    print(f"{BOLD}Validating provider API keys from .env{RESET}")
    print(f"{DIM}{ROOT / '.env'}{RESET}\n")

    # LiveKit first — special case (no external HTTP)
    ok, msg = await check_livekit()
    label = "LIVEKIT (URL+KEY+SECRET)".ljust(32)
    if ok:
        print(f"  {GREEN}✓ PASS{RESET}  {label}  {DIM}{msg}{RESET}")
    else:
        print(f"  {RED}✗ FAIL{RESET}  {label}  {msg}")

    pass_count = 1 if ok else 0
    fail_count = 0 if ok else 1
    skip_count = 0

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        for env_var, fn, desc in CHECKS:
            key = os.environ.get(env_var, "").strip()
            label = f"{env_var}".ljust(22) + f"{DIM}({mask(key)}){RESET}".ljust(20) if key else f"{env_var}".ljust(22)
            if not key:
                print(f"  {YELLOW}○ SKIP{RESET}  {env_var.ljust(32)} {DIM}not set — {desc} unavailable{RESET}")
                skip_count += 1
                continue
            try:
                ok, msg = await fn(client, key)
            except httpx.TimeoutException:
                ok, msg = False, "request timed out (network issue?)"
            except Exception as e:
                ok, msg = False, f"exception: {e}"

            if ok:
                print(f"  {GREEN}✓ PASS{RESET}  {env_var.ljust(22)} {DIM}{mask(key).ljust(14)}{RESET} {GREEN}{msg}{RESET}")
                pass_count += 1
            else:
                print(f"  {RED}✗ FAIL{RESET}  {env_var.ljust(22)} {DIM}{mask(key).ljust(14)}{RESET} {RED}{msg}{RESET}")
                fail_count += 1

    print()
    total = pass_count + fail_count + skip_count
    summary = (
        f"{GREEN}{pass_count} pass{RESET} · "
        f"{(RED if fail_count else DIM)}{fail_count} fail{RESET} · "
        f"{YELLOW if skip_count else DIM}{skip_count} skipped{RESET}"
        f"  {DIM}(of {total}){RESET}"
    )
    print(f"  {BOLD}Result:{RESET} {summary}\n")

    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
