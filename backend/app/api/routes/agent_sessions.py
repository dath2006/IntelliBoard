from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import nullcontext
from typing import Any

try:
    import logfire  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    logfire = None

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
try:
    from pydantic_ai.ui.ag_ui import AGUIApp  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover
    AGUIApp = None  # type: ignore[assignment]
from pydantic_ai.ui.ag_ui import AGUIAdapter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.agent import build_agent, cancel_agent_run, start_agent_run
from app.agent.deps import AgentDeps
from app.agent.schemas import (
    AgentUiState,
    AgentSessionCreateRequest,
    AgentSessionEventResponse,
    AgentSessionMessageRequest,
    FrontendActionResultRequest,
    PinCatalogObservationRequest,
    AgentSessionResponse,
)
from app.agent.frontend_actions import resolve_frontend_action_result
from app.agent.sessions import (
    append_event,
    apply_draft_to_project,
    create_session,
    delete_session,
    discard_draft,
    get_session_for_user,
    list_sessions,
    load_draft_snapshot,
    replay_events,
    set_session_status,
    sync_canvas_to_session,
)
from app.agent.runtime_pin_catalog import record_pin_observation
from app.agent.snapshot_compat import legacy_to_snapshot_v2, load_snapshot_json
from app.core.config import settings
from app.core.dependencies import require_auth
from app.database.session import AsyncSessionLocal, get_db
from app.models.project import Project
from app.models.user import User
from app.services.llm_providers import resolve_pydantic_ai_model
from app.services.project_files import read_files

router = APIRouter()


