from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
import time

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.schemas import ProjectSnapshotV2, RunState
from app.agent.sessions import append_event, set_session_status, update_draft_snapshot
from app.agent.safety import ensure_snapshot_size, ensure_time_budget, ensure_tool_budget


@dataclass
class AgentDeps:
    db: AsyncSession
    session_id: str
    user_id: str
    snapshot: ProjectSnapshotV2
    tool_calls: int = 0
    started_at: float = field(default_factory=time.monotonic)

    async def emit_event(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        await append_event(self.db, session_id=self.session_id, event_type=event_type, payload=payload or {})

    async def save_snapshot(self, snapshot: ProjectSnapshotV2, status: RunState | None = None) -> None:
        ensure_snapshot_size(snapshot)
        self.snapshot = snapshot
        await update_draft_snapshot(
            self.db,
            session_id=self.session_id,
            user_id=self.user_id,
            draft_snapshot=snapshot,
            status=status,
        )

    def guard_tool_call(self) -> None:
        self.tool_calls += 1
        ensure_tool_budget(self.tool_calls)
        ensure_time_budget(self.started_at)

    async def set_status(self, status: RunState) -> None:
        await set_session_status(
            self.db,
            session_id=self.session_id,
            user_id=self.user_id,
            status=status,
        )
