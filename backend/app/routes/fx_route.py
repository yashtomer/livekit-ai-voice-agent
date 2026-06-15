import logging
import time
import httpx
from fastapi import APIRouter, Depends
from .auth import get_current_user

router = APIRouter()
logger = logging.getLogger("fx")

_fx_cache: dict = {"data": None, "expires_at": 0}

FX_FALLBACK_RATE = 84.0


async def _fetch_fx() -> dict:
    """Live USD→INR rate (frankfurter.dev / ECB), cached for 1 hour."""
    now = time.time()
    cached = _fx_cache.get("data")
    if cached and _fx_cache["expires_at"] > now:
        return cached
    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as c:
            r = await c.get("https://api.frankfurter.dev/v1/latest?from=USD&to=INR")
            r.raise_for_status()
            data = r.json()
            result = {
                "rate": data["rates"]["INR"],
                "date": data.get("date"),
                "source": "frankfurter.dev (ECB)",
                "fetched_at": now,
            }
            _fx_cache["data"] = result
            _fx_cache["expires_at"] = now + 3600
            return result
    except Exception as e:
        logger.warning(f"FX rate fetch failed: {e}")
        if cached:
            return cached
        return {"rate": FX_FALLBACK_RATE, "date": None, "source": "fallback", "fetched_at": now}


async def get_usd_inr_rate() -> float:
    """Just the live USD→INR rate (shares the same hourly cache). Used by the
    per-call cost estimator so costs track the same rate the costing pages show."""
    data = await _fetch_fx()
    try:
        return float(data.get("rate") or 0) or FX_FALLBACK_RATE
    except (TypeError, ValueError):
        return FX_FALLBACK_RATE


@router.get("/fx-rate")
async def fx_rate(_user=Depends(get_current_user)):
    return await _fetch_fx()
