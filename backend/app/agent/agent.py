from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import AsyncIterable
from typing import Any

from pydantic_ai import Agent, RunContext
from pydantic_ai.messages import (
    AgentStreamEvent,
    FinalResultEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
)

from app.agent import snapshot_ops
from app.agent import tools as agent_tools
from app.agent.deps import AgentDeps
from app.agent.observability import init_logfire, log_event
from app.agent.safety import ensure_prompt_size, ensure_snapshot_size
from app.agent.schemas import ProjectSnapshotV2, ToolResult
from app.agent.sessions import (
    append_event,
    get_session_for_user,
    load_draft_snapshot,
    replay_events,
    set_session_status,
)
from app.agent.validators import (
    validate_compile_readiness,
    validate_pin_mapping,
    validate_snapshot,
)
from app.core.config import settings
from app.database.session import AsyncSessionLocal

_RUN_TASKS: dict[str, asyncio.Task] = {}


def _truncate_text(value: str, limit: int = 1200) -> str:
    text = value.strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}... [truncated]"


async def _build_contextual_prompt(db, session_id: str, message: str) -> str:
    """Build a prompt containing recent in-session conversation turns.

    The agent framework starts a fresh model run each message, so we fold recent
    session chat history into the user prompt to preserve continuity.
    """
    events = await replay_events(db, session_id=session_id, after_seq=0)
    turns: list[tuple[str, str]] = []
    for event in events:
        payload = json.loads(event.payload_json or "{}")
        if event.event_type == "message.received":
            msg = str(payload.get("message", "")).strip()
            if msg:
                turns.append(("user", msg))
        elif event.event_type == "run.completed":
            out = str(payload.get("output", "")).strip()
            if out:
                turns.append(("assistant", out))

    # The latest message is also passed explicitly; remove duplicate tail user turn.
    if turns and turns[-1][0] == "user" and turns[-1][1] == message.strip():
        turns.pop()

    if not turns:
        return message

    recent = turns[-12:]
    lines = ["Conversation history (most recent turns):"]
    for role, text in recent:
        lines.append(f"{role.upper()}: {_truncate_text(text)}")
    lines.append("")
    lines.append("Latest user message:")
    lines.append(message.strip())
    return "\n".join(lines)


