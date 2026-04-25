"""Public metrics endpoints — receives client-side telemetry pings."""

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user
from app.database.session import get_db
from app.models.user import User
from app.services.metrics import record_run

router = APIRouter()


class RunEventRequest(BaseModel):
    project_id: str | None = None
    board_fqbn: str | None = None


@router.post("/run", status_code=204)
async def report_run(
    body: RunEventRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    """Fire-and-forget: client calls this when the user presses Run."""
    await record_run(
        db,
        user=current_user,
        project_id=body.project_id,
        board_fqbn=body.board_fqbn,
        request=request,
    )
    return None
