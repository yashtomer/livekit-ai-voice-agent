"""
Populate the use_case column for all seeded models.

Run inside the backend container:
    docker compose -f docker-compose-dev.yml exec backend uv run python scripts/seed_use_cases.py

Or directly (with venv active):
    cd backend && uv run python scripts/seed_use_cases.py
"""

import asyncio
import sys
from pathlib import Path

# Allow importing app modules from the backend root
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import select, update
from app.db import engine, SessionLocal
from app.models.model_entry import ModelEntry
from app.seed_data import USE_CASES


async def main() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: None)  # ensure connection works

    updated = 0
    skipped = 0

    async with SessionLocal() as db:
        result = await db.execute(select(ModelEntry))
        entries = result.scalars().all()

        for entry in entries:
            use_case = USE_CASES.get((entry.provider, entry.model_id))
            if use_case and entry.use_case != use_case:
                entry.use_case = use_case
                updated += 1
            else:
                skipped += 1

        await db.commit()

    print(f"Done — updated: {updated}, skipped (already set or no match): {skipped}")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