def build_agent(model_name: str | None = None, *, defer_model_check: bool = False) -> Agent[AgentDeps, str]:
    instructions = (
        "You are the Velxio backend agent. Use tools to inspect or mutate the draft snapshot. "
        "Never replace the full snapshot; use operation tools for changes. "
        "Prefer minimal edits and return concise status updates. "
        "When wiring components, ALWAYS call get_component_schema(metadataId) and use the returned pinNames EXACTLY "
        "(including casing and suffixes like .1). Do not invent pin names. "
        "Use pinDetails.role to understand intent: power/ground/common/signal. "
        "Connect power/ground/common rails first when required, then connect signal pins. "
        "If a component has pins like VCC/GND/COM (power/common), ensure they are connected to appropriate board rails "
        "when the circuit requires power, and explain your assumption (e.g. common-cathode vs common-anode) if applicable."
    )
    agent = Agent(
        model_name or settings.AGENT_MODEL,
        deps_type=AgentDeps,
        instructions=instructions,
        defer_model_check=defer_model_check,
    )

    async def _safe_tool_call(ctx: RunContext[AgentDeps], tool_name: str, fn) -> Any:
        try:
            result = fn()
            if inspect.isawaitable(result):
                result = await result
            return result
        except Exception as exc:
            error = str(exc)
            await ctx.deps.emit_event("tool.call.failed", {"tool": tool_name, "error": error})
            log_event("tool.call.failed", session_id=ctx.deps.session_id, tool=tool_name, error=error)
            return {"ok": False, "tool": tool_name, "error": error}

    @agent.tool
    async def get_project_outline(ctx: RunContext[AgentDeps]) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "get_project_outline", lambda: agent_tools.get_project_outline(ctx.deps.snapshot))

    @agent.tool
    async def get_component_detail(ctx: RunContext[AgentDeps], component_id: str) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx, "get_component_detail", lambda: agent_tools.get_component_detail(ctx.deps.snapshot, component_id)
        )

    @agent.tool
    async def search_component_catalog(
        ctx: RunContext[AgentDeps],
        query: str,
        category: str | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "search_component_catalog",
            lambda: agent_tools.search_component_catalog(query, category=category, limit=limit),
        )

    @agent.tool
    async def get_component_schema(ctx: RunContext[AgentDeps], component_id: str) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "get_component_schema", lambda: agent_tools.get_component_schema(component_id))

    @agent.tool
    async def list_component_schema_gaps(ctx: RunContext[AgentDeps], limit: int = 20) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx, "list_component_schema_gaps", lambda: agent_tools.list_component_schema_gaps(limit=limit)
        )

    @agent.tool
    async def list_files(ctx: RunContext[AgentDeps], group_id: str | None = None) -> list[dict[str, Any]]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "list_files", lambda: agent_tools.list_files(ctx.deps.snapshot, group_id=group_id))

    @agent.tool
    async def read_file(
        ctx: RunContext[AgentDeps],
        group_id: str,
        file_name: str,
        start_line: int | None = None,
        end_line: int | None = None,
    ) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "read_file",
            lambda: agent_tools.read_file(
                ctx.deps.snapshot,
                group_id=group_id,
                file_name=file_name,
                start_line=start_line,
                end_line=end_line,
            ),
        )

    @agent.tool
    async def add_board(
        ctx: RunContext[AgentDeps],
        board_kind: str,
        board_id: str | None = None,
        x: float = 50.0,
        y: float = 50.0,
    ) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "add_board",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.add_board(
                    ctx.deps.snapshot,
                    board_kind=board_kind,
                    board_id=board_id,
                    x=x,
                    y=y,
                ),
                tool_name="add_board",
            ),
        )

    @agent.tool
    async def change_board_kind(
        ctx: RunContext[AgentDeps],
        board_id: str,
        board_kind: str,
    ) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "change_board_kind",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.change_board_kind(
                    ctx.deps.snapshot,
                    board_id=board_id,
                    board_kind=board_kind,
                ),
                tool_name="change_board_kind",
            ),
        )

    @agent.tool
    async def remove_board(ctx: RunContext[AgentDeps], board_id: str) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "remove_board",
            lambda: _apply_mutation(ctx, *snapshot_ops.remove_board(ctx.deps.snapshot, board_id=board_id), tool_name="remove_board"),
        )

    @agent.tool
    async def add_component(
        ctx: RunContext[AgentDeps],
        component_id: str,
        metadata_id: str,
        x: float,
        y: float,
        properties: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "add_component",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.add_component(
                    ctx.deps.snapshot,
                    component_id=component_id,
                    metadata_id=metadata_id,
                    x=x,
                    y=y,
                    properties=properties,
                ),
                tool_name="add_component",
            ),
        )

    @agent.tool
    async def update_component(
        ctx: RunContext[AgentDeps],
        component_id: str,
        x: float | None = None,
        y: float | None = None,
        properties: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "update_component",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.update_component(
                    ctx.deps.snapshot,
                    component_id=component_id,
                    x=x,
                    y=y,
                    properties=properties,
                ),
                tool_name="update_component",
            ),
        )

    @agent.tool
    async def move_component(ctx: RunContext[AgentDeps], component_id: str, x: float, y: float) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "move_component",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.move_component(
                    ctx.deps.snapshot,
                    component_id=component_id,
                    x=x,
                    y=y,
                ),
                tool_name="move_component",
            ),
        )

    @agent.tool
    async def remove_component(ctx: RunContext[AgentDeps], component_id: str) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "remove_component",
            lambda: _apply_mutation(
                ctx, *snapshot_ops.remove_component(ctx.deps.snapshot, component_id=component_id), tool_name="remove_component"
            ),
        )

    @agent.tool
    async def connect_pins(
        ctx: RunContext[AgentDeps],
        wire_id: str | None,
        start_component_id: str,
        start_pin: str,
        end_component_id: str,
        end_pin: str,
        color: str = "#22c55e",
        signal_type: str | None = None,
    ) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        wire_id = wire_id or _unique_id("wire", {w.id for w in ctx.deps.snapshot.wires})
        return await _safe_tool_call(
            ctx,
            "connect_pins",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.connect_pins(
                    ctx.deps.snapshot,
                    wire_id=wire_id,
                    start_component_id=start_component_id,
                    start_pin=start_pin,
                    end_component_id=end_component_id,
                    end_pin=end_pin,
                    color=color,
                    signal_type=signal_type,
                ),
                tool_name="connect_pins",
            ),
        )

    @agent.tool
    async def disconnect_wire(ctx: RunContext[AgentDeps], wire_id: str) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "disconnect_wire",
            lambda: _apply_mutation(ctx, *snapshot_ops.disconnect_wire(ctx.deps.snapshot, wire_id=wire_id), tool_name="disconnect_wire"),
        )

    @agent.tool
    async def route_wire(
        ctx: RunContext[AgentDeps],
        wire_id: str,
        waypoints: list[dict[str, float]],
    ) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "route_wire",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.route_wire(
                    ctx.deps.snapshot,
                    wire_id=wire_id,
                    waypoints=waypoints,
                ),
                tool_name="route_wire",
            ),
        )

    @agent.tool
    async def create_file(
        ctx: RunContext[AgentDeps],
        group_id: str,
        name: str,
        content: str = "",
    ) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "create_file",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.create_file(
                    ctx.deps.snapshot,
                    group_id=group_id,
                    name=name,
                    content=content,
                ),
                tool_name="create_file",
            ),
        )

    @agent.tool
    async def replace_file_range(
        ctx: RunContext[AgentDeps],
        group_id: str,
        file_name: str,
        start_line: int,
        end_line: int,
        replacement: str,
    ) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "replace_file_range",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.replace_file_range(
                    ctx.deps.snapshot,
                    group_id=group_id,
                    file_name=file_name,
                    start_line=start_line,
                    end_line=end_line,
                    replacement=replacement,
                ),
                tool_name="replace_file_range",
            ),
        )

    @agent.tool
    async def apply_file_patch(
        ctx: RunContext[AgentDeps],
        group_id: str,
        file_name: str,
        original: str,
        modified: str,
    ) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "apply_file_patch",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.apply_file_patch(
                    ctx.deps.snapshot,
                    group_id=group_id,
                    file_name=file_name,
                    original=original,
                    modified=modified,
                ),
                tool_name="apply_file_patch",
            ),
        )

    @agent.tool
    async def compile_board(ctx: RunContext[AgentDeps], board_id: str) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "compile_board", lambda: agent_tools.compile_board(ctx.deps.snapshot, board_id=board_id))

    @agent.tool
    async def search_libraries(ctx: RunContext[AgentDeps], query: str) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "search_libraries", lambda: agent_tools.search_libraries(query))

    @agent.tool
    async def install_library(ctx: RunContext[AgentDeps], name: str) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "install_library", lambda: agent_tools.install_library(name))

    @agent.tool
    async def list_installed_libraries(ctx: RunContext[AgentDeps]) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "list_installed_libraries", lambda: agent_tools.list_installed_libraries())

    @agent.tool
    async def validate_snapshot_state(ctx: RunContext[AgentDeps]) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "validate_snapshot_state", lambda: validate_snapshot(ctx.deps.snapshot).model_dump())

    @agent.tool
    async def validate_pin_mapping_state(ctx: RunContext[AgentDeps]) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx, "validate_pin_mapping_state", lambda: validate_pin_mapping(ctx.deps.snapshot).model_dump()
        )

    @agent.tool
    async def validate_compile_readiness_state(ctx: RunContext[AgentDeps], board_id: str) -> dict[str, Any]:
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx, "validate_compile_readiness_state", lambda: validate_compile_readiness(ctx.deps.snapshot, board_id=board_id).model_dump()
        )

    return agent


