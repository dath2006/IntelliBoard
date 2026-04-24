"""Agent API routes."""

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import ContextManager, agent_chat, get_velxio_agent
from app.agent.context import AgentMessage
from app.agent.session import create_session, delete_session, get_or_create_session
from app.core.config import settings
from app.core.dependencies import get_db, require_auth
from app.models.user import User

router = APIRouter(prefix="/api/agent", tags=["agent"])


# ============================================================================
# Chat Endpoint
# ============================================================================

@router.post("/chat")
async def chat_endpoint(
    payload: dict[str, Any],
    current_user: User = Depends(require_auth),
    db: AsyncSession = Depends(get_db)
) -> StreamingResponse:
    """
    Chat with agent.
    
    Request:
    {
        "session_id": "uuid" (optional, creates new if not provided),
        "project_id": "uuid" (required),
        "prompt": "user message",
        "include_serial_logs": false (optional),
        "serial_output": "..." (optional),
        "current_circuit": {...} (optional),
        "active_code": {...} (optional)
    }
    
    Response: SSE stream of events
    {type: "thinking"|"tool_call"|"response"|"done", content: "...", tool_call?: {...}, artifacts?: {...}}
    """
    project_id = payload.get("project_id")
    session_id = payload.get("session_id")
    prompt = payload.get("prompt")
    include_serial_logs = payload.get("include_serial_logs", False)
    serial_output = payload.get("serial_output")
    current_circuit = payload.get("current_circuit")
    active_code = payload.get("active_code")
    
    if not project_id or not prompt:
        raise HTTPException(status_code=400, detail="project_id and prompt required")
    
    # Get or create session
    if not session_id:
        session_id = await get_or_create_session(db, current_user.id, project_id)
        
    # Sync the exact frontend state if provided (solves "agent blindness" to default or manual circuits)
    context_mgr = ContextManager(db)
    if current_circuit is not None:
        await context_mgr.update_circuit_state(session_id, current_circuit)
    if active_code is not None:
        await context_mgr.update_code_state(session_id, active_code)
        
    await db.commit()  # Ensure the session is committed and visible to the background task
    
    api_key = payload.get("api_key") or settings.OPENAI_API_KEY
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="OpenAI API key is not configured. Set OPENAI_API_KEY or pass api_key in request.",
        )

    agent = await get_velxio_agent(api_key)

    def sse(event: dict[str, Any]) -> str:
        return f"data: {json.dumps(event)}\n\n"

    async def event_stream():
        yield sse({"type": "thinking", "content": "Analyzing request and project context..."})

        queue: asyncio.Queue[str] = asyncio.Queue()

        async def emit_event(event: dict[str, Any]) -> None:
            await queue.put(sse(event))

        task = asyncio.create_task(
            agent_chat(
                agent=agent,
                db_session=db,
                session_id=session_id,
                user_prompt=prompt,
                include_serial_logs=include_serial_logs,
                serial_output=serial_output,
                emit_event=emit_event,
            )
        )

        while not task.done() or not queue.empty():
            try:
                chunk = await asyncio.wait_for(queue.get(), timeout=0.15)
                yield chunk
            except TimeoutError:
                continue

        result = await task

        if result.get("error"):
            yield sse({"type": "error", "content": result["error"]})
        else:
            yield sse(
                {
                    "type": "response",
                    "content": result.get("response_text", ""),
                    "artifacts": result.get("artifacts") or None,
                }
            )

        await db.commit()
        yield sse({"type": "done", "content": {"session_id": session_id}})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ============================================================================
# Session Management Endpoints
# ============================================================================

@router.get("/sessions")
async def list_project_sessions(
    project_id: str,
    current_user: User = Depends(require_auth),
    db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    """List all agent sessions for a project."""
    context_mgr = ContextManager(db)
    sessions = await context_mgr.list_sessions_for_project(project_id, current_user.id)
    
    return {
        "project_id": project_id,
        "sessions": sessions,
        "total": len(sessions)
    }


@router.get("/sessions/{session_id}")
async def get_session_history(
    session_id: str,
    current_user: User = Depends(require_auth),
    db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    """Retrieve full conversation history for a session."""
    context_mgr = ContextManager(db)
    
    try:
        context = await context_mgr.load_session(session_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Verify ownership
    if context.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to view this session")
    
    # Serialize conversation history
    messages = [
        {
            "role": msg.role,
            "content": msg.content,
            "timestamp": msg.timestamp.isoformat(),
            "tool_calls": msg.tool_calls,
            "artifacts": msg.artifacts,
            "status": msg.status
        }
        for msg in context.conversation_history
    ]
    
    return {
        "session_id": session_id,
        "project_id": context.project_id,
        "created_at": context.conversation_history[0].timestamp.isoformat() if context.conversation_history else None,
        "conversation_messages": messages,
        "current_circuit_snapshot": context.current_circuit,
        "current_code_snapshot": context.active_code,
        "message_count": len(context.conversation_history)
    }


@router.post("/sessions/{session_id}/fork")
async def fork_session(
    session_id: str,
    payload: dict[str, Any] | None = None,
    current_user: User = Depends(require_auth),
    db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    """
    Fork a session into a new project.
    
    Request:
    {
        "new_project_id": "uuid" (optional, creates new project if not provided)
    }
    """
    context_mgr = ContextManager(db)
    
    try:
        context = await context_mgr.load_session(session_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Verify ownership
    if context.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    request_payload = payload or {}
    new_project_id = request_payload.get("new_project_id", context.project_id)
    
    # Create new session and clone state
    new_session_id = await create_session(db, current_user.id, new_project_id)

    for msg in context.conversation_history:
        await context_mgr.append_message(
            new_session_id,
            AgentMessage(
                role=msg.role,
                content=msg.content,
                timestamp=msg.timestamp,
                tool_calls=msg.tool_calls,
                artifacts=msg.artifacts,
                status=msg.status,
            ),
        )
    
    # Copy circuit and code state
    await context_mgr.update_circuit_state(new_session_id, context.current_circuit)
    await context_mgr.update_code_state(new_session_id, context.active_code)
    await db.commit()
    
    return {
        "new_session_id": new_session_id,
        "new_project_id": new_project_id,
        "forked_circuit": context.current_circuit,
        "forked_code": context.active_code
    }


@router.delete("/sessions/{session_id}")
async def delete_session_endpoint(
    session_id: str,
    payload: dict[str, Any] | None = None,
    current_user: User = Depends(require_auth),
    db: AsyncSession = Depends(get_db)
) -> dict[str, str]:
    """
    Delete a session.
    
    Request:
    {
        "confirm": true
    }
    """
    request_payload = payload or {}
    if not request_payload.get("confirm"):
        raise HTTPException(status_code=400, detail="Confirmation required")
    
    try:
        await delete_session(db, session_id, current_user.id)
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    
    return {"status": "deleted", "session_id": session_id}
