from typing import Any, Optional
from pydantic import BaseModel


class ModelEntryCreate(BaseModel):
    model_type: str
    provider: str
    model_id: str
    label: str
    price_per_hour: float = 0.0
    enabled: bool = True
    config: Optional[dict] = None
    sort_order: int = 100
    compute_profile: str = "none"
    min_vram_gb: Optional[int] = None


class ModelEntryUpdate(BaseModel):
    label: Optional[str] = None
    price_per_hour: Optional[float] = None
    enabled: Optional[bool] = None
    config: Optional[dict] = None
    sort_order: Optional[int] = None
    compute_profile: Optional[str] = None
    min_vram_gb: Optional[int] = None


class ModelEntryResponse(BaseModel):
    id: int
    model_type: str
    provider: str
    model_id: str
    label: str
    price_per_hour: float
    enabled: bool
    config: Optional[Any] = None
    sort_order: int
    compute_profile: str = "none"
    min_vram_gb: Optional[int] = None
    is_seed: bool = True

    model_config = {"from_attributes": True}