async def run_agent_session(
    session_id: str,
    user_id: str,
    message: str,
    *,
    model_override: Any | None = None,
    session_factory=AsyncSessionLocal,
) -> str:
    if not settings.AGENT_ENABLED:
        raise RuntimeError("Agent is disabled.")
    settings.require_agent_ready()
    init_logfire()

    async with session_factory() as db:
        session = await get_session_for_user(db, session_id=session_id, user_id=user_id)
        if session is None:
            raise ValueError("agent session not found")

        try:
            contextual_prompt = await _build_contextual_prompt(db, session_id, message)
            ensure_prompt_size(contextual_prompt)
        except Exception as exc:
            await append_event(
                db,
                session_id=session_id,
                event_type="run.failed",
                payload={"error": str(exc)},
            )
            await set_session_status(db, session_id=session_id, user_id=user_id, status="failed")
            log_event("run.failed", session_id=session_id, error=str(exc))
            raise

        snapshot = await load_draft_snapshot(db, session_id=session_id, user_id=user_id)
        try:
            ensure_snapshot_size(snapshot)
        except Exception as exc:
            await append_event(
                db,
                session_id=session_id,
                event_type="run.failed",
                payload={"error": str(exc)},
            )
            await set_session_status(db, session_id=session_id, user_id=user_id, status="failed")
            log_event("run.failed", session_id=session_id, error=str(exc))
            raise
        deps = AgentDeps(db=db, session_id=session_id, user_id=user_id, snapshot=snapshot)
        await set_session_status(db, session_id=session_id, user_id=user_id, status="running")
        await append_event(
            db,
            session_id=session_id,
            event_type="run.started",
            payload={"message": message},
        )
        log_event("run.started", session_id=session_id)

        agent = build_agent(session.model_name, defer_model_check=model_override is not None)
        try:
            if model_override is not None:
                with agent.override(model=model_override):
                    result = await agent.run(
                        contextual_prompt,
                        deps=deps,
                        event_stream_handler=_event_stream_handler,
                    )
            else:
                result = await agent.run(
                    contextual_prompt,
                    deps=deps,
                    event_stream_handler=_event_stream_handler,
                )
        except asyncio.CancelledError:
            await append_event(db, session_id=session_id, event_type="run.cancelled", payload={})
            await set_session_status(db, session_id=session_id, user_id=user_id, status="stopped")
            log_event("run.cancelled", session_id=session_id)
            raise
        except Exception as exc:  # pragma: no cover - error path exercised in integration tests
            await append_event(
                db,
                session_id=session_id,
                event_type="run.failed",
                payload={"error": str(exc)},
            )
            await set_session_status(db, session_id=session_id, user_id=user_id, status="failed")
            log_event("run.failed", session_id=session_id, error=str(exc))
            raise
        else:
            await append_event(
                db,
                session_id=session_id,
                event_type="run.completed",
                payload={"output": result.output},
            )
            await set_session_status(db, session_id=session_id, user_id=user_id, status="completed")
            log_event("run.completed", session_id=session_id)
            return result.output
        finally:
            _RUN_TASKS.pop(session_id, None)


