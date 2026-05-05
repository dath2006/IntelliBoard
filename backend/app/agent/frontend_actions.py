from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


@dataclass
class FrontendActionRequest:
    action_id: str
    session_id: str
    action: str
    payload: dict[str, Any]
    created_at: datetime
    future: asyncio.Future


@dataclass
class FrontendActionResult:
    action_id: str
    session_id: str
    ok: bool
    payload: dict[str, Any]
    error: str | None
    created_at: datetime


_PENDING_ACTIONS: dict[str, FrontendActionRequest] = {}


def create_frontend_action_request(
    *,
    session_id: str,
    action: str,
    payload: dict[str, Any] | None = None,
) -> FrontendActionRequest:
    action_id = uuid4().hex
    loop = asyncio.get_running_loop()
    future: asyncio.Future = loop.create_future()
    request = FrontendActionRequest(
        action_id=action_id,
        session_id=session_id,
        action=action,
        payload=payload or {},
        created_at=datetime.now(timezone.utc),
        future=future,
    )
    _PENDING_ACTIONS[action_id] = request
    return request


def resolve_frontend_action_result(
    *,
    session_id: str,
    action_id: str,
    ok: bool,
    payload: dict[str, Any] | None = None,
    error: str | None = None,
) -> bool:
    request = _PENDING_ACTIONS.get(action_id)
    if request is None or request.session_id != session_id:
        return False
    if request.future.done():
        return False
    result = FrontendActionResult(
        action_id=action_id,
        session_id=session_id,
        ok=ok,
        payload=payload or {},
        error=error,
        created_at=datetime.now(timezone.utc),
    )
    request.future.set_result(result)
    return True


async def wait_for_frontend_action_result(
    *,
    action_id: str,
    timeout_ms: int,
) -> FrontendActionResult:
    request = _PENDING_ACTIONS.get(action_id)
    if request is None:
        return FrontendActionResult(
            action_id=action_id,
            session_id="",
            ok=False,
            payload={},
            error="action_not_found",
            created_at=datetime.now(timezone.utc),
        )
    try:
        result = await asyncio.wait_for(request.future, timeout=timeout_ms / 1000.0)
        return result
    except asyncio.TimeoutError:
        return FrontendActionResult(
            action_id=action_id,
            session_id=request.session_id,
            ok=False,
            payload={},
            error="frontend_action_timeout",
            created_at=datetime.now(timezone.utc),
        )
    finally:
        _PENDING_ACTIONS.pop(action_id, None)
