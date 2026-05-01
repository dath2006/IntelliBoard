from __future__ import annotations

import time

from app.agent.snapshot_compat import dump_snapshot_json
from app.core.config import settings


def ensure_prompt_size(message: str) -> None:
    if len(message) > settings.AGENT_MAX_PROMPT_CHARS:
        raise ValueError("prompt exceeds AGENT_MAX_PROMPT_CHARS")


def ensure_snapshot_size(snapshot) -> None:
    payload = dump_snapshot_json(snapshot)
    size = len(payload.encode("utf-8"))
    if size > settings.AGENT_SNAPSHOT_MAX_BYTES:
        raise ValueError("snapshot exceeds AGENT_SNAPSHOT_MAX_BYTES")


def ensure_tool_budget(tool_calls: int) -> None:
    if tool_calls > settings.AGENT_MAX_TOOL_CALLS:
        raise RuntimeError("tool call budget exceeded")


def ensure_time_budget(started_at: float) -> None:
    max_seconds = getattr(settings, "AGENT_MAX_RUN_SECONDS", 0)
    if max_seconds and (time.monotonic() - started_at) > max_seconds:
        raise RuntimeError("agent run time budget exceeded")


def ensure_safe_file_name(name: str) -> None:
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or ".." in normalized.split("/"):
        raise ValueError("file name must be relative and cannot contain traversal segments")