def start_agent_run(session_id: str, user_id: str, message: str) -> bool:
    existing = _RUN_TASKS.get(session_id)
    if existing is not None and not existing.done():
        return False
    _RUN_TASKS[session_id] = asyncio.create_task(run_agent_session(session_id, user_id, message))
    return True


def cancel_agent_run(session_id: str) -> bool:
    task = _RUN_TASKS.get(session_id)
    if task is None or task.done():
        return False
    task.cancel()
    return True


async def _apply_mutation(
    ctx: RunContext[AgentDeps],
    updated: ProjectSnapshotV2,
    result: ToolResult,
    *,
    tool_name: str,
) -> dict[str, Any]:
    await ctx.deps.save_snapshot(updated)
    await ctx.deps.emit_event(
        "snapshot.updated",
        {"tool": tool_name, **result.model_dump()},
    )
    return result.model_dump()


def _unique_id(base: str, existing: set[str]) -> str:
    if base not in existing:
        return base
    index = 2
    while f"{base}-{index}" in existing:
        index += 1
    return f"{base}-{index}"


async def _event_stream_handler(ctx: RunContext[AgentDeps], events: AsyncIterable[AgentStreamEvent]) -> None:
    async for event in events:
        if isinstance(event, FunctionToolCallEvent):
            await ctx.deps.emit_event(
                "tool.call.started",
                {"tool": event.part.tool_name, "toolCallId": event.tool_call_id},
            )
            log_event("tool.call.started", session_id=ctx.deps.session_id, tool=event.part.tool_name)
        elif isinstance(event, FunctionToolResultEvent):
            tool_name = getattr(event.result, "tool_name", None)
            await ctx.deps.emit_event(
                "tool.call.result",
                {"tool": tool_name, "toolCallId": event.tool_call_id},
            )
            log_event("tool.call.result", session_id=ctx.deps.session_id, tool=tool_name)
        elif isinstance(event, PartStartEvent) and isinstance(event.part, TextPart):
            if event.part.content:
                await ctx.deps.emit_event(
                    "model.output.delta",
                    {"delta": event.part.content},
                )
        elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
            if event.delta.content_delta:
                await ctx.deps.emit_event(
                    "model.output.delta",
                    {"delta": event.delta.content_delta},
                )
        elif isinstance(event, FinalResultEvent):
            await ctx.deps.emit_event(
                "model.output.final",
                {"toolName": event.tool_name, "toolCallId": event.tool_call_id},
            )
