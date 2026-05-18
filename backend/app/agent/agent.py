from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import AsyncIterable
from typing import Any

# pyrefly: ignore [missing-import]
from pydantic_ai import Agent, RunContext, WebSearchTool
# pyrefly: ignore [missing-import]
from pydantic_ai.models.openrouter import OpenRouterModel
# pyrefly: ignore [missing-import]
from pydantic_ai.providers.openrouter import OpenRouterProvider
# pyrefly: ignore [missing-import]
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


def build_agent(model_name: Any | None = None, *, defer_model_check: bool = False) -> Agent[AgentDeps, str]:
    instructions = (
        "You are the IntelliBoard embedded hardware engineering agent. You autonomously design circuits, "
        "write firmware, compile, debug, and simulate on the IntelliBoard canvas.\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 1 — GENERAL OPERATING RULES\n"
        "════════════════════════════════════════════\n\n"
        "- Always begin any task by calling get_project_outline() to understand the current "
        "canvas state: which boards, components, wires, and file groups exist.\n"
        "- Never replace the full snapshot. Use granular operation tools for all mutations "
        "(add_component, connect_pins, patch_file_lines, etc.).\n"
        "- Prefer minimal edits. Do not move or rewire things that are already correct.\n"
        "- After every mutation that changes the snapshot, re-read the affected part of the "
        "outline before proceeding to the next step.\n"
        "- Return concise, structured status updates after completing each logical step.\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 2 — MANDATORY CIRCUIT BUILDING PROTOCOL\n"
        "════════════════════════════════════════════\n\n"
        "Follow this exact sequence. The agent's job is electrical topology (what connects "
        "to what). The frontend handles all spatial geometry automatically.\n\n"
        "STEP 1 — GET SPATIAL CONTEXT (MANDATORY FIRST)\n"
        "  Call get_canvas_spatial_context() to see the live canvas: real board pixel "
        "dimensions, which sides have free space, and where existing components are.\n"
        "  Also call get_project_outline() to get IDs of existing entities.\n\n"
        "STEP 2 — SUGGEST COMPONENT POSITIONS (NEVER GUESS x/y)\n"
        "  Before adding any component, call suggest_placement(requests=[...]) with:\n"
        "    - id: the component_id you plan to use\n"
        "    - metadataId: from search_component_catalog\n"
        "    - connectsToBoardPin: the board pin it will connect to (used for side selection)\n"
        "  The frontend measures the live DOM and returns {id, x, y, side} for each.\n"
        "  Use those x, y values DIRECTLY in add_component_batch — never invent coordinates.\n\n"
        "STEP 3 — ADD COMPONENTS\n"
        "  Call add_component_batch(components=[...]) using the x, y from Step 2.\n"
        "  When adding a single component, add_component() is fine.\n\n"
        "STEP 4 — FETCH RUNTIME PINS (MANDATORY, NO EXCEPTIONS)\n"
        "  Call get_canvas_runtime_pins_batch(instance_ids) for all added components.\n"
        "  - The pinNames list is the ONLY authoritative source for valid pin names.\n"
        "  - Never invent, guess, or normalize pin names from training data.\n"
        "  - If available=False after retries, tell the user to open the canvas then retry.\n\n"
        "STEP 5 — CONNECT ALL WIRES (TOPOLOGY ONLY)\n"
        "  Call connect_pins_batch(wires=[...]) to declare all connections at once.\n"
        "  Order: VCC/GND first, then I2C/SPI buses, then point-to-point signals.\n"
        "  - Use connect_pins() only when placing exactly 1 wire.\n"
        "  - Note every wire_id returned — you need them in Step 6.\n\n"
        "STEP 6 — AUTO-ROUTE ALL WIRES (NEVER COMPUTE WAYPOINTS MANUALLY)\n"
        "  Call auto_route_wires(wire_ids=[...]) passing the wire IDs from Step 5.\n"
        "  The frontend reads real pin positions from the DOM and runs the obstacle\n"
        "  router to produce clean, non-overlapping orthogonal waypoints.\n"
        "  Then call route_wire_batch(routes=[...]) using the returned routes:\n"
        "    result = auto_route_wires(wire_ids=[\"wire-1\", \"wire-2\"])\n"
        "    routes = [{\"wire_id\": r[\"wireId\"], \"waypoints\": r[\"waypoints\"]}\n"
        "              for r in result[\"payload\"][\"routes\"] if r[\"routed\"]]\n"
        "    route_wire_batch(routes=routes)\n"
        "  If routed=False for a wire, call wait_seconds(1) and retry auto_route_wires.\n\n"
        "STEP 7 — VALIDATE\n"
        "  Call validate_pin_mapping_state() and validate_snapshot_state().\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 3 — SPATIAL TOOL USAGE RULES\n"
        "════════════════════════════════════════════\n\n"
        "── RULE S1: NEVER INVENT COORDINATES ───────────────────────────────────────────\n"
        "Never pass hardcoded or guessed x/y values to add_component or add_board.\n"
        "ALWAYS call suggest_placement() first to get frontend-computed positions.\n"
        "This is the single most important rule for clean canvas layouts.\n\n"
        "── RULE S2: NEVER COMPUTE WAYPOINTS MANUALLY ───────────────────────────────────\n"
        "Never call route_wire or route_wire_batch with manually computed waypoints.\n"
        "ALWAYS call auto_route_wires() first, then pass the returned waypoints to\n"
        "route_wire_batch. The frontend obstacle router knows real pin positions and\n"
        "component bounding boxes — you do not.\n\n"
        "── RULE S3: USE get_canvas_spatial_context FOR REASONING ───────────────────────\n"
        "When you need to understand where things are on the canvas (e.g., why wires\n"
        "cross, whether there is free space, which side of a board a pin exits from),\n"
        "call get_canvas_spatial_context(). It reads the live DOM and returns real\n"
        "pixel coordinates, widths, heights, and per-pin canvas positions.\n\n"
        "── RULE S4: BATCH EVERYTHING ────────────────────────────────────────────────────\n"
        "- add_component_batch   > add_component (for 2+ components)\n"
        "- connect_pins_batch    > connect_pins (for 2+ wires)\n"
        "- route_wire_batch      > route_wire (for 2+ wires)\n"
        "- get_canvas_runtime_pins_batch > get_canvas_runtime_pins (for 2+ instances)\n\n"
        "── RULE S5: WIRE COLOR & SIGNAL TYPE ───────────────────────────────────────────\n"
        "Always assign the correct color and signal_type in connect_pins_batch.\n"
        "  VCC/3.3V/5V  → color='#ef4444', signal_type='power'\n"
        "  GND          → color='#374151', signal_type='ground'\n"
        "  SDA (I2C)    → color='#3b82f6', signal_type='i2c-data'\n"
        "  SCL (I2C)    → color='#f59e0b', signal_type='i2c-clock'\n"
        "  MOSI (SPI)   → color='#8b5cf6', signal_type='spi-mosi'\n"
        "  MISO (SPI)   → color='#ec4899', signal_type='spi-miso'\n"
        "  SCK (SPI)    → color='#f97316', signal_type='spi-clock'\n"
        "  CS/SS (SPI)  → color='#06b6d4', signal_type='spi-cs'\n"
        "  TX (UART)    → color='#84cc16', signal_type='uart-tx'\n"
        "  RX (UART)    → color='#14b8a6', signal_type='uart-rx'\n"
        "  Digital I/O  → color='#22c55e', signal_type='digital'\n"
        "  Analog       → color='#a78bfa', signal_type='analog'\n"
        "  PWM          → color='#fbbf24', signal_type='pwm'\n"
        "  Reset/EN     → color='#f87171', signal_type='control'\n\n"

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
        "- Before writing any code, call get_project_outline() → check fileGroups to see \n"
        "  what files already exist. Never create a file that already exists.\n"
        "- To edit existing code: use patch_file_lines or apply_file_patch — never recreate the whole file.\n"
        "- Use replace_file_content only when you intentionally want to replace the full file.\n"
        "- Use delete_file() to remove unwanted files, rename_file() to rename them.\n"
        "- Use set_language_mode(board_id, 'micropython') before writing MicroPython code\n"
        "  for ESP32/Pico boards. This switches the board's language mode accordingly.\n\n"
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
        "     d. Apply the fix with patch_file_lines or apply_file_patch, then recompile\n"
        "     e. Recompile. Repeat until success.\n"
        "  4. If compilation SUCCEEDS:\n"
        "     a. Call get_simulation_status(board_id) to check if already running.\n"
        "     b. Call run_simulation(board_id).\n"
        "     c. Use wait_for_serial_output(pattern, timeout_seconds) to reliably wait\n"
        "        for expected output instead of guessing with wait_seconds.\n"
        "     d. Verify the output matches expected behavior.\n"
        "     e. Report success with a summary of: board, components wired, firmware behavior, "
        "and serial output observed.\n"
        "  5. If the user says 'fix the error' without context, call get_last_compile_result()\n"
        "     to retrieve the cached error log — avoids an unnecessary recompile.\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 7 — GLOBAL CATALOG DISCOVERY & BROAD QUESTIONS\n"
        "════════════════════════════════════════════\n\n"
        "When the user asks questions that require a broad understanding of all available "
        "possibilities or architecture patterns (e.g., 'what can I build?', 'how should I "
        "architect X?', 'give me project ideas', 'compare available sensors') you MUST follow "
        "this protocol:\n\n"
        "STEP 1 — COMPREHENSIVE DISCOVERY\n"
        "  Call get_full_component_catalog() to retrieve the entire component list grouped "
        "  by category. Avoid search_component_catalog() for broad discovery as it filters "
        "  results and may miss relevant categories.\n\n"
        "STEP 2 — CATEGORY ANALYSIS\n"
        "  Analyze the distribution of components across categories. Identify unique or "
        "  high-value parts that can drive complex, professional project architectures.\n\n"
        "STEP 3 — STRUCTURED RESPONSE\n"
        "  a) For 'Project Ideas' & 'Architecture': Generate 5–8 distinct projects or "
        "     patterns using DIFFERENT categories. Provide a name, required component IDs, "
        "     a 2-sentence description, and difficulty rating.\n"
        "  b) For 'Inventory/Catalog': List categories and summarize the types of components "
        "     available in each, highlighting key items and their capabilities.\n"
        "  c) For 'Comparisons': Use the full data to compare specifications (pin count, "
        "     description, tags) across relevant parts to provide an informed recommendation.\n\n"
        "STEP 4 — ENRICHMENT\n"
        "  If web search is available (OpenAI provider), use it to find real-world examples, "
        "  advanced library documentation, or wiring diagrams to supplement your response.\n\n"
        "STEP 5 — CALL TO ACTION\n"
        "  Always end by asking the user which path they'd like to explore further (e.g., 'Would "
        "  you like to start building the Smart Weather Station?') and offer to begin the design "
        "  or setup process automatically.\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 8 — REASONING & COMMUNICATION STYLE\n"
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
        "    ✅ Simulation: [what serial output confirmed]\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 9 — WEB SEARCH PROTOCOL\n"
        "════════════════════════════════════════════\n\n"
        "- Use the web search tool to look up technical details that are missing from your "
        "internal knowledge base or the project outline.\n"
        "- Specifically, use it for:\n"
        "    - Verifying component pinouts (e.g., ESP32-S3 GPIO mapping, sensor I2C addresses).\n"
        "    - Researching Arduino or MicroPython library APIs for specialized hardware.\n"
        "    - Finding recommended circuit patterns (e.g., pull-up resistor values, decoupling capacitors).\n"
        "    - Debugging obscure compilation errors or firmware runtime behaviors.\n"
        "- Always cite your sources briefly (e.g., 'According to the SSD1306 datasheet...') when "
        "making design decisions based on search results.\n"
        "- Do not use web search for information that is already available in the "
        "get_project_outline() or get_canvas_runtime_pins() responses.\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 10 — PLAN ANNOUNCEMENT\n"
        "════════════════════════════════════════════\n\n"
        "Before starting any multi-step task, call announce_plan() ONCE with a concise "
        "execution plan. This renders a structured plan card in the UI so the user "
        "knows what you are about to do.\n\n"
        "Call announce_plan() ONLY when the request requires 2 or more distinct actions "
        "(e.g., adding components AND wiring AND writing firmware). "
        "Do NOT call it for:\n"
        "  - Simple questions or explanations (no canvas mutations needed)\n"
        "  - Single-action requests (e.g., 'rename this file', 'what is this component?')\n"
        "  - Follow-up clarifications where no new work is being started\n\n"
        "The steps you provide must reflect your actual intended execution sequence — "
        "not generic boilerplate. Be specific (e.g., 'Add ESP32 + SSD1306 display' "
        "not 'Add components').\n"
        "Call announce_plan() as the very first tool call of the run, before any canvas reads.\n\n"

        "════════════════════════════════════════════\n"
        "SECTION 11 — TASK PROGRESS (TODOS)\n"
        "════════════════════════════════════════════\n\n"
        "After announce_plan() is approved, call create_todo() ONCE with the same steps to "
        "show a live progress tracker in the UI. Use the same ids and labels from the plan.\n\n"
        "During execution, wrap EVERY step with:\n"
        "  1. update_todo(id, 'in_progress')  — before starting that step's tool calls\n"
        "  2. update_todo(id, 'done')          — after the step is complete\n"
        "  3. update_todo(id, 'skipped')       — if a step is intentionally not needed\n\n"
        "Rules:\n"
        "  - Do NOT call create_todo() for single-action requests or questions.\n"
        "  - Do NOT call create_todo() if announce_plan() returned approved=False.\n"
        "  - If the user changes the plan via regenerate, call create_todo() again with "
        "the new steps after the new plan is approved.\n"
        "  - Always mark every todo as 'done' or 'skipped' before finishing — never leave "
        "items stuck in 'in_progress' or 'pending'."
    )

    model = model_name if model_name is not None else settings.AGENT_MODEL
    builtin_tools = []

    # Enable OpenAI native web search when using OpenAI models.
    # Note: Using built-in tools requires the 'openai-responses:' prefix.
    if isinstance(model, str) and (model.startswith("openai:") or model.startswith("openai-responses:")):
        if model.startswith("openai:"):
            model = model.replace("openai:", "openai-responses:", 1)
        builtin_tools.append(WebSearchTool())

    # Build an explicit OpenRouterModel when using the openrouter: prefix so that
    # the OPENROUTER_API_KEY env-var is picked up by OpenRouterProvider.
    if isinstance(model, str) and model.startswith("openrouter:"):
        openrouter_model_name = model[len("openrouter:"):]
        model = OpenRouterModel(
            openrouter_model_name,
            provider=OpenRouterProvider(api_key=settings.OPENROUTER_API_KEY),
        )

    agent = Agent(
        model,
        deps_type=AgentDeps,
        instructions=instructions,
        defer_model_check=defer_model_check,
        builtin_tools=builtin_tools,
    )

    @agent.instructions
    def _ui_state_prompt(ctx: RunContext[AgentDeps]) -> str:
        state = ctx.deps.state
        if state is None:
            return ""
        parts: list[str] = []
        if state.projectId:
            parts.append(f"projectId={state.projectId}")
        if state.sessionId:
            parts.append(f"sessionId={state.sessionId}")
        if state.activeBoardId:
            parts.append(f"activeBoardId={state.activeBoardId}")
        if state.activeGroupId:
            parts.append(f"activeGroupId={state.activeGroupId}")
        if state.activeFileId:
            parts.append(f"activeFileId={state.activeFileId}")
        if state.activeFileName:
            parts.append(f"activeFileName={state.activeFileName}")
        if state.selectedWireId:
            parts.append(f"selectedWireId={state.selectedWireId}")
        if not parts:
            return ""
        return "UI state: " + ", ".join(parts)

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
    async def get_full_component_catalog(ctx: RunContext[AgentDeps]) -> dict[str, Any]:
        """Return every component available on the canvas, grouped by category.

        Use this (instead of repeated search_component_catalog calls) when you need
        a complete picture of what is available — for example when the user asks for
        project ideas, what components are available, or anything that requires
        knowing the full catalog rather than searching for a specific part.

        Returns a dict:
          {
            "total": int,
            "categories": {
              "sensors":  [{"id": ..., "name": ..., "description": ...}, ...],
              "displays": [...],
              "output":   [...],
              ...
            }
          }
        """
        ctx.deps.guard_tool_call()

        def _build_catalog() -> dict[str, Any]:
            from app.agent.catalog import load_component_catalog
            components = load_component_catalog()
            grouped: dict[str, list[dict]] = {}
            for comp in components:
                cat = str(comp.get("category") or "other")
                entry = {
                    "id":          comp.get("id", ""),
                    "name":        comp.get("name", ""),
                    "description": comp.get("description") or "",
                    "pinCount":    comp.get("pinCount", 0),
                    "tags":        comp.get("tags", []),
                }
                grouped.setdefault(cat, []).append(entry)
            return {"total": len(components), "categories": grouped}

        return await _safe_tool_call(ctx, "get_full_component_catalog", _build_catalog)

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
    async def get_canvas_runtime_pins_batch(
        ctx: RunContext[AgentDeps], instance_ids: list[str]
    ) -> dict[str, Any]:
        """Get runtime pin names for multiple instances in ONE call.

        Pass a list of instance ids (e.g. ['led1', 'led2', 'led3']).
        Internally deduplicates by metadata_id so adding 10 identical LEDs
        only performs a single catalog lookup instead of 10.

        Returns {"results": [{instanceId, instanceType, available, pinNames}, ...]}.

        USE THIS instead of calling get_canvas_runtime_pins() in a loop when you
        have added multiple components of the same type. You still get per-instance
        results but save tool calls and latency.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "get_canvas_runtime_pins_batch",
            lambda: agent_tools.get_canvas_runtime_pins_batch(ctx.deps.snapshot, instance_ids),
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
        After calling this, you MUST call get_canvas_runtime_pins or
        get_canvas_runtime_pins_batch before wiring.
        When adding multiple components of the same type, use
        get_canvas_runtime_pins_batch to avoid redundant lookups.
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
        """Connect two pins with a wire. Use connect_pins_batch for 2+ wires.

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
    async def connect_pins_batch(
        ctx: RunContext[AgentDeps],
        wires: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Connect multiple wires in ONE call instead of calling connect_pins N times.

        wires: list of dicts, each with keys:
          - start_component_id (required)
          - start_pin (required)
          - end_component_id (required)
          - end_pin (required)
          - wire_id (optional — auto-assigned if omitted)
          - color (optional — defaults to '#22c55e')
          - signal_type (optional)

        Example:
          connect_pins_batch(wires=[
            {"start_component_id": "esp32-1", "start_pin": "23", "end_component_id": "led1", "end_pin": "A", "color": "#22c55e"},
            {"start_component_id": "led1", "start_pin": "C", "end_component_id": "esp32-1", "end_pin": "GND", "color": "#374151", "signal_type": "ground"},
          ])

        All wires are applied atomically. If any wire spec is invalid, the
        entire batch is rejected (no partial application).

        USE THIS whenever you need to place 2 or more wires. It saves tool calls
        and latency compared to calling connect_pins() in a loop.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "connect_pins_batch",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.connect_pins_batch(
                    ctx.deps.snapshot,
                    wires=wires,
                ),
                tool_name="connect_pins_batch",
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
    async def route_wire_batch(
        ctx: RunContext[AgentDeps],
        routes: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Set waypoints for multiple wires in ONE call instead of calling route_wire N times.

        routes: list of dicts, each with keys:
          - wire_id (required)
          - waypoints (required — list of {x, y} dicts)

        Example:
          route_wire_batch(routes=[
            {"wire_id": "wire-1", "waypoints": [{"x": 100, "y": 50}, {"x": 100, "y": 150}]},
            {"wire_id": "wire-2", "waypoints": [{"x": 110, "y": 50}, {"x": 110, "y": 200}]},
          ])

        All routes are applied atomically. USE THIS whenever you route 2+ wires.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "route_wire_batch",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.route_wire_batch(
                    ctx.deps.snapshot,
                    routes=routes,
                ),
                tool_name="route_wire_batch",
            ),
        )

    @agent.tool
    async def disconnect_wire_batch(
        ctx: RunContext[AgentDeps],
        wire_ids: list[str],
    ) -> dict[str, Any]:
        """Remove multiple wires in ONE call. Use when rewiring or clearing connections.

        wire_ids: list of wire IDs to remove (from get_project_outline).
        All removals are atomic — if any wire_id is invalid, none are removed.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "disconnect_wire_batch",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.disconnect_wire_batch(
                    ctx.deps.snapshot,
                    wire_ids=wire_ids,
                ),
                tool_name="disconnect_wire_batch",
            ),
        )

    @agent.tool
    async def add_component_batch(
        ctx: RunContext[AgentDeps],
        components: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Add multiple components in ONE call instead of calling add_component N times.

        components: list of dicts, each with keys:
          - component_id (required — your chosen unique ID)
          - metadata_id (required — from search_component_catalog)
          - x (required)
          - y (required)
          - properties (optional dict)

        Example:
          add_component_batch(components=[
            {"component_id": "led1", "metadata_id": "wokwi-led", "x": 200, "y": 100, "properties": {"color": "red"}},
            {"component_id": "led2", "metadata_id": "wokwi-led", "x": 200, "y": 150, "properties": {"color": "green"}},
          ])

        All components are added atomically. After calling this, you MUST call
        get_canvas_runtime_pins_batch before wiring.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "add_component_batch",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.add_component_batch(
                    ctx.deps.snapshot,
                    components=components,
                ),
                tool_name="add_component_batch",
            ),
        )

    @agent.tool
    async def duplicate_component(
        ctx: RunContext[AgentDeps],
        source_id: str,
        new_id: str,
        x: float,
        y: float,
        property_overrides: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Clone an existing component to a new position.

        Copies the source component's metadataId and all properties, then places
        a new component at (x, y) with the given new_id.

        property_overrides: optional dict to change specific properties on the clone
        (e.g. {"color": "blue"} to change just the LED color).

        After calling this, you MUST call get_canvas_runtime_pins before wiring
        (the clone shares the same metadataId so batch is efficient).
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "duplicate_component",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.duplicate_component(
                    ctx.deps.snapshot,
                    source_id=source_id,
                    new_id=new_id,
                    x=x,
                    y=y,
                    property_overrides=property_overrides,
                ),
                tool_name="duplicate_component",
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
    async def patch_file_lines(
        ctx: RunContext[AgentDeps],
        group_id: str,
        file_name: str,
        start_line: int,
        end_line: int,
        replacement: str,
    ) -> dict[str, Any]:
        """Patch a range of lines in an existing file. Use for targeted fixes.

        Preferred over rewriting the whole file. Lines are 1-indexed.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "patch_file_lines",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.patch_file_lines(
                    ctx.deps.snapshot,
                    group_id=group_id,
                    file_name=file_name,
                    start_line=start_line,
                    end_line=end_line,
                    replacement=replacement,
                ),
                tool_name="patch_file_lines",
            ),
        )

    @agent.tool
    async def replace_file_content(
        ctx: RunContext[AgentDeps],
        group_id: str,
        file_name: str,
        content: str,
    ) -> dict[str, Any]:
        """Replace the entire file content in one operation."""
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "replace_file_content",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.replace_file_content(
                    ctx.deps.snapshot,
                    group_id=group_id,
                    file_name=file_name,
                    content=content,
                ),
                tool_name="replace_file_content",
            ),
        )

    @agent.tool
    async def apply_file_patch(
        ctx: RunContext[AgentDeps],
        group_id: str,
        file_name: str,
        original: str | None = None,
        modified: str | None = None,
        patch: str | None = None,
    ) -> dict[str, Any]:
        """Apply a file patch.

        Modes:
        1) Provide unified diff in `patch`.
        2) Provide `original` + `modified` full contents.
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
                    patch=patch,
                ),
                tool_name="apply_file_patch",
            ),
        )

    @agent.tool
    async def delete_file(
        ctx: RunContext[AgentDeps],
        group_id: str,
        file_name: str,
    ) -> dict[str, Any]:
        """Delete a file from a file group.

        group_id: the board's activeFileGroupId from get_project_outline.
        file_name: the file to remove (e.g. 'helpers.h').
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "delete_file",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.delete_file(
                    ctx.deps.snapshot,
                    group_id=group_id,
                    file_name=file_name,
                ),
                tool_name="delete_file",
            ),
        )

    @agent.tool
    async def rename_file(
        ctx: RunContext[AgentDeps],
        group_id: str,
        old_name: str,
        new_name: str,
    ) -> dict[str, Any]:
        """Rename a file within a file group.

        group_id: the board's activeFileGroupId from get_project_outline.
        old_name: current file name.
        new_name: desired new file name.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "rename_file",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.rename_file(
                    ctx.deps.snapshot,
                    group_id=group_id,
                    old_name=old_name,
                    new_name=new_name,
                ),
                tool_name="rename_file",
            ),
        )

    @agent.tool
    async def set_language_mode(
        ctx: RunContext[AgentDeps],
        board_id: str,
        language_mode: str,
    ) -> dict[str, Any]:
        """Switch a board between 'arduino' and 'micropython' language modes.

        board_id: existing board ID from get_project_outline.
        language_mode: 'arduino' or 'micropython'.
        After switching, update the file group contents to match the new language.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "set_language_mode",
            lambda: _apply_mutation(
                ctx,
                *snapshot_ops.set_language_mode(
                    ctx.deps.snapshot,
                    board_id=board_id,
                    language_mode=language_mode,
                ),
                tool_name="set_language_mode",
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

        async def _compile_action() -> dict[str, Any]:
            result = await _run_frontend_action(
                ctx,
                "compile",
                {"boardId": board_id} if board_id else {},
                timeout_ms=180000,
            )
            return _sanitize_hex_content(result)

        return await _safe_tool_call(
            ctx,
            "compile_in_frontend",
            _compile_action,
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
                "serial_monitor_open",
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
                "serial_monitor_close",
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
                "serial_monitor_status",
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
                "serial_set_baud_rate",
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
            lambda: _run_frontend_action(ctx, "serial_send", payload),
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
                "serial_clear",
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
            lambda: _run_frontend_action(ctx, "serial_capture", payload),
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
                "sim_run",
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
                "sim_pause",
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
                "sim_reset",
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
    async def get_simulation_status(ctx: RunContext[AgentDeps], board_id: str | None = None) -> dict[str, Any]:
        """Check whether a simulation is currently running, paused, or stopped.

        Returns: {running: bool, boardId: str, ...}
        Call this before run_simulation to avoid starting a duplicate,
        or after run_simulation to confirm it started successfully.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "get_simulation_status",
            lambda: _run_frontend_action(
                ctx,
                "sim_status",
                {"boardId": board_id} if board_id else {},
            ),
        )

    @agent.tool
    async def get_last_compile_result(ctx: RunContext[AgentDeps], board_id: str | None = None) -> dict[str, Any]:
        """Retrieve the result of the last compilation without recompiling.

        Returns the cached compile output (success/failure, error messages, warnings).
        Useful when the user says 'fix the error' — avoids a redundant recompile just
        to re-read the error log.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "get_last_compile_result",
            lambda: _run_frontend_action(
                ctx,
                "compile_last_result",
                {"boardId": board_id} if board_id else {},
            ),
        )

    @agent.tool
    async def suggest_placement(
        ctx: RunContext[AgentDeps],
        requests: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Ask the frontend to compute smart canvas positions for new components.

        Call this BEFORE add_component / add_component_batch so you never have
        to guess x/y coordinates.  The frontend reads the live DOM to measure
        board and existing component sizes, then packs new components into free
        slots adjacent to the correct board edge.

        requests: list of dicts, each with:
          - id (required)         — the component_id you plan to use
          - metadataId (required) — the catalog id (e.g. 'wokwi-led')
          - connectsToBoardPin (optional) — the board pin this component connects
            to (e.g. '21').  Used to choose the correct board edge so wires are
            short and clean.
          - preferSide (optional) — 'right' | 'left' | 'top' | 'bottom' to
            override automatic side selection.

        Returns:
          { placements: [{id, x, y, side}, ...] }

        Use the returned x, y values directly in add_component_batch.

        Example:
          suggest_placement(requests=[
            {"id": "oled1", "metadataId": "wokwi-ssd1306", "connectsToBoardPin": "21"},
            {"id": "res1",  "metadataId": "wokwi-resistor", "connectsToBoardPin": "13"},
          ])
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "suggest_placement",
            lambda: _run_frontend_action(
                ctx,
                "suggest_placement",
                {"requests": requests},
            ),
        )

    @agent.tool
    async def auto_route_wires(
        ctx: RunContext[AgentDeps],
        wire_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        """Ask the frontend to compute obstacle-avoiding waypoints for wires.

        Call this AFTER connect_pins_batch, passing the wire IDs just created.
        The frontend uses the live DOM pin positions (via pinInfo) and the
        existing obstacle router to generate clean, non-overlapping orthogonal
        paths.  You MUST then call route_wire_batch() with the returned routes.

        wire_ids: list of wire IDs to route.  Pass None or omit to route ALL
                  wires in the project (useful for a full re-route pass).

        Returns:
          { routes: [{wireId, waypoints: [{x, y}...], routed, reason?}, ...] }

        The `waypoints` list is in the exact format expected by route_wire_batch.
        An empty waypoints list means the wire already has a clean L-shape —
        you may still pass it to route_wire_batch with an empty list to clear
        any previously stored waypoints.

        Wires where routed=False have a `reason` explaining why (e.g. the
        component has not rendered yet).  Retry after a short wait_seconds(1).

        Example usage:
          # After connect_pins_batch returned wire ids ["wire-1", "wire-2"]:
          result = auto_route_wires(wire_ids=["wire-1", "wire-2"])
          routes = [{"wire_id": r["wireId"], "waypoints": r["waypoints"]}
                    for r in result["payload"]["routes"] if r["routed"]]
          route_wire_batch(routes=routes)
        """
        ctx.deps.guard_tool_call()
        payload: dict[str, Any] = {}
        if wire_ids is not None:
            payload["wireIds"] = wire_ids
        return await _safe_tool_call(
            ctx,
            "auto_route_wires",
            lambda: _run_frontend_action(ctx, "auto_route_wires", payload),
        )

    @agent.tool
    async def get_canvas_spatial_context(ctx: RunContext[AgentDeps]) -> dict[str, Any]:
        """Return a full spatial snapshot of the live canvas with real pixel data.

        Unlike get_project_outline (which returns abstract IDs and snapshot
        coordinates), this tool reads the actual rendered DOM to return:
          - boards: id, boardKind, x, y, width, height,
                    pins: [{name, canvasX, canvasY, side}]
          - components: id, metadataId, x, y, width, height,
                        pins: [{name, canvasX, canvasY, side}]
          - canvasBounds: minX, minY, maxX, maxY,
                          suggestedNextX, suggestedNextY

        Use this when you need to reason about where things actually are on the
        canvas — for example, to decide which side of the board has free space,
        or to understand why wires are crossing.

        Call get_project_outline() first for IDs; then call this for geometry.
        """
        ctx.deps.guard_tool_call()
        return await _safe_tool_call(
            ctx,
            "get_canvas_spatial_context",
            lambda: _run_frontend_action(ctx, "get_canvas_spatial_context", {}),
        )

    @agent.tool
    async def wait_for_serial_output(
        ctx: RunContext[AgentDeps],
        pattern: str,
        timeout_seconds: float = 10.0,
        board_id: str | None = None,
    ) -> dict[str, Any]:
        """Wait until serial output contains a specific pattern (substring match).

        pattern: text to search for in serial output (case-sensitive substring).
        timeout_seconds: max wait time (1-30s, default 10s).
        board_id: optional, defaults to active board.

        Returns: {matched: bool, output: str, elapsed_seconds: float}
        Use this instead of wait_seconds + capture_serial_monitor for reliable
        verification that firmware produced expected output.
        """
        ctx.deps.guard_tool_call()
        import time
        timeout_seconds = max(1.0, min(timeout_seconds, 30.0))
        start = time.monotonic()
        poll_interval = 0.5
        last_output = ""

        while True:
            elapsed = time.monotonic() - start
            if elapsed >= timeout_seconds:
                return {"matched": False, "output": last_output, "elapsed_seconds": round(elapsed, 2)}

            result = await _run_frontend_action(
                ctx,
                "serial_capture",
                {"maxLines": 200, **({"boardId": board_id} if board_id else {})},
            )
            output = ""
            if isinstance(result, dict):
                output = result.get("output", "") or result.get("text", "") or ""
            elif isinstance(result, str):
                output = result
            last_output = output

            if pattern in output:
                return {"matched": True, "output": output, "elapsed_seconds": round(time.monotonic() - start, 2)}

            await asyncio.sleep(poll_interval)

    @agent.tool
    async def wait_seconds(ctx: RunContext[AgentDeps], seconds: float = 1.0) -> dict[str, Any]:
        """Wait for a specified duration (0.1-10s). Useful between canvas operations."""
        ctx.deps.guard_tool_call()
        duration = max(0.1, min(seconds, 10.0))
        await asyncio.sleep(duration)
        return {"ok": True, "seconds": duration}

    @agent.tool
    async def announce_plan(
        ctx: RunContext[AgentDeps],
        title: str,
        description: str,
        steps: list[dict[str, str]],
    ) -> dict[str, Any]:
        """Announce a structured execution plan in the UI before starting a multi-step task.
        Blocks until the user approves, modifies, or cancels the plan.

        Call this ONCE as the very first tool call when the user's request requires 2 or more
        distinct actions (e.g., add components + wire + write firmware). Do NOT call it for
        simple questions, single-action requests, or clarifications.

        Args:
            title: Short plan title (e.g., "Build LED blink circuit").
            description: One-sentence summary of what will be done.
            steps: Ordered list of steps, each with "label" (short name) and
                   "description" (one sentence detail). Be specific — not generic boilerplate.

        Returns:
            {"approved": True} if user approved (possibly with modifications),
            {"approved": False, "reason": "cancelled"} if user cancelled.
            If the user provided a revised plan, the returned dict also contains
            "revised_steps" — use those instead of your original steps.
        """
        action_request = create_frontend_action_request(
            session_id=ctx.deps.session_id,
            action="plan.approval",
            payload={
                "title": title,
                "description": description,
                "steps": steps,
            },
        )
        await ctx.deps.emit_event(
            "plan.announced",
            {
                "title": title,
                "description": description,
                "steps": steps,
                "actionId": action_request.action_id,
            },
        )
        await ctx.deps.emit_event(
            "frontend.action.request",
            {
                "actionId": action_request.action_id,
                "action": "plan.approval",
                "payload": {"title": title, "description": description, "steps": steps},
            },
        )
        result = await wait_for_frontend_action_result(
            action_id=action_request.action_id,
            timeout_ms=300_000,  # 5 min — plenty of time for the user to review
        )
        if not result.ok:
            reason = result.error or "cancelled"
            await ctx.deps.emit_event("plan.rejected", {"reason": reason})
            return {"approved": False, "reason": reason}

        revised = result.payload.get("revised_steps")
        await ctx.deps.emit_event(
            "plan.approved",
            {"revised_steps": revised} if revised else {},
        )
        if revised:
            return {"approved": True, "revised_steps": revised}
        return {"approved": True}

    @agent.tool
    async def create_todo(
        ctx: RunContext[AgentDeps],
        items: list[dict[str, str]],
    ) -> dict[str, Any]:
        """Create a live todo list shown in the UI to track execution progress.

        Call this ONCE immediately after announce_plan() is approved, using the
        same steps from the plan. Do NOT call it for simple single-step tasks.

        Each item must have:
          - "id": unique short string (e.g. "step-1", "step-2")
          - "label": short task name shown in the UI
          - "description": optional one-sentence detail

        Args:
            items: Ordered list of todo items to track.
        """
        import uuid as _uuid
        run_id = _uuid.uuid4().hex
        todos = [
            {
                "id": it.get("id", f"todo-{i}"),
                "label": it.get("label", ""),
                "description": it.get("description", ""),
                "status": "pending",
            }
            for i, it in enumerate(items)
        ]
        await ctx.deps.emit_event(
            "todo.created",
            {"runId": run_id, "items": todos},
        )
        return {"ok": True, "runId": run_id, "count": len(todos)}

    @agent.tool
    async def update_todo(
        ctx: RunContext[AgentDeps],
        id: str,
        status: str,
    ) -> dict[str, Any]:
        """Update a todo item's status to reflect current execution progress.

        Call update_todo(id, "in_progress") before starting each step.
        Call update_todo(id, "done") after completing each step.
        Call update_todo(id, "skipped") if a step is intentionally skipped.

        Args:
            id: The todo item id from create_todo.
            status: One of "pending", "in_progress", "done", "skipped".
        """
        valid = {"pending", "in_progress", "done", "skipped"}
        if status not in valid:
            return {"ok": False, "error": f"Invalid status '{status}'. Must be one of {valid}"}
        await ctx.deps.emit_event(
            "todo.updated",
            {"id": id, "status": status},
        )
        return {"ok": True, "id": id, "status": status}

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
            resolved_model,
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


def _sanitize_hex_content(value: Any) -> Any:
    """Strip large hex blobs from agent-visible payloads to avoid token bloat."""
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            if key == "hex_content" and isinstance(item, str):
                sanitized[key] = f"<omitted hex_content ({len(item)} chars)>"
                sanitized["hex_content_omitted"] = True
                sanitized["hex_content_length"] = len(item)
            else:
                sanitized[str(key)] = _sanitize_hex_content(item)
        return sanitized
    if isinstance(value, list):
        return [_sanitize_hex_content(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_sanitize_hex_content(item) for item in value)
    return value


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
            if tool_name == "compile_in_frontend":
                tool_output = _sanitize_hex_content(tool_output)
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
