from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.schemas import ProjectSnapshotV2, RunState
from app.agent.snapshot_compat import dump_snapshot_json, load_snapshot_json, snapshot_v2_to_legacy
from app.core.config import settings
from app.models.agent_session import AgentSession
from app.models.agent_session_event import AgentSessionEvent
from app.models.project import Project


_session_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


def get_session_lock(session_id: str) -> asyncio.Lock:
    return _session_locks[session_id]


async def create_session(
    db: AsyncSession,
    *,
    user_id: str,
    base_snapshot: ProjectSnapshotV2,
    project_id: str | None = None,
    model_name: str | None = None,
) -> AgentSession:
    snapshot_json = dump_snapshot_json(base_snapshot)
    session = AgentSession(
        user_id=user_id,
        project_id=project_id,
        status="queued",
        base_snapshot_json=snapshot_json,
        draft_snapshot_json=snapshot_json,
        model_name=model_name or settings.AGENT_MODEL,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


async def list_sessions(
    db: AsyncSession,
    *,
    user_id: str,
    project_id: str | None = None,
) -> list[AgentSession]:
    query = select(AgentSession).where(AgentSession.user_id == user_id)
    if project_id is not None:
        query = query.where(AgentSession.project_id == project_id)
    query = query.order_by(AgentSession.updated_at.desc())
    return list((await db.execute(query)).scalars().all())


async def get_session_for_user(
    db: AsyncSession,
    *,
    session_id: str,
    user_id: str,
) -> AgentSession | None:
    result = await db.execute(
        select(AgentSession).where(AgentSession.id == session_id, AgentSession.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def load_draft_snapshot(
    db: AsyncSession,
    *,
    session_id: str,
    user_id: str,
) -> ProjectSnapshotV2:
    session = await get_session_for_user(db, session_id=session_id, user_id=user_id)
    if session is None:
        raise ValueError("agent session not found")
    return load_snapshot_json(session.draft_snapshot_json)


async def update_draft_snapshot(
    db: AsyncSession,
    *,
    session_id: str,
    user_id: str,
    draft_snapshot: ProjectSnapshotV2,
    status: RunState | None = None,
) -> AgentSession:
    async with get_session_lock(session_id):
        session = await get_session_for_user(db, session_id=session_id, user_id=user_id)
        if session is None:
            raise ValueError("agent session not found")
        session.draft_snapshot_json = dump_snapshot_json(draft_snapshot)
        if status is not None:
            session.status = status
        session.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(session)
        return session


async def set_session_status(
    db: AsyncSession,
    *,
    session_id: str,
    user_id: str,
    status: RunState,
) -> AgentSession:
    async with get_session_lock(session_id):
        session = await get_session_for_user(db, session_id=session_id, user_id=user_id)
        if session is None:
            raise ValueError("agent session not found")
        session.status = status
        session.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(session)
        return session


async def append_event(
    db: AsyncSession,
    *,
    session_id: str,
    event_type: str,
    payload: dict[str, Any] | None = None,
) -> AgentSessionEvent:
    async with get_session_lock(session_id):
        result = await db.execute(
            select(func.max(AgentSessionEvent.seq)).where(AgentSessionEvent.session_id == session_id)
        )
        next_seq = (result.scalar_one_or_none() or 0) + 1
        event = AgentSessionEvent(
            session_id=session_id,
            seq=next_seq,
            event_type=event_type,
            payload_json=json.dumps(payload or {}),
        )
        db.add(event)
        session = await db.get(AgentSession, session_id)
        if session is not None:
            session.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(event)
        return event


async def replay_events(
    db: AsyncSession,
    *,
    session_id: str,
    after_seq: int = 0,
) -> list[AgentSessionEvent]:
    result = await db.execute(
        select(AgentSessionEvent)
        .where(AgentSessionEvent.session_id == session_id, AgentSessionEvent.seq > after_seq)
        .order_by(AgentSessionEvent.seq.asc())
    )
    return list(result.scalars().all())


async def discard_draft(
    db: AsyncSession,
    *,
    session_id: str,
    user_id: str,
) -> AgentSession:
    async with get_session_lock(session_id):
        session = await get_session_for_user(db, session_id=session_id, user_id=user_id)
        if session is None:
            raise ValueError("agent session not found")
        session.draft_snapshot_json = session.base_snapshot_json
        session.status = "stopped"
        session.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(session)
        return session


async def apply_draft_to_project(
    db: AsyncSession,
    *,
    session_id: str,
    user_id: str,
) -> tuple[AgentSession, ProjectSnapshotV2, Project | None]:
    async with get_session_lock(session_id):
        session = await get_session_for_user(db, session_id=session_id, user_id=user_id)
        if session is None:
            raise ValueError("agent session not found")

        draft = load_snapshot_json(session.draft_snapshot_json)
        project: Project | None = None
        if session.project_id:
            project = await db.get(Project, session.project_id)
            if project is None or project.user_id != user_id:
                raise ValueError("project not found")
            project.snapshot_json = session.draft_snapshot_json
            legacy = snapshot_v2_to_legacy(draft)
            project.board_type = legacy["board_type"]
            project.code = legacy["code"]
            project.components_json = legacy["components_json"]
            project.wires_json = legacy["wires_json"]
            project.updated_at = datetime.now(timezone.utc)

        session.base_snapshot_json = session.draft_snapshot_json
        session.status = "waiting_approval"
        session.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(session)
        if project is not None:
            await db.refresh(project)
        return session, draft, project
