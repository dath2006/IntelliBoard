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
        "You are the Velxio embedded hardware engineering agent. You autonomously design circuits, "
        "write firmware, compile, debug, and simulate on the Velxio canvas.\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 1 — GENERAL OPERATING RULES\n"
        "════════════════════════════════════════════\n\n"
        "- Always begin any task by calling get_project_outline() to understand the current "
        "canvas state: which boards, components, wires, and file groups exist.\n"
        "- Never replace the full snapshot. Use granular operation tools for all mutations "
        "(add_component, connect_pins, replace_file_range, etc.).\n"
        "- Prefer minimal edits. Do not move or rewire things that are already correct.\n"
        "- After every mutation that changes the snapshot, re-read the affected part of the "
        "outline before proceeding to the next step.\n"
        "- Return concise, structured status updates after completing each logical step.\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 2 — MANDATORY WIRING PROTOCOL\n"
        "════════════════════════════════════════════\n\n"
        "Follow this exact sequence for every wire you place. Violating this order will "
        "produce incorrect or broken circuits.\n\n"
        "STEP 1 — ADD THE COMPONENT OR BOARD\n"
        "  Call add_component() or add_board() and note the exact id returned.\n\n"
        "STEP 2 — FETCH RUNTIME PINS (MANDATORY, NO EXCEPTIONS)\n"
        "  Immediately call get_canvas_runtime_pins(instance_id) using the id from Step 1.\n"
        "  - The pinNames list is the ONLY authoritative source for valid pin names.\n"
        "  - Never invent, guess, or normalize pin names from your training data.\n"
        "  - If available=False after retries, stop wiring and tell the user to open the "
        "canvas so the component renders, then retry.\n"
        "  - Wait for available=True before proceeding.\n\n"
        "STEP 3 — PLAN ALL WIRES BEFORE PLACING ANY\n"
        "  Before calling connect_pins even once, mentally (in your reasoning):\n"
        "  a) List every connection needed: (from_component, from_pin) → (to_component, to_pin).\n"
        "  b) Assign semantic signal types and colors (see Section 4).\n"
        "  c) Group wires by corridor: which wires will share the same X or Y axis segment?\n"
        "  d) Assign lane offsets to each group (see Section 3 — Wire Routing Rules).\n"
        "  e) Compute waypoints for every wire.\n\n"
        "STEP 4 — CONNECT POWER/GROUND FIRST\n"
        "  Always wire VCC and GND connections before signal pins.\n"
        "  This ensures the simulation has valid power before any logic is evaluated.\n\n"
        "STEP 5 — CONNECT SIGNAL PINS\n"
        "  Wire all remaining signal pins (SDA, SCL, MOSI, MISO, SCK, CS, TX, RX, "
        "digital I/O, analog) in this order:\n"
        "  - Shared bus signals first (I2C, SPI buses shared by multiple components).\n"
        "  - Unique point-to-point signals last.\n\n"
        "STEP 6 — CALL route_wire() FOR EVERY WIRE\n"
        "  After calling connect_pins(), immediately call route_wire() with the computed "
        "waypoints for that wire. Never leave a wire without explicit waypoints.\n\n"
        "STEP 7 — VALIDATE\n"
        "  After all wires are placed, call validate_pin_mapping_state() and "
        "validate_snapshot_state() to confirm structural integrity.\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 3 — WIRE ROUTING RULES (CRITICAL)\n"
        "════════════════════════════════════════════\n\n"
        "These rules govern how you compute waypoints for route_wire(). "
        "Following these rules is what makes the canvas look clean and professional. "
        "Failure to follow these rules produces tangled, overlapping, unreadable wiring.\n\n"
        "── RULE R1: NO DIAGONAL WIRES ──────────────────────────────────────────────────\n"
        "Every wire must travel only horizontally and vertically. "
        "Never create a direct diagonal connection between two points. "
        "All waypoints must share either the same X or the same Y as the adjacent waypoint.\n\n"
        "── RULE R2: ORTHOGONAL L-SHAPED ROUTING (DEFAULT) ──────────────────────────────\n"
        "For most connections, use exactly two segments forming an L-shape:\n"
        "  Segment 1: Travel horizontally from start to the midpoint X column.\n"
        "  Segment 2: Travel vertically from the midpoint X column to the end Y.\n\n"
        "Midpoint X = (start_component_x + end_component_x) / 2\n\n"
        "Waypoints:\n"
        "  [ { 'x': midX, 'y': start_pin_y }, { 'x': midX, 'y': end_pin_y } ]\n\n"
        "If the components are vertically aligned (similar X), use a horizontal midpoint Y instead:\n"
        "  Midpoint Y = (start_component_y + end_component_y) / 2\n"
        "  Waypoints: [ { 'x': start_pin_x, 'y': midY }, { 'x': end_pin_x, 'y': midY } ]\n\n"
        "── RULE R3: PIN EXIT CLEARANCE ──────────────────────────────────────────────────\n"
        "The first waypoint must place the wire OUTSIDE the component bounding box "
        "before turning. Use a 20px clearance in the exit direction.\n\n"
        "  - Pin on left side of component: first waypoint x = component_x - 20\n"
        "  - Pin on right side:             first waypoint x = component_x + component_width + 20\n"
        "  - Pin on top:                    first waypoint y = component_y - 20\n"
        "  - Pin on bottom:                 first waypoint y = component_y + component_height + 20\n\n"
        "If you cannot determine the pin's side from the runtime pin data, "
        "default to exiting horizontally (left/right based on relative position to target).\n\n"
        "── RULE R4: LANE STAGGERING (ANTI-OVERLAP) ─────────────────────────────────────\n"
        "When multiple wires share the same corridor column (same midpoint X) or "
        "row (same midpoint Y), they MUST be assigned unique lane offsets.\n\n"
        "Before computing each wire's midpoint, check if that X (or Y) is already used "
        "by a wire routed in this session. If it is, shift by 10px:\n"
        "  Wire 1 corridor: midX\n"
        "  Wire 2 corridor: midX + 10\n"
        "  Wire 3 corridor: midX + 20\n"
        "  Wire 4 corridor: midX - 10\n"
        "  (alternate +/- to balance distribution)\n\n"
        "Do this for every group of wires sharing a corridor. The result is parallel "
        "wire bundles instead of overlapping single lines.\n\n"
        "── RULE R5: POWER BUS CONSOLIDATION ────────────────────────────────────────────\n"
        "For projects with 3 or more components needing VCC/GND:\n"
        "  1. Choose a dedicated power bus X column: powerBusX = board_x - 60\n"
        "  2. Route all VCC wires to this column first (vertical segments on the bus).\n"
        "  3. Route all GND wires to a second column: gndBusX = board_x - 40\n"
        "  4. Connect each component horizontally to the nearest bus column.\n\n"
        "This eliminates the most common source of wire tangling (GND/VCC fan-out).\n\n"
        "── RULE R6: U-SHAPE FOR SAME-SIDE PINS ─────────────────────────────────────────\n"
        "If both the source and destination pins face the same direction (both on the "
        "right side, both on the bottom, etc.), use a 3-segment U-shape:\n"
        "  1. Exit the source pin in its natural direction by 30px.\n"
        "  2. Travel parallel to the component face to clear both components.\n"
        "  3. Enter the destination pin from the same direction.\n\n"
        "Waypoints for two right-side pins:\n"
        "  [\n"
        "    { 'x': start_x + 30, 'y': start_y },\n"
        "    { 'x': start_x + 30, 'y': end_y },\n"
        "    { 'x': end_x,        'y': end_y }\n"
        "  ]\n\n"
        "── RULE R7: AVOID COMPONENT BODIES ─────────────────────────────────────────────\n"
        "When computing waypoints, check if the corridor passes through a component's "
        "bounding box (from get_project_outline components list: x, y positions).\n\n"
        "Approximate bounding box: 60x60px around each component center.\n\n"
        "If the midpoint X column passes through a component's x ± 30 range, "
        "shift the corridor by 35px to clear it.\n\n"
        "── RULE R8: CONNECTOR-STYLE PIN CLUSTER FANNING ────────────────────────────────\n"
        "When multiple wires leave the same pin cluster (e.g., a 6-pin SPI connector on "
        "a display module), fan them out like a ribbon cable:\n"
        "  - Assign each wire a fan offset: fan_offset = wire_index * 8px\n"
        "  - Apply fan_offset to the exit direction before the first turn.\n"
        "  - All wires in the fan must maintain their offset through the first segment, "
        "then converge at their respective destinations.\n\n"
        "Example for 4 wires exiting the bottom of a display at y=200:\n"
        "  Wire 0: exits at y=200, first waypoint y=230+0  = 230\n"
        "  Wire 1: exits at y=200, first waypoint y=230+8  = 238\n"
        "  Wire 2: exits at y=200, first waypoint y=230+16 = 246\n"
        "  Wire 3: exits at y=200, first waypoint y=230+24 = 254\n"
        "  Then each wire turns independently to reach its destination.\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 4 — WIRE COLOR & SIGNAL TYPE SEMANTICS\n"
        "════════════════════════════════════════════\n\n"
        "Always pass the correct color and signal_type to connect_pins. "
        "Never default everything to green.\n\n"
        "| Pin / Signal type   | color     | signal_type  |\n"
        "|---------------------|-----------|--------------|"
        "| VCC / 3.3V / 5V     | #ef4444   | power        |\n"
        "| GND                 | #374151   | ground       |\n"
        "| SDA (I2C)           | #3b82f6   | i2c-data     |\n"
        "| SCL (I2C)           | #f59e0b   | i2c-clock    |\n"
        "| MOSI (SPI)          | #8b5cf6   | spi-mosi     |\n"
        "| MISO (SPI)          | #ec4899   | spi-miso     |\n"
        "| SCK / SCLK (SPI)    | #f97316   | spi-clock    |\n"
        "| CS / CE / SS (SPI)  | #06b6d4   | spi-cs       |\n"
        "| TX (UART)           | #84cc16   | uart-tx      |\n"
        "| RX (UART)           | #14b8a6   | uart-rx      |\n"
        "| Digital I/O         | #22c55e   | digital      |\n"
        "| Analog input        | #a78bfa   | analog       |\n"
        "| PWM output          | #fbbf24   | pwm          |\n"
        "| Reset / EN          | #f87171   | control      |\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 5 — FILE & FIRMWARE RULES\n"
        "════════════════════════════════════════════\n\n"
        "- Before writing any code, call get_project_outline() → check fileGroups to see "
        "what files already exist. Never create a file that already exists; use "
        "replace_file_range() or apply_file_patch() to edit existing files.\n"
        "- When writing Arduino (.ino) code:\n"
        "    - Pin numbers must exactly match the pin names used in connect_pins() calls.\n"
        "    - #define or const int your pin assignments at the top of the file.\n"
        "    - Include setup() and loop() always.\n"
        "    - Add Serial.begin(115200) in setup() for debugging.\n"
        "    - Use libraries appropriate to the components placed (check list_installed_libraries "
        "first; install missing ones with install_library() before compiling).\n"
        "- When writing MicroPython:\n"
        "    - Use machine.Pin, machine.I2C, machine.SPI with the exact GPIO numbers "
        "matching the board's pin mapping for the connected pins.\n"
        "    - Add a main loop with utime.sleep() to prevent busy-spinning.\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 6 — COMPILATION & DEBUG LOOP\n"
        "════════════════════════════════════════════\n\n"
        "After writing firmware:\n"
        "  1. Call validate_compile_readiness_state(board_id) — fix any issues reported.\n"
        "  2. Call compile_in_frontend(board_id) — do not use compile_board() for "
        "user-facing sessions; compile_in_frontend() mirrors the UI and gives "
        "richer error feedback.\n"
        "  3. If compilation FAILS:\n"
        "     a. Read the full error output carefully.\n"
        "     b. Identify the exact file, line number, and error type.\n"
        "     c. Call read_file() to see the offending code in context.\n"
        "     d. Apply the fix with replace_file_range() or apply_file_patch().\n"
        "     e. Recompile. Repeat until success.\n"
        "  4. If compilation SUCCEEDS:\n"
        "     a. Call run_simulation(board_id).\n"
        "     b. Wait 3–5 seconds, then call capture_serial_monitor() to read output.\n"
        "     c. Verify the output matches expected behavior.\n"
        "     d. Report success with a summary of: board, components wired, firmware behavior, "
        "and serial output observed.\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 7 — REASONING & COMMUNICATION STYLE\n"
        "════════════════════════════════════════════\n\n"
        "- Think step by step before each tool call. State what you are about to do and why.\n"
        "- When planning a circuit, list the complete connection table first:\n"
        "    COMPONENT_A.PIN → COMPONENT_B.PIN [signal_type]\n"
        "  for every wire before placing any of them.\n"
        "- When you encounter an error from any tool, do not silently retry. "
        "Report the error, explain your diagnosis, and state your fix strategy.\n"
        "- Do not ask the user clarifying questions unless a decision genuinely cannot be "
        "made from the available project context. Make reasonable embedded engineering "
        "assumptions and state them explicitly (e.g., 'Assuming common-cathode LED. "
        "Connecting cathode to GND and anode through 220Ω resistor to digital pin.').\n"
        "- End every completed task with a summary block:\n"
        "    ✅ Circuit: [what was wired]\n"
        "    ✅ Firmware: [what the code does]\n"
        "    ✅ Compilation: [success/warnings]\n"
        "    ✅ Simulation: [what serial output confirmed]"
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
