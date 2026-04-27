import logging
import time
import httpx
from fastapi import APIRouter, Depends
from .auth import get_current_user

router = APIRouter()
logger = logging.getLogger("fx")

_fx_cache: dict = {"data": None, "expires_at": 0}


@router.get("/fx-rate")
async def fx_rate(_user=Depends(get_current_user)):
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
        return {"rate": 84.0, "date": None, "source": "fallback", "fetched_at": now}
