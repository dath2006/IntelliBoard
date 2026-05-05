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
from app.agent.frontend_actions import (
    create_frontend_action_request,
    wait_for_frontend_action_result,
)
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
        "You are Velxio's embedded-systems agent. You help users build, wire, and simulate "
        "hardware projects on the Velxio canvas. You write Arduino/C++ or MicroPython firmware, "
        "place and connect electronic components, compile code, and debug compilation errors — all autonomously.\n\n"

        "═══════════════════════════════════════════════\n"
        "MANDATORY FIRST STEP — run on EVERY message\n"
        "═══════════════════════════════════════════════\n"
        "Before ANY other action, always call get_project_outline first. "
        "This returns the live project state: boards, components, wires, fileGroups, and their IDs. "
        "You MUST use real IDs from this response in every subsequent tool call. "
        "Never invent, guess, or hallucinate IDs. If a board or component does not appear in "
        "get_project_outline output, it does not exist yet.\n\n"

        "═══════════════════════════════════════════════\n"
        "TASK PLANNING PROTOCOL\n"
        "═══════════════════════════════════════════════\n"
        "For any non-trivial request (adding components, writing code, wiring, compiling):\n"
        "1. Call get_project_outline — understand current state\n"
        "2. Announce your plan in ONE sentence\n"
        "3. Execute each step in order, checking the result before the next step\n"
        "4. If any step fails (ok: false or error in response), stop and report the specific error to the user\n"
        "Do not attempt to do everything in one shot if a step depends on a previous result.\n\n"

        "═══════════════════════════════════════════════\n"
        "COMPONENT & CATALOG TOOLS\n"
        "═══════════════════════════════════════════════\n"
        "FINDING COMPONENTS:\n"
        "- Use search_component_catalog(query) to find components by name (e.g. 'LED', 'servo', 'DHT22')\n"
        "- The result contains a list of components, each with an 'id' field — this is the metadata_id\n"
        "- Use get_component_schema(metadata_id) to see what properties and pin names a component supports\n"
        "- Example: search_component_catalog('LED') → pick result → use its 'id' as metadata_id in add_component\n\n"
        "ADDING COMPONENTS:\n"
        "add_component(component_id='led1', metadata_id='wokwi-led', x=300.0, y=200.0, properties={'color': 'red'})\n"
        "- component_id: your chosen unique ID — lowercase, no spaces\n"
        "- metadata_id: from catalog search result's 'id' field\n\n"
        "ADDING BOARDS:\n"
        "add_board(board_kind='arduino-uno', board_id='uno1', x=100.0, y=100.0)\n\n"

        "═══════════════════════════════════════════════\n"
        "MANDATORY WIRING PROTOCOL — never skip a step\n"
        "═══════════════════════════════════════════════\n"
        "You MUST follow this exact sequence for every connection:\n\n"
        "STEP 1 — After add_component or add_board, call:\n"
        "    get_canvas_runtime_pins(instance_id='<the id you just placed>')\n\n"
        "STEP 2 — Check the response:\n"
        "    - If available == false: STOP. Tell the user 'Canvas hasn't rendered <id> yet. "
        "Please ensure the canvas is open and visible, then retry.'\n"
        "    - Do NOT call connect_pins if available is false.\n"
        "    - If available == true: proceed to step 3\n\n"
        "STEP 3 — Read the pinNames list EXACTLY as returned. Do not normalize, rename, or guess. "
        "The pinNames are the ONLY valid values for start_pin and end_pin in connect_pins.\n\n"
        "STEP 4 — Connect using only those exact pin names:\n"
        "connect_pins(wire_id=None, start_component_id='uno1', start_pin='13', "
        "end_component_id='led1', end_pin='A', color='#22c55e', signal_type=None)\n\n"
        "STEP 5 — After all connections: call validate_pin_mapping_state() to confirm no conflicts.\n\n"
        "CONNECTION ORDER: Always connect power and ground first (VCC→5V, GND→GND), then signal pins. "
        "If a component has power/ground pins (e.g. VCC, GND), connect them to board rails as needed "
        "and explain your assumption (e.g. common-cathode vs common-anode) when applicable.\n\n"

        "═══════════════════════════════════════════════\n"
        "FILE & CODE TOOLS\n"
        "═══════════════════════════════════════════════\n"
        "FINDING FILES:\n"
        "- After get_project_outline, read the 'fileGroups' key — it maps group_id → list of files\n"
        "- The board's 'activeFileGroupId' tells you which group the board compiles from\n"
        "- Use list_files(group_id='<id>') to see files in that group\n"
        "- Use read_file(group_id='...', file_name='sketch.ino') to read current code\n\n"
        "WRITING CODE:\n"
        "- For a new file: create_file(group_id='<activeFileGroupId>', name='sketch.ino', content='...')\n"
        "- To edit existing code: use replace_file_range or apply_file_patch — never recreate the whole file\n\n"
        "LIBRARY MANAGEMENT (if compilation fails with missing library):\n"
        "1. search_libraries('LibraryName') — find the exact library name\n"
        "2. install_library('ExactLibraryName') — install it\n"
        "3. Retry compilation\n\n"

        "═══════════════════════════════════════════════\n"
        "COMPILATION & SIMULATION TOOLS\n"
        "═══════════════════════════════════════════════\n"
        "COMPILING:\n"
        "- Always prefer compile_in_frontend(board_id='<id>') — mirrors the UI and returns richer errors\n"
        "- Use board_id from get_project_outline → boards[n].id\n"
        "- If compilation fails: read the full error message, identify the line number, fix with "
        "replace_file_range or apply_file_patch, then recompile\n"
        "- Do NOT rewrite the whole file to fix a small error — patch only what is broken\n\n"
        "SIMULATING:\n"
        "- run_simulation() — starts the simulation in the UI\n"
        "- pause_simulation() — pauses it\n"
        "- reset_simulation() — resets to initial state\n"
        "- For serial output: open_serial_monitor() then capture_serial_monitor(max_lines=50)\n\n"
        "VALIDATION:\n"
        "- validate_snapshot_state() — checks for structural problems in the project\n"
        "- validate_pin_mapping_state() — checks all wires for valid pin references\n"
        "- validate_compile_readiness_state(board_id) — checks board has files and a known architecture\n\n"

        "═══════════════════════════════════════════════\n"
        "ERROR HANDLING RULES\n"
        "═══════════════════════════════════════════════\n"
        "- If a tool returns {'ok': false, 'error': '...'}: read the error, diagnose it, fix the root cause\n"
        "- Do NOT retry the same call with the same arguments — that will fail again\n"
        "- Do NOT silently skip a failed step and proceed — this creates invalid project state\n"
        "- If you are uncertain which ID to use, call get_project_outline again — never guess\n"
        "- If get_canvas_runtime_pins returns available: false after 2 attempts, tell the user clearly\n\n"

        "═══════════════════════════════════════════════\n"
        "OUTPUT STYLE\n"
        "═══════════════════════════════════════════════\n"
        "- After completing a task: give a brief summary of what was done (which components added, "
        "which pins wired, whether compilation succeeded)\n"
        "- If compilation errors exist: quote the error line and explain what caused it\n"
        "- Keep responses concise — the user can see the canvas update live\n"
        "- Do not explain what tools you are about to call — just call them and report the outcome"
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

    async def _run_frontend_action(
        ctx: RunContext[AgentDeps],
        action: str,
        payload: dict[str, Any] | None = None,
        *,
        timeout_ms: int = 20000,
    ) -> dict[str, Any]:
        request = create_frontend_action_request(
            session_id=ctx.deps.session_id,
            action=action,
            payload=payload or {},
        )
        await ctx.deps.emit_event(
            "frontend.action.request",
            {
                "actionId": request.action_id,
                "action": action,
                "payload": request.payload,
                "timeoutMs": timeout_ms,
            },
        )
        result = await wait_for_frontend_action_result(
            action_id=request.action_id,
            timeout_ms=timeout_ms,
        )
        return {
            "ok": result.ok,
            "actionId": result.action_id,
            "action": action,
            "payload": result.payload,
            "error": result.error,
        }

    @agent.tool
    async def get_project_outline(ctx: RunContext[AgentDeps]) -> dict[str, Any]:
        """Return the live project state: boards, components, wires, fileGroups and their IDs.

        MANDATORY: Call this FIRST on every message before any other tool.
        Use the real IDs from this response in all subsequent tool calls.
        Never invent or guess IDs.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "get_project_outline", lambda: agent_tools.get_project_outline(ctx.deps.snapshot))

    @agent.tool
    async def get_component_detail(ctx: RunContext[AgentDeps], component_id: str) -> dict[str, Any]:
        """Return full details for a placed component instance by its ID.

        component_id: the instance ID from get_project_outline (e.g. 'led1').
        """
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
        """Search the component catalog by name (e.g. 'LED', 'servo', 'DHT22').

        Each result has an 'id' field — use that as the metadata_id in add_component.
        Use get_component_schema(metadata_id) to see properties and pin names.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "search_component_catalog",
            lambda: agent_tools.search_component_catalog(query, category=category, limit=limit),
        )

    @agent.tool
    async def get_component_schema(ctx: RunContext[AgentDeps], component_id: str) -> dict[str, Any]:
        """Get properties and static pin names for a component type by metadata_id.

        component_id: the metadata_id from search_component_catalog (e.g. 'wokwi-led').
        NOTE: For wiring, always prefer get_canvas_runtime_pins() for live pin names.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "get_component_schema", lambda: agent_tools.get_component_schema(component_id))

    @agent.tool
    async def get_canvas_runtime_pins(ctx: RunContext[AgentDeps], instance_id: str) -> dict[str, Any]:
        """Get the exact pin names for a board or component from the live canvas DOM.

        Pass the instance id (e.g. 'led1', 'esp32-1') that was returned by
        add_component or add_board.  Returns pinNames read directly from the
        rendered wokwi element's pinInfo — no overrides, no normalization.

        MUST be called after every add_component / add_board and before wiring.

        The tool automatically retries up to 4 times (2 s total) while the
        frontend canvas renders and reports the element's pinInfo.  If available
        is still False after retries the canvas has genuinely not rendered it —
        stop and tell the user to open the canvas so the component is visible.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "get_canvas_runtime_pins",
            lambda: agent_tools.get_canvas_runtime_pins(ctx.deps.snapshot, instance_id),
        )

    @agent.tool
    async def list_component_schema_gaps(ctx: RunContext[AgentDeps], limit: int = 20) -> dict[str, Any]:
        """List components in the catalog that are missing pin name metadata."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx, "list_component_schema_gaps", lambda: agent_tools.list_component_schema_gaps(limit=limit)
        )

    @agent.tool
    async def list_files(ctx: RunContext[AgentDeps], group_id: str | None = None) -> list[dict[str, Any]]:
        """List files in a file group. Get group_id from get_project_outline → fileGroups."""
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
        """Read file content from a file group, optionally by line range.

        group_id: from get_project_outline → fileGroups or board.activeFileGroupId.
        file_name: e.g. 'sketch.ino'. Use list_files() to discover names.
        """
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
        """Add a board to the canvas.

        board_kind: e.g. 'arduino-uno', 'esp32', 'raspberry-pi-pico'.
        board_id: your chosen unique ID (optional, auto-generated if omitted).
        After calling this, you MUST call get_canvas_runtime_pins(board_id) before wiring.
        """
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
        """Change the board type of an existing board (e.g. Uno to ESP32).

        board_id: existing board ID from get_project_outline.
        board_kind: new board type string.
        """
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
        """Remove a board and all its connected wires from the project."""
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
        """Add a component to the canvas.

        metadata_id: the 'id' field from search_component_catalog results (e.g. 'wokwi-led').
        component_id: your chosen unique identifier for this instance (e.g. 'led1').
        properties: optional dict of component properties (e.g. {'color': 'red'}).
        After calling this, you MUST call get_canvas_runtime_pins(component_id) before wiring.
        """
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
        """Update position or properties of an existing component."""
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
        """Move a component to a new canvas position (x, y in pixels)."""
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
        """Remove a component and all its connected wires from the project."""
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
        """Connect two pins with a wire.

        start_pin and end_pin MUST be exact values from get_canvas_runtime_pins — never invented.
        color: '#22c55e'=signal(green), '#ef4444'=power(red), '#1e1e1e'=ground(black), '#facc15'=data(yellow).
        signal_type: None for generic, or 'pwm'/'i2c'/'spi'/'uart' for typed signals.
        wire_id: pass None to auto-assign.
        """
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
        """Remove a wire by its ID. Get wire IDs from get_project_outline."""
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
        """Set visual waypoints for a wire's path. waypoints: list of {x, y} dicts."""
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
        """Create a new file in a file group.

        group_id: the board's activeFileGroupId from get_project_outline.
        name: file name (e.g. 'sketch.ino', 'helpers.h').
        """
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
        """Replace a range of lines in an existing file. Use for targeted fixes.

        Preferred over rewriting the whole file. Lines are 1-indexed.
        """
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
        """Patch a file by matching exact original content and replacing with modified.

        original: exact current content of the file (must match exactly).
        modified: the new full content to replace it with.
        """
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
        """Compile via the backend arduino-cli. Prefer compile_in_frontend for richer errors."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "compile_board", lambda: agent_tools.compile_board(ctx.deps.snapshot, board_id=board_id))

    @agent.tool
    async def compile_in_frontend(ctx: RunContext[AgentDeps], board_id: str | None = None) -> dict[str, Any]:
        """Preferred compilation method. Mirrors the UI compile button and returns richer errors."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "compile_in_frontend",
            lambda: _run_frontend_action(
                ctx,
                "compile",
                {"boardId": board_id} if board_id else {},
                timeout_ms=180000,
            ),
        )

    @agent.tool
    async def open_serial_monitor(ctx: RunContext[AgentDeps], board_id: str | None = None) -> dict[str, Any]:
        """Open the serial monitor in the UI. Call before capture_serial_monitor."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "open_serial_monitor",
            lambda: _run_frontend_action(
                ctx,
                "serial.monitor.open",
                {"boardId": board_id} if board_id else {},
            ),
        )

    @agent.tool
    async def close_serial_monitor(ctx: RunContext[AgentDeps], board_id: str | None = None) -> dict[str, Any]:
        """Close the serial monitor in the UI."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "close_serial_monitor",
            lambda: _run_frontend_action(
                ctx,
                "serial.monitor.close",
                {"boardId": board_id} if board_id else {},
            ),
        )

    @agent.tool
    async def get_serial_monitor_status(ctx: RunContext[AgentDeps], board_id: str | None = None) -> dict[str, Any]:
        """Check whether the serial monitor is currently open."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "get_serial_monitor_status",
            lambda: _run_frontend_action(
                ctx,
                "serial.monitor.status",
                {"boardId": board_id} if board_id else {},
            ),
        )

    @agent.tool
    async def set_serial_baud_rate(
        ctx: RunContext[AgentDeps],
        baud_rate: int,
        board_id: str | None = None,
    ) -> dict[str, Any]:
        """Set the serial monitor baud rate (e.g. 9600, 115200)."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "set_serial_baud_rate",
            lambda: _run_frontend_action(
                ctx,
                "serial.set_baud_rate",
                {"boardId": board_id, "baudRate": baud_rate} if board_id else {"baudRate": baud_rate},
            ),
        )

    @agent.tool
    async def send_serial_message(
        ctx: RunContext[AgentDeps],
        text: str,
        board_id: str | None = None,
        line_ending: str | None = None,
    ) -> dict[str, Any]:
        """Send a text message to the board's serial RX. Useful for interactive sketches."""
        ctx.deps.guard_tool_call()
        payload: dict[str, Any] = {"text": text}
        if board_id:
            payload["boardId"] = board_id
        if line_ending:
            payload["lineEnding"] = line_ending
        return await _safe_tool_call(
            ctx,
            "send_serial_message",
            lambda: _run_frontend_action(ctx, "serial.send", payload),
        )

    @agent.tool
    async def clear_serial_monitor(ctx: RunContext[AgentDeps], board_id: str | None = None) -> dict[str, Any]:
        """Clear all output from the serial monitor."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "clear_serial_monitor",
            lambda: _run_frontend_action(
                ctx,
                "serial.clear",
                {"boardId": board_id} if board_id else {},
            ),
        )

    @agent.tool
    async def capture_serial_monitor(
        ctx: RunContext[AgentDeps],
        max_lines: int = 200,
        board_id: str | None = None,
    ) -> dict[str, Any]:
        """Capture recent serial monitor output. Call open_serial_monitor first."""
        ctx.deps.guard_tool_call()
        payload: dict[str, Any] = {"maxLines": max_lines}
        if board_id:
            payload["boardId"] = board_id
        return await _safe_tool_call(
            ctx,
            "capture_serial_monitor",
            lambda: _run_frontend_action(ctx, "serial.capture", payload),
        )

    @agent.tool
    async def run_simulation(ctx: RunContext[AgentDeps], board_id: str | None = None) -> dict[str, Any]:
        """Start the simulation in the UI. Compile must succeed first."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "run_simulation",
            lambda: _run_frontend_action(
                ctx,
                "sim.run",
                {"boardId": board_id} if board_id else {},
                timeout_ms=180000,
            ),
        )

    @agent.tool
    async def pause_simulation(ctx: RunContext[AgentDeps], board_id: str | None = None) -> dict[str, Any]:
        """Pause a running simulation."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "pause_simulation",
            lambda: _run_frontend_action(
                ctx,
                "sim.pause",
                {"boardId": board_id} if board_id else {},
            ),
        )

    @agent.tool
    async def reset_simulation(ctx: RunContext[AgentDeps], board_id: str | None = None) -> dict[str, Any]:
        """Reset the simulation to its initial state."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "reset_simulation",
            lambda: _run_frontend_action(
                ctx,
                "sim.reset",
                {"boardId": board_id} if board_id else {},
            ),
        )

    @agent.tool
    async def search_libraries(ctx: RunContext[AgentDeps], query: str) -> dict[str, Any]:
        """Search the Arduino library index by name. Use when compilation fails with missing includes."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "search_libraries", lambda: agent_tools.search_libraries(query))

    @agent.tool
    async def install_library(ctx: RunContext[AgentDeps], name: str) -> dict[str, Any]:
        """Install an Arduino library by exact name. Use search_libraries first to find names."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "install_library", lambda: agent_tools.install_library(name))

    @agent.tool
    async def list_installed_libraries(ctx: RunContext[AgentDeps]) -> dict[str, Any]:
        """List all currently installed Arduino libraries."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "list_installed_libraries", lambda: agent_tools.list_installed_libraries())

    @agent.tool
    async def validate_snapshot_state(ctx: RunContext[AgentDeps]) -> dict[str, Any]:
        """Check for structural problems in the project (unsupported boards, invalid refs)."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(ctx, "validate_snapshot_state", lambda: validate_snapshot(ctx.deps.snapshot).model_dump())

    @agent.tool
    async def validate_pin_mapping_state(ctx: RunContext[AgentDeps]) -> dict[str, Any]:
        """Check all wires for valid pin references. Call after wiring to confirm no conflicts."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx, "validate_pin_mapping_state", lambda: validate_pin_mapping(ctx.deps.snapshot).model_dump()
        )

    @agent.tool
    async def validate_compile_readiness_state(ctx: RunContext[AgentDeps], board_id: str) -> dict[str, Any]:
        """Check that a board has source files and a known architecture before compiling."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx, "validate_compile_readiness_state", lambda: validate_compile_readiness(ctx.deps.snapshot, board_id=board_id).model_dump()
        )

    @agent.tool
    async def wait_seconds(ctx: RunContext[AgentDeps], seconds: float = 1.0) -> dict[str, Any]:
        """Wait for a specified duration (0.1-10s). Useful between canvas operations."""
        ctx.deps.guard_tool_call()
        duration = max(0.1, min(seconds, 10.0))
        await asyncio.sleep(duration)
        return {"ok": True, "seconds": duration}

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

        # Resolve model — returns a model string for openai: or a configured
        # OpenAIModel object for github-copilot: (no env mutation, fully isolated)
        resolved_model: Any = session.model_name
        if session.model_name:
            try:
                from app.services.llm_providers import resolve_pydantic_ai_model
                resolved_model = await resolve_pydantic_ai_model(
                    db, user_id, session.model_name
                )
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

        agent = build_agent(
            resolved_model if isinstance(resolved_model, str) else None,
            defer_model_check=model_override is not None or not isinstance(resolved_model, str),
        )
        run_kwargs: dict[str, Any] = {"deps": deps}
        run_params = inspect.signature(agent.run).parameters
        if "event_stream_handler" in run_params:
            run_kwargs["event_stream_handler"] = _event_stream_handler
        try:
            # For GitHub Copilot, resolved_model is an OpenAIModel object — override directly.
            # For OpenAI string models, model_override takes precedence if provided.
            effective_override = model_override or (resolved_model if not isinstance(resolved_model, str) else None)
            if effective_override is not None:
                with agent.override(model=effective_override):
                    result = await agent.run(contextual_prompt, **run_kwargs)
            else:
                result = await agent.run(contextual_prompt, **run_kwargs)
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


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "model_dump"):
        try:
            return _jsonable(value.model_dump())
        except Exception:
            pass
    try:
        json.dumps(value)
        return value
    except Exception:
        return str(value)


