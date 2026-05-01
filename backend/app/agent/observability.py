from __future__ import annotations

import logging
from typing import Any

from app.core.config import settings

_logger = logging.getLogger("app.agent")
_logfire_ready = False


def log_event(event: str, **fields: Any) -> None:
    if not _logger.isEnabledFor(logging.INFO):
        return
    payload = " ".join(f"{key}={value}" for key, value in fields.items())
    if payload:
        _logger.info("agent.%s %s", event, payload)
    else:
        _logger.info("agent.%s", event)


def init_logfire() -> None:
    global _logfire_ready
    if _logfire_ready or not settings.AGENT_ENABLE_LOGFIRE:
        return
    import logfire

    logfire.configure()
    logfire.instrument_pydantic_ai()
    logfire.instrument_httpx(capture_all=True)
    _logfire_ready = True
