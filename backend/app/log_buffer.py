"""In-memory circular log buffer — last 500 lines, streamed to admin UI."""
import logging
from collections import deque
from datetime import datetime, timezone

_buffer: deque[dict] = deque(maxlen=500)

_LEVEL_MAP = {
    "DEBUG": "debug",
    "INFO": "info",
    "WARNING": "warning",
    "ERROR": "error",
    "CRITICAL": "critical",
}


class _BufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            _buffer.append({
                "ts": datetime.now(timezone.utc).isoformat(),
                "level": _LEVEL_MAP.get(record.levelname, "info"),
                "logger": record.name,
                "msg": self.format(record),
            })
        except Exception:
            pass


def install() -> None:
    handler = _BufferHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logging.root.addHandler(handler)


def get_lines(tail: int = 200) -> list[dict]:
    lines = list(_buffer)
    return lines[-tail:] if tail < len(lines) else lines


def clear() -> None:
    _buffer.clear()
