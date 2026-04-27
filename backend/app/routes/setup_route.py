"""Setup/runtime-readiness endpoints — currently the LiveKit turn-detector model."""
from fastapi import APIRouter, Depends

from .auth import get_current_user
from ..models.user import User
from ..services import model_setup

router = APIRouter()


@router.get("/turn-detector/status")
async def turn_detector_status(_: User = Depends(get_current_user)) -> dict:
    return model_setup.tracker.snapshot()


@router.post("/turn-detector/download")
async def turn_detector_download(_: User = Depends(get_current_user)) -> dict:
    return await model_setup.start_download()
