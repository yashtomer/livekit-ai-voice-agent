"""Manage runtime download/availability of LiveKit turn-detector models.

The agent crashes if the turn-detector model files aren't present in the
HuggingFace cache. We expose a small state machine so the frontend can
detect this, trigger a download, and watch progress before starting a call.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Literal

logger = logging.getLogger("model-setup")

# Both backend and agent containers mount the same volume at HF_HOME, so a
# download from backend reaches the agent at runtime without rebuilding.
HF_HOME = Path(os.environ.get("HF_HOME", str(Path.home() / ".cache" / "huggingface")))

State = Literal["idle", "downloading", "ready", "error"]


class TurnDetectorState:
    """In-process state tracker for the turn-detector download job."""

    def __init__(self) -> None:
        self.state: State = "idle"
        self.message: str = ""
        self.detail: str = ""
        self.last_log: str = ""
        self.started_at: float = 0.0
        self.finished_at: float = 0.0
        self.lock = asyncio.Lock()
        self._task: asyncio.Task | None = None

    def snapshot(self) -> dict:
        return {
            "state": self.state,
            "message": self.message,
            "detail": self.detail,
            "last_log": self.last_log,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "ready": self.is_ready(),
        }

    def is_ready(self) -> bool:
        """Heuristic: model files present in HF cache means we're ready.

        We look for any directory under hub/ that begins with
        ``models--livekit--turn-detector`` and has at least one snapshot.
        """
        hub = HF_HOME / "hub"
        if not hub.exists():
            return False
        for entry in hub.iterdir():
            if not entry.name.startswith("models--livekit--turn-detector"):
                continue
            snapshots = entry / "snapshots"
            if snapshots.exists() and any(snapshots.iterdir()):
                # Need at least one .onnx file to consider it usable
                for snap in snapshots.iterdir():
                    onnx_dir = snap / "onnx"
                    if onnx_dir.exists() and any(onnx_dir.glob("*.onnx")):
                        return True
        return False


tracker = TurnDetectorState()


async def _run_download() -> None:
    """Run ``python agent.py download-files`` and stream progress into state."""
    tracker.state = "downloading"
    tracker.message = "Starting download…"
    tracker.detail = ""
    tracker.last_log = ""
    tracker.started_at = time.time()
    tracker.finished_at = 0.0

    # Run from /app so it finds agent.py. Prefer the prebuilt venv python so we
    # don't re-resolve dependencies on every download trigger.
    cwd = "/app"
    if not Path(cwd).exists():
        cwd = str(Path(__file__).resolve().parents[3])
    venv_python = Path(cwd) / ".venv" / "bin" / "python"
    python_bin = str(venv_python) if venv_python.exists() else "python"
    cmd = [python_bin, "agent.py", "download-files"]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError as e:
        tracker.state = "error"
        tracker.message = "Could not start download"
        tracker.detail = str(e)
        tracker.finished_at = time.time()
        return

    assert proc.stdout is not None

    async def pump_logs() -> None:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode(errors="replace").rstrip()
            if not text:
                continue
            tracker.last_log = text[-200:]
            # Update human-readable message based on familiar log markers
            lower = text.lower()
            if "downloading" in lower:
                tracker.message = text[-120:]
            elif "finished downloading" in lower:
                tracker.message = "Finalising…"

    pump_task = asyncio.create_task(pump_logs())
    rc = await proc.wait()
    await pump_task

    tracker.finished_at = time.time()
    if rc == 0 and tracker.is_ready():
        tracker.state = "ready"
        tracker.message = "Models ready"
        tracker.detail = ""
    else:
        tracker.state = "error"
        tracker.message = f"Download failed (exit {rc})"
        tracker.detail = tracker.last_log


async def start_download() -> dict:
    """Idempotently kick off a download. Returns the current snapshot."""
    async with tracker.lock:
        if tracker.state == "downloading":
            return tracker.snapshot()
        if tracker.is_ready():
            tracker.state = "ready"
            tracker.message = "Models ready"
            return tracker.snapshot()
        # Reset and launch
        tracker._task = asyncio.create_task(_run_download())
    # Yield once so state transitions to "downloading" before returning
    await asyncio.sleep(0)
    return tracker.snapshot()


async def ensure_downloaded_in_background() -> None:
    """Called at backend startup: if models missing, kick off download."""
    if tracker.is_ready():
        tracker.state = "ready"
        tracker.message = "Models ready"
        logger.info("Turn-detector models present")
        return
    logger.info("Turn-detector models missing — starting background download")
    await start_download()
