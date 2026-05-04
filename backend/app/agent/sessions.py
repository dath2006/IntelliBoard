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


async def sync_canvas_to_session(
    db: AsyncSession,
    *,
    session_id: str,
    user_id: str,
    canvas_snapshot: ProjectSnapshotV2,
) -> AgentSession:
    """
    Merge the user's live canvas state into the session's base and draft snapshots.

    This is called whenever the user edits the canvas while an agent session is
    active, so the agent always works from the latest canvas state rather than
    the stale snapshot captured at session-creation time.

    Strategy: replace base_snapshot with the incoming canvas snapshot, then
    re-apply any agent-only changes (components/wires/files that exist in the
    draft but not in the base) on top of it.
    """
    async with get_session_lock(session_id):
        session = await get_session_for_user(db, session_id=session_id, user_id=user_id)
        if session is None:
            raise ValueError("agent session not found")

        old_base = load_snapshot_json(session.base_snapshot_json)
        old_draft = load_snapshot_json(session.draft_snapshot_json)

        # Compute agent-only additions: components/wires/fileGroup content that
        # the agent added to the draft but that weren't in the old base.
        old_base_component_ids = {c.id for c in old_base.components}
        old_base_wire_ids = {w.id for w in old_base.wires}

        agent_added_components = [
            c for c in old_draft.components if c.id not in old_base_component_ids
        ]
        agent_added_wires = [
            w for w in old_draft.wires if w.id not in old_base_wire_ids
        ]

        # Build new base from canvas snapshot.
        new_base = canvas_snapshot.model_copy(deep=True)
        session.base_snapshot_json = dump_snapshot_json(new_base)

        # Build new draft = canvas snapshot + agent additions on top.
        new_draft = canvas_snapshot.model_copy(deep=True)

        # Merge agent-added components (skip if id already present in canvas).
        canvas_component_ids = {c.id for c in new_draft.components}
        for comp in agent_added_components:
            if comp.id not in canvas_component_ids:
                new_draft.components.append(comp)

        # Merge agent-added wires (skip if id already present or endpoints missing).
        canvas_entity_ids = {b.id for b in new_draft.boards} | {c.id for c in new_draft.components}
        canvas_wire_ids = {w.id for w in new_draft.wires}
        for wire in agent_added_wires:
            if (
                wire.id not in canvas_wire_ids
                and wire.start.componentId in canvas_entity_ids
                and wire.end.componentId in canvas_entity_ids
            ):
                new_draft.wires.append(wire)

        # Merge agent file edits: for each group in the draft, if the agent
        # changed a file's content vs the old base, carry that change forward.
        for group_id, draft_files in old_draft.fileGroups.items():
            old_base_files = {f.name: f.content for f in old_base.fileGroups.get(group_id, [])}
            canvas_group = new_draft.fileGroups.get(group_id, [])
            canvas_by_name = {f.name: f for f in canvas_group}
            for df in draft_files:
                agent_changed = df.name not in old_base_files or df.content != old_base_files[df.name]
                if agent_changed and df.name in canvas_by_name:
                    # Only overwrite if the user hasn't also changed this file
                    # (canvas content == old base content means user didn't touch it).
                    canvas_content = canvas_by_name[df.name].content
                    old_base_content = old_base_files.get(df.name, "")
                    if canvas_content == old_base_content:
                        canvas_by_name[df.name] = canvas_by_name[df.name].model_copy(
                            update={"content": df.content}
                        )
            if group_id in new_draft.fileGroups:
                new_draft.fileGroups[group_id] = list(canvas_by_name.values())

        session.draft_snapshot_json = dump_snapshot_json(new_draft)
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
