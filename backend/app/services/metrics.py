"""Usage metrics collector.

All write paths land here. Each function writes one UsageEvent row and
updates the corresponding aggregate counters on User / Project in the
same transaction so dashboards can read O(1) without aggregation.

Events are best-effort: failures must never break the user-facing
endpoint, so callers should wrap calls in `try/except` and log.
"""

import json
import logging
from datetime import datetime, timezone

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.models.usage_event import UsageEvent
from app.models.user import User
from app.utils.boards import board_family_from_fqbn
from app.utils.geo import country_from_request

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _project_for_update(db: AsyncSession, project_id: str | None) -> Project | None:
    if not project_id:
        return None
    result = await db.execute(select(Project).where(Project.id == project_id))
    return result.scalar_one_or_none()


def _touch_user(user: User | None, country: str | None) -> None:
    """Update last_active_at and last_country on the user (in-place)."""
    if user is None:
        return
    user.last_active_at = _now()
    if country:
        user.last_country = country


async def record_compile(
    db: AsyncSession,
    *,
    user: User | None,
    project_id: str | None,
    board_fqbn: str | None,
    success: bool,
    duration_ms: int | None = None,
    error_kind: str | None = None,
    extra: dict | None = None,
    request: Request | None = None,
) -> None:
    """Record a compile attempt (success or failure)."""
    try:
        country = country_from_request(request)
        family = board_family_from_fqbn(board_fqbn)
        event = UsageEvent(
            user_id=user.id if user else None,
            project_id=project_id,
            event_type="compile" if success else "compile_error",
            board_fqbn=board_fqbn,
            board_family=family,
            duration_ms=duration_ms,
            error_kind=error_kind,
            country=country,
            metadata_json=json.dumps(extra) if extra else None,
        )
        db.add(event)

        if user is not None:
            user.total_compiles += 1
            if not success:
                user.total_compile_errors += 1
            _touch_user(user, country)

        project = await _project_for_update(db, project_id)
        if project is not None:
            project.compile_count += 1
            if not success:
                project.compile_error_count += 1
            project.last_compiled_at = _now()

        await db.commit()
    except Exception:
        logger.exception("record_compile failed (swallowed)")
        await db.rollback()


async def record_run(
    db: AsyncSession,
    *,
    user: User | None,
    project_id: str | None,
    board_fqbn: str | None,
    extra: dict | None = None,
    request: Request | None = None,
) -> None:
    """Record a simulation run (Run button press)."""
    try:
        country = country_from_request(request)
        family = board_family_from_fqbn(board_fqbn)
        event = UsageEvent(
            user_id=user.id if user else None,
            project_id=project_id,
            event_type="run",
            board_fqbn=board_fqbn,
            board_family=family,
            country=country,
            metadata_json=json.dumps(extra) if extra else None,
        )
        db.add(event)

        if user is not None:
            user.total_runs += 1
            _touch_user(user, country)

        project = await _project_for_update(db, project_id)
        if project is not None:
            project.run_count += 1
            project.last_run_at = _now()

        await db.commit()
    except Exception:
        logger.exception("record_run failed (swallowed)")
        await db.rollback()


async def record_save(
    db: AsyncSession,
    *,
    user: User | None,
    project: Project,
    is_create: bool = False,
    request: Request | None = None,
) -> None:
    """Record a project create or update.

    `project` must already be persisted (committed). For updates we bump
    `update_count` here. For creates we just log the event.
    """
    try:
        country = country_from_request(request)
        event = UsageEvent(
            user_id=user.id if user else None,
            project_id=project.id,
            event_type="create" if is_create else "save",
            board_fqbn=None,
            board_family=None,
            country=country,
        )
        db.add(event)

        _touch_user(user, country)
        if not is_create:
            project.update_count += 1

        await db.commit()
    except Exception:
        logger.exception("record_save failed (swallowed)")
        await db.rollback()


async def record_project_open(
    db: AsyncSession,
    *,
    user: User | None,
    project_id: str,
    request: Request | None = None,
) -> None:
    """Record a project view (different from owner edit)."""
    try:
        country = country_from_request(request)
        event = UsageEvent(
            user_id=user.id if user else None,
            project_id=project_id,
            event_type="project_open",
            country=country,
        )
        db.add(event)
        _touch_user(user, country)
        await db.commit()
    except Exception:
        logger.exception("record_project_open failed (swallowed)")
        await db.rollback()