def _looks_like_agent_ui_state(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    keys = {
        "projectId",
        "sessionId",
        "activeBoardId",
        "activeGroupId",
        "activeFileId",
        "activeFileName",
        "selectedWireId",
    }
    return any(k in value for k in keys)


def _extract_state_payload(payload: dict[str, Any]) -> dict[str, Any]:
    candidates: list[Any] = [
        payload.get("state"),
        payload.get("input", {}).get("state") if isinstance(payload.get("input"), dict) else None,
        payload.get("context", {}).get("state") if isinstance(payload.get("context"), dict) else None,
    ]

    messages = payload.get("messages")
    if isinstance(messages, list):
        for message in reversed(messages):
            if not isinstance(message, dict):
                continue
            for key in ("state", "metadata", "meta", "annotations", "context"):
                candidate = message.get(key)
                if isinstance(candidate, dict) and "state" in candidate:
                    candidates.append(candidate.get("state"))
                else:
                    candidates.append(candidate)

    for candidate in candidates:
        if _looks_like_agent_ui_state(candidate):
            return candidate
    return {}


def _extract_requested_model(
    request: Request,
    payload: dict[str, Any],
    extracted_state: dict[str, Any],
) -> str | None:
    for key in ("modelName", "model"):
        raw = request.query_params.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()

    for key in ("modelName", "model"):
        raw = payload.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()

    for key in ("modelName", "model"):
        raw = extracted_state.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()

    configurable = payload.get("configurable")
    if isinstance(configurable, dict):
        raw = configurable.get("model")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


async def _finalize_ag_ui_run(
    *,
    session_id: str,
    user_id: str,
    status_value: str,
    output: str,
) -> None:
    async with AsyncSessionLocal() as db_bg:
        await set_session_status(
            db_bg,
            session_id=session_id,
            user_id=user_id,
            status=status_value,
        )
        await append_event(
            db_bg,
            session_id=session_id,
            event_type="run.completed" if status_value == "completed" else "run.failed",
            payload={"output": output},
        )


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


@router.post("/sessions/{session_id}/actions/{action_id}")
async def post_frontend_action_result(
    session_id: str,
    action_id: str,
    body: FrontendActionResultRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    session = await get_session_for_user(db, session_id=session_id, user_id=user.id)
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found.")

    resolved = resolve_frontend_action_result(
        session_id=session_id,
        action_id=action_id,
        ok=body.ok,
        payload=body.payload,
        error=body.error,
    )
    if not resolved:
        raise HTTPException(status_code=404, detail="Action request not found.")

    await append_event(
        db,
        session_id=session_id,
        event_type="frontend.action.result",
        payload={
            "actionId": action_id,
            "action": body.action,
            "ok": body.ok,
            "payload": body.payload,
            "error": body.error,
        },
    )
    return {"ok": True}


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


@router.api_route("/ag-ui", methods=["POST", "PUT"])
async def run_ag_ui_agent(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    raw_body = await request.body()
    try:
        payload = json.loads(raw_body.decode("utf-8")) if raw_body else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid AG-UI payload: {exc}") from exc

    extracted_state = _extract_state_payload(payload)
    query_session_id = request.query_params.get("sessionId")
    payload_session_id = payload.get("sessionId")
    if isinstance(query_session_id, str) and query_session_id.strip():
        extracted_state = {**extracted_state, "sessionId": query_session_id.strip()}
    elif isinstance(payload_session_id, str) and payload_session_id.strip():
        extracted_state = {**extracted_state, "sessionId": payload_session_id.strip()}

    try:
        state = AgentUiState.model_validate(extracted_state)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid AG-UI state: {exc}") from exc

    if not state.sessionId:
        raise HTTPException(status_code=422, detail="state.sessionId is required.")

    session = await get_session_for_user(db, session_id=state.sessionId, user_id=user.id)
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found.")

    snapshot = await load_draft_snapshot(db, session_id=session.id, user_id=user.id)
    deps = AgentDeps(
        db=db,
        session_id=session.id,
        user_id=user.id,
        snapshot=snapshot,
        state=state,
    )

    requested_model_name = _extract_requested_model(request, payload, extracted_state)

    model_id = requested_model_name.strip() if isinstance(requested_model_name, str) and requested_model_name.strip() else session.model_name

    resolved_model = model_id
    model_override = None
    try:
        if model_id:
            resolved_model = await resolve_pydantic_ai_model(db, user.id, model_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Model resolution failed: {exc}") from exc

    if isinstance(resolved_model, str):
        agent = build_agent(resolved_model)
    else:
        agent = build_agent(resolved_model, defer_model_check=True)

    latest_msg = "AG-UI Request"
    messages = payload.get("messages")
    if isinstance(messages, list):
        for m in reversed(messages):
            if not isinstance(m, dict):
                continue
            if m.get("role") == "user" and m.get("content"):
                content = m.get("content")
                if isinstance(content, list):
                    parts: list[str] = []
                    for c in content:
                        if isinstance(c, dict) and c.get("text"):
                            parts.append(str(c["text"]))
                    if parts:
                        latest_msg = " ".join(parts)
                else:
                    latest_msg = str(content)
                break

    await set_session_status(db, session_id=session.id, user_id=user.id, status="running")
    await append_event(
        db,
        session_id=session.id,
        event_type="run.started",
        payload={"message": latest_msg, "modelName": model_id},
    )

    dispatch_span = (
        logfire.span(
            "ag_ui.dispatch_request",
            session_id=session.id,
            user_id=user.id,
            latest_msg=latest_msg,
        )
        if logfire is not None
        else nullcontext()
    )
    with dispatch_span:
        response = None
        if AGUIApp is not None:
            adapter_model_arg_supported = True
            try:
                if model_override is not None:
                    adapter = AGUIApp(agent, deps=deps, model=model_override)
                else:
                    adapter = AGUIApp(agent, deps=deps)
            except TypeError:
                adapter_model_arg_supported = False
                adapter = AGUIApp(agent, deps=deps)

            model_override_ctx = nullcontext()
            if (
                model_override is not None
                and not adapter_model_arg_supported
                and hasattr(agent, "override")
            ):
                model_override_ctx = agent.override(model=model_override)

            with model_override_ctx:
                response = await adapter.handle(request)
        else:
            # pydantic-ai versions exposing AG-UI through AGUIAdapter.
            dispatch_kwargs = {
                "agent": agent,
                "deps": deps,
                "manage_system_prompt": "server",
            }
            if model_override is not None:
                dispatch_kwargs["model"] = model_override
            response = await AGUIAdapter.dispatch_request(request, **dispatch_kwargs)

    if isinstance(response, StreamingResponse):
        original_iterator = response.body_iterator

        async def wrapped_iterator():
            failed = False
            try:
                async for chunk in original_iterator:
                    yield chunk
            except Exception as exc:
                failed = True
                await _finalize_ag_ui_run(
                    session_id=session.id,
                    user_id=user.id,
                    status_value="failed",
                    output=f"AG-UI stream failed: {exc}",
                )
                raise
            finally:
                if not failed:
                    await _finalize_ag_ui_run(
                        session_id=session.id,
                        user_id=user.id,
                        status_value="completed",
                        output="AG-UI run completed",
                    )

        response.body_iterator = wrapped_iterator()
    else:
        await _finalize_ag_ui_run(
            session_id=session.id,
            user_id=user.id,
            status_value="completed",
            output="AG-UI run completed",
        )
    return response


@router.patch("/sessions/{session_id}/canvas", response_model=AgentSessionResponse)
async def sync_canvas_snapshot(
    session_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    """
    Sync the user's current canvas state into the agent session's base and draft
    snapshots. Call this whenever the user edits the canvas while a session is
    active so the agent always works from the latest state.

    Expects the raw snapshot JSON as the request body (application/json).
    """
    body = await request.json()
    try:
        canvas_snapshot = load_snapshot_json(json.dumps(body))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid snapshot: {exc}") from exc

    try:
        session = await sync_canvas_to_session(
            db,
            session_id=session_id,
            user_id=user.id,
            canvas_snapshot=canvas_snapshot,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return _session_response(session)


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


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    try:
        await delete_session(db, session_id=session_id, user_id=user.id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
