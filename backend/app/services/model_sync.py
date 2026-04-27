import re
import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from ..models.model_entry import ModelEntry, ModelType
from ..config import OLLAMA_URL

MODEL_COMPANIES = {
    "gemma": "Google", "phi": "Microsoft", "llama": "Meta",
    "qwen": "Alibaba", "mistral": "Mistral AI", "tinyllama": "TinyLlama",
    "deepseek": "DeepSeek", "codellama": "Meta", "vicuna": "LMSYS",
}


def _ollama_compute_profile(model_name: str) -> tuple[str, int]:
    """Pick a server profile from the model's parameter count in its name."""
    m = re.search(r"(\d+(?:\.\d+)?)\s*b\b", model_name.lower())
    params_b = float(m.group(1)) if m else None
    if params_b is None:
        return "gpu_small", 12
    if params_b >= 65:
        return "gpu_large", 48
    if params_b >= 11:
        return "gpu_mid", 24
    return "gpu_small", 12


async def sync_models(db: AsyncSession) -> dict:
    """Refresh dynamic Ollama models in the DB. Seed reconcile is run separately
    by `app.main.reconcile_seed_models` at startup or via /api/admin/sync."""
    added, updated, errors = [], [], []

    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(f"{OLLAMA_URL}/api/tags")
            r.raise_for_status()
            ollama_models = r.json().get("models", [])

            for m in ollama_models:
                name = m["name"]
                size_gb = round(m.get("size", 0) / 1e9, 2)
                base = name.split(":")[0].split("/")[-1].lower()
                company = next(
                    (v for k, v in MODEL_COMPANIES.items() if base.startswith(k)),
                    "Open Source",
                )
                label = f"Ollama ({company}) · {name} — FREE | {size_gb}GB | local"
                profile, vram = _ollama_compute_profile(name)

                result = await db.execute(
                    select(ModelEntry).where(
                        ModelEntry.provider == "ollama",
                        ModelEntry.model_id == name,
                    )
                )
                existing = result.scalar_one_or_none()

                if existing:
                    # Only refresh label/profile if admin hasn't taken ownership.
                    if existing.is_seed:
                        changed = False
                        if existing.label != label:
                            existing.label = label
                            changed = True
                        if existing.compute_profile != profile:
                            existing.compute_profile = profile
                            changed = True
                        if existing.min_vram_gb != vram:
                            existing.min_vram_gb = vram
                            changed = True
                        if changed:
                            updated.append(name)
                else:
                    entry = ModelEntry(
                        model_type=ModelType.llm,
                        provider="ollama",
                        model_id=name,
                        label=label,
                        price_per_hour=0.0,
                        sort_order=200,
                        compute_profile=profile,
                        min_vram_gb=vram,
                        is_seed=True,
                    )
                    db.add(entry)
                    added.append(name)

    except Exception as e:
        errors.append(f"Ollama sync failed: {e}")

    await db.commit()
    return {"added": added, "updated": updated, "errors": errors}