def _extract_tool_call_input(event: FunctionToolCallEvent) -> Any:
    part = event.part
    # Different pydantic-ai versions expose args in slightly different shapes.
    for attr in ("args", "arguments", "args_dict", "kwargs"):
        if hasattr(part, attr):
            value = getattr(part, attr)
            if value is not None:
                return _jsonable(value)
    for attr in ("args_json", "arguments_json", "json_args"):
        if hasattr(part, attr):
            raw = getattr(part, attr)
            if isinstance(raw, str) and raw.strip():
                try:
                    return _jsonable(json.loads(raw))
                except Exception:
                    return raw
    return None


def _extract_tool_call_output(event: FunctionToolResultEvent) -> Any:
    result = event.result
    for attr in ("content", "output", "result", "return_value", "value"):
        if hasattr(result, attr):
            value = getattr(result, attr)
            if value is not None:
                return _jsonable(value)
    return _jsonable(result)


async def _event_stream_handler(ctx: RunContext[AgentDeps], events: AsyncIterable[AgentStreamEvent]) -> None:
    async for event in events:
        if isinstance(event, FunctionToolCallEvent):
            tool_input = _extract_tool_call_input(event)
            await ctx.deps.emit_event(
                "tool.call.started",
                {"tool": event.part.tool_name, "toolCallId": event.tool_call_id, "input": tool_input},
            )
            log_event(
                "tool.call.started",
                session_id=ctx.deps.session_id,
                tool=event.part.tool_name,
                input=tool_input,
            )
        elif isinstance(event, FunctionToolResultEvent):
            tool_name = getattr(event.result, "tool_name", None)
            tool_output = _extract_tool_call_output(event)
            await ctx.deps.emit_event(
                "tool.call.result",
                {"tool": tool_name, "toolCallId": event.tool_call_id, "output": tool_output},
            )
            log_event("tool.call.result", session_id=ctx.deps.session_id, tool=tool_name, output=tool_output)
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
