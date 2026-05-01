from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.agent import cancel_agent_run, start_agent_run
from app.agent.schemas import (
    AgentSessionCreateRequest,
    AgentSessionEventResponse,
    AgentSessionMessageRequest,
    PinCatalogObservationRequest,
    AgentSessionResponse,
)
from app.agent.sessions import (
    append_event,
    apply_draft_to_project,
    create_session,
    discard_draft,
    get_session_for_user,
    list_sessions,
    load_draft_snapshot,
    replay_events,
    set_session_status,
)
from app.agent.runtime_pin_catalog import record_pin_observation
from app.agent.snapshot_compat import legacy_to_snapshot_v2, load_snapshot_json
from app.core.config import settings
from app.core.dependencies import require_auth
from app.database.session import get_db
from app.models.project import Project
from app.models.user import User
from app.services.project_files import read_files

router = APIRouter()


@router.post("/sessions", response_model=AgentSessionResponse, status_code=status.HTTP_201_CREATED)
async def create_agent_session(
    body: AgentSessionCreateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    if body.snapshotJson:
        snapshot = load_snapshot_json(body.snapshotJson)
        project_id = body.projectId
    elif body.projectId:
        project = await _owned_project(db, body.projectId, user.id)
        snapshot = _snapshot_from_project(project)
        project_id = project.id
    else:
        raise HTTPException(status_code=422, detail="Provide projectId or snapshotJson.")

    session = await create_session(
        db,
        user_id=user.id,
        project_id=project_id,
        base_snapshot=snapshot,
        model_name=body.modelName,
    )
    await append_event(db, session_id=session.id, event_type="session.created", payload={})
    return _session_response(session)


@router.get("/sessions", response_model=list[AgentSessionResponse])
async def list_agent_sessions(
    project_id: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    if project_id is not None:
        await _owned_project(db, project_id, user.id)
    sessions = await list_sessions(db, user_id=user.id, project_id=project_id)
    return [_session_response(session) for session in sessions]


@router.post("/sessions/{session_id}/messages", response_model=AgentSessionResponse)
async def post_agent_message(
    session_id: str,
    body: AgentSessionMessageRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    session = await get_session_for_user(db, session_id=session_id, user_id=user.id)
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found.")
    await append_event(
        db,
        session_id=session.id,
        event_type="message.received",
        payload={"message": body.message},
    )
    updated = await set_session_status(
        db,
        session_id=session.id,
        user_id=user.id,
        status="queued",
    )
    if settings.AGENT_ENABLED:
        start_agent_run(session.id, user.id, body.message)
    return _session_response(updated)


@router.post("/pin-observations")
async def post_pin_observation(
    body: PinCatalogObservationRequest,
    user: User = Depends(require_auth),
):
    _ = user
    record_pin_observation(
        metadata_id=body.metadataId,
        tag_name=body.tagName,
        pin_names=body.pinNames,
        signature=body.propertySignature,
    )
    return {"ok": True}


@router.get("/sessions/{session_id}/snapshot")
async def get_agent_session_snapshot(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    session = await get_session_for_user(db, session_id=session_id, user_id=user.id)
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found.")
    snapshot = await load_draft_snapshot(db, session_id=session.id, user_id=user.id)
    return snapshot.model_dump(mode="json")


@router.get("/sessions/{session_id}/events")
async def stream_agent_events(
    session_id: str,
    request: Request,
    after: int = Query(default=0, ge=0),
    stream: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    session = await get_session_for_user(db, session_id=session_id, user_id=user.id)
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found.")

    if not stream:
        events = await replay_events(db, session_id=session_id, after_seq=after)
        return [_event_response(event) for event in events]

    async def event_stream() -> AsyncIterator[str]:
        last_seq = after

        while True:
            if await request.is_disconnected():
                break
            events = await replay_events(db, session_id=session_id, after_seq=last_seq)
            if events:
                for event in events:
                    payload = _event_response(event).model_dump(mode="json")
                    yield f"id: {event.seq}\nevent: {event.event_type}\ndata: {json.dumps(payload)}\n\n"
                last_seq = events[-1].seq
            await asyncio.sleep(0.5)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/sessions/{session_id}/apply", response_model=AgentSessionResponse)
async def apply_agent_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    try:
        session, _draft, _project = await apply_draft_to_project(
            db,
            session_id=session_id,
            user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await append_event(db, session_id=session.id, event_type="session.applied", payload={})
    return _session_response(session)


@router.post("/sessions/{session_id}/discard", response_model=AgentSessionResponse)
async def discard_agent_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    try:
        session = await discard_draft(db, session_id=session_id, user_id=user.id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await append_event(db, session_id=session.id, event_type="session.discarded", payload={})
    return _session_response(session)


@router.post("/sessions/{session_id}/stop", response_model=AgentSessionResponse)
async def stop_agent_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    try:
        session = await set_session_status(
            db,
            session_id=session_id,
            user_id=user.id,
            status="stopped",
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    cancel_agent_run(session.id)
    await append_event(db, session_id=session.id, event_type="session.stopped", payload={})
    return _session_response(session)


async def _owned_project(db: AsyncSession, project_id: str, user_id: str) -> Project:
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    if project.user_id != user_id:
        raise HTTPException(status_code=403, detail="Forbidden.")
    return project


def _snapshot_from_project(project: Project):
    if project.snapshot_json:
        return load_snapshot_json(project.snapshot_json)
    disk_files = read_files(project.id)
    return legacy_to_snapshot_v2(
        board_type=project.board_type,
        files=disk_files,
        code=project.code,
        components_json=project.components_json,
        wires_json=project.wires_json,
    )


def _session_response(session) -> AgentSessionResponse:
    return AgentSessionResponse(
        id=session.id,
        projectId=session.project_id,
        status=session.status,
        modelName=session.model_name,
        createdAt=session.created_at,
        updatedAt=session.updated_at,
    )


def _event_response(event) -> AgentSessionEventResponse:
    return AgentSessionEventResponse(
        id=event.id,
        sessionId=event.session_id,
        seq=event.seq,
        eventType=event.event_type,
        payload=json.loads(event.payload_json or "{}"),
        createdAt=event.created_at,
    )
