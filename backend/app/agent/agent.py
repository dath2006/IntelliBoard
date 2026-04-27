"""Velxio AI Agent - powered by Pydantic AI and OpenAI."""

import asyncio
import os
from datetime import datetime
from typing import Any, Awaitable, Callable, Optional

from pydantic_ai import Agent
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ThinkingPartDelta,
)
from pydantic_ai import RunContext
from dataclasses import dataclass
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field

from app.agent import tools
from app.agent.context import AgentMessage, ContextManager
from app.core.config import settings


_openai_env_lock = asyncio.Lock()


class ComponentDef(BaseModel):
    id: str = Field(description="Unique ID for the component (e.g., 'led1', 'uno')")
    type: str = Field(description="Wokwi element type (e.g., 'wokwi-led', 'wokwi-arduino-uno')")
    left: float = Field(default=0.0, description="X coordinate (optional)")
    top: float = Field(default=0.0, description="Y coordinate (optional)")
    rotate: int = Field(default=0, description="Rotation in degrees (optional)")
    attrs: dict[str, Any] = Field(default_factory=dict, description="Component attributes (e.g., {'color': 'red'})")


class ConnectionDef(BaseModel):
    from_part: str = Field(description="ID of the source component")
    from_pin: str = Field(description="Pin name on the source component")
    to_part: str = Field(description="ID of the target component")
    to_pin: str = Field(description="Pin name on the target component")
    color: str = Field(default="green", description="Wire color (optional)")


class CircuitOperationDef(BaseModel):
    op: str = Field(
        description="Operation kind: add_component, remove_component, move_component, update_component_attrs, connect, disconnect"
    )
    component: Optional[dict[str, Any]] = Field(default=None, description="For add_component")
    id: Optional[str] = Field(default=None, description="Component ID for remove/move/update")
    component_id: Optional[str] = Field(default=None, description="Alternative component ID key")
    left: Optional[float] = Field(default=None, description="Absolute X for move_component")
    top: Optional[float] = Field(default=None, description="Absolute Y for move_component")
    dx: Optional[float] = Field(default=None, description="Delta X for move_component")
    dy: Optional[float] = Field(default=None, description="Delta Y for move_component")
    rotate: Optional[int] = Field(default=None, description="Optional rotation update")
    attrs: Optional[dict[str, Any]] = Field(default=None, description="For update_component_attrs")
    from_part: Optional[str] = Field(default=None, description="From component ID for connect/disconnect")
    from_pin: Optional[str] = Field(default=None, description="From pin for connect/disconnect")
    to_part: Optional[str] = Field(default=None, description="To component ID for connect/disconnect")
    to_pin: Optional[str] = Field(default=None, description="To pin for connect/disconnect")
    color: Optional[str] = Field(default=None, description="Optional wire color for connect")


class CodeFileDef(BaseModel):
    name: str = Field(description="File name, e.g. sketch.ino or sensors.h")
    content: str = Field(description="Complete file content")


class SimulationControlDef(BaseModel):
    action: str = Field(
        description="Action to execute: compile, run, start, stop, reset, open_terminal, close_terminal, toggle_terminal, send_terminal_input, read_serial_monitor"
    )
    board_id: Optional[str] = Field(default=None, description="Optional target board id")
    ensure_compiled: bool = Field(default=False, description="Compile before start/run")
    serial_input: Optional[str] = Field(default=None, description="Terminal/serial text to send")


@dataclass
class AgentDependencies:
    session_id: str
    db_session: AsyncSession
    current_circuit: dict[str, Any]
    active_code: dict[str, str]
    serial_output: Optional[str] = None


AGENT_INSTRUCTIONS = """You are Velxio, an expert embedded systems AI assistant. Your goal is to help users build Arduino and embedded system circuits through natural language descriptions.

## Your Capabilities:
1. **Circuit Design**: Create circuits with components (LEDs, buttons, sensors, displays, etc.)
2. **Code Generation**: Generate Arduino code with proper initialization and control logic
3. **Validation**: Check for electrical issues (pin conflicts, power budget, voltage domains)
4. **Optimization**: Suggest resistor values, capacitors, and component improvements
5. **Debugging**: Fix compilation errors and runtime issues
6. **Explanation**: Teach users about electronics and best practices

## Work Process:
1. **Understand Requirements**: Ask clarifying questions if needed
2. **Inspect Current State**: Use `get_circuit_topology` to see the current circuit design.
3. **Research Components**: Use `search_components_db` to find suitable parts and `get_component_details` to verify exact pin names before wiring. **Never guess pin names!**
4. **Design Circuit**: Use `create_circuit` tool to build the circuit structure. For incremental updates, use `apply_circuit_modification` with **structured operations JSON**, not plain prose.
5. **Generate/Edit Code**: Use `generate_code_files` for initial sketches. For edits to existing files, use `apply_code_modification` with explicit file content.
6. **Validate Design**: Use `validate_circuit` to check for issues
7. **Optimize**: Use `optimize_circuit` for improvements
8. **Compile & Test**: Use `compile_current_code` or `compile_code` to verify code works and inspect stdout/stderr
9. **Explain**: Always explain what you did and why
10. **Runtime Control**: Use `control_simulation` to request run/stop/reset/terminal actions, and `get_serial_monitor_output` for current serial logs.

## Canvas Coordinate System (CRITICAL — read carefully):
The canvas is a 2D plane where components are placed using `left` (X) and `top` (Y) pixel coordinates.
- **Arduino Uno board** is approximately 220px wide × 320px tall. Leave it at left=0, top=0 (or existing position from `get_circuit_topology`).
- **All other components** must be placed to the RIGHT of the board. Start at approximately left=280.
- **Component approximate sizes** (width × height in px):
  - wokwi-led: 30 × 60  |  wokwi-resistor: 80 × 20  |  wokwi-button: 50 × 50
  - wokwi-buzzer: 60 × 60  |  wokwi-dht22: 60 × 90  |  wokwi-lcd1602: 160 × 60
  - wokwi-servo: 80 × 60  |  wokwi-7segment: 60 × 80  |  wokwi-bmp280: 60 × 60
- **Layout rules (MANDATORY)**:
  1. **NEVER place two components at the same (left, top)** — every component must have a unique position.
  2. For **N identical components in a row** (e.g. "4 LEDs in a row"): place them HORIZONTALLY with ~70-100px horizontal spacing.
     - Example — 4 LEDs in a row: left=[280, 360, 440, 520], top=80 for all.
  3. For **paired accessories** (e.g. resistor per LED): place them directly BELOW their parent with top+70 offset.
  4. For **mixed component types**: group by type — each type in its own horizontal row. Increment top by ~100px between type rows.
  5. Leave at least 50px gap between any two components.

## Circuit Design Principles:
- Always include proper pull-up/pull-down resistors for digital inputs
- Calculate current-limiting resistors for LEDs (using forward voltage + desired current)
- Add decoupling capacitors near power pins
- Properly map pins to Arduino board variants
- Consider power budget (total mA drawn vs supply)
- Keep digital and analog grounds separate when possible

## Code Best Practices:
- Always include necessary headers (#include <Wire.h> for I2C, etc.)
- Use meaningful variable names
- Add comments explaining the logic
- Initialize Serial at 115200 baud for debugging
- Use proper pin constants (e.g., LED_PIN = 13)
- Handle initialization errors gracefully
- When user asks to edit code, always call `get_code_files` first, then call `apply_code_modification` to persist changes.
- When user asks to run/stop simulation or use terminal input, call `control_simulation` with an explicit action.

## Board Variants You Support:
- **Arduino AVR**: arduino-uno (arduino:avr:uno), arduino-nano (arduino:avr:nano), arduino-mega (arduino:avr:mega), attiny85
- **RP2040**: raspberry-pi-pico (rp2040:rp2040:rpipico), pi-pico-w (rp2040:rp2040:rpipicow)
- **ESP32 Xtensa**: esp32 (esp32:esp32:esp32), esp32-devkit-c-v4, esp32-cam, wemos-lolin32-lite, esp32-s3, xiao-esp32-s3, arduino-nano-esp32
- **ESP32 RISC-V**: esp32-c3, xiao-esp32-c3, aitewinrobot-esp32c3-supermini
- **Linux SBC**: raspberry-pi-3 (ARM64, QEMU, Python)

## New / Empty Projects:
When the user opens a brand-new project (no components, no code), your first action should be:
1. **Ask** what they want to build (if they haven't said).
2. **Set board FQBN** in `create_circuit` matching the project's `board_type` field from `current_circuit.board_fqbn`.
3. **Build the full circuit** — components, connections, then code — in a single agent turn so the canvas isn't left in a half-built state.

## Board Connections — CRITICAL Rules:

### 1. Use `board_id` from `get_circuit_topology` as the part ID for ALL board connections
Always call `get_circuit_topology` first. It returns a `board_id` field (e.g. `"esp32"`, `"arduino-uno"`).
Use that **exact** string as `from_part` / `to_part` when connecting to the board.
- ✅ `"from_part": "esp32"` (from board_id)
- ❌ `"from_part": "esp32-devkit-v1"` or `"from_part": "board"` — these may not match

### 2. ESP32 DevKit V1 Pin Names (CRITICAL — wrong format = wires don't connect)
This project uses the **wokwi-esp32-devkit-v1** element. Pin names use the **D-prefix**:
| Signal | Correct pin name | Wrong (do NOT use) |
|--------|------------------|--------------------||
| GPIO 2 | `"D2"` | `"IO2"`, `"GPIO2"`, `"2"` |
| GPIO 4 | `"D4"` | `"IO4"`, `"GPIO4"`, `"4"` |
| GPIO 5 | `"D5"` | `"IO5"`, `"GPIO5"`, `"5"` |
| GPIO 12 | `"D12"` | `"IO12"`, `"12"` |
| GPIO 13 | `"D13"` | `"IO13"`, `"13"` |
| GPIO 14 | `"D14"` | `"IO14"`, `"14"` |
| GPIO 18 | `"D18"` | `"IO18"`, `"18"` |
| GPIO 19 | `"D19"` | `"IO19"`, `"19"` |
| GPIO 21 | `"D21"` | `"IO21"`, `"21"` |
| GPIO 22 | `"D22"` | `"IO22"`, `"22"` |
| GPIO 23 | `"D23"` | `"IO23"`, `"23"` |
| GPIO 25 | `"D25"` | `"IO25"`, `"25"` |
| GPIO 26 | `"D26"` | `"IO26"`, `"26"` |
| GPIO 27 | `"D27"` | `"IO27"`, `"27"` |
| GPIO 32 | `"D32"` | `"IO32"`, `"32"` |
| GPIO 33 | `"D33"` | `"IO33"`, `"33"` |
| Ground | `"GND.1"` or `"GND.2"` | `"GND"` |
| 3.3V | `"3V3"` | `"3.3V"` |
| 5V/VIN | `"VIN"` | `"5V"`, `"V5"` |
| VP/ADC | `"VP"` | `"GPIO36"`, `"IO36"` |
| VN/ADC | `"VN"` | `"GPIO39"`, `"IO39"` |

**Available ESP32 digital I/O pins:** D2, D4, D5, D12, D13, D14, D15, D18, D19, D21, D22, D23, D25, D26, D27, D32, D33

### 3. Arduino Pin Names
- Digital: `"D2"` through `"D13"` (or bare `"2"` through `"13"`)
- Analog: `"A0"` through `"A5"`
- Power: `"GND.1"`, `"GND.2"`, `"5V"`, `"3.3V"`, `"VIN"`

### 4. Raspberry Pi Pico Pin Names
- GPIO: `"GP0"` through `"GP28"`
- Power: `"GND"`, `"3V3"`, `"VBUS"`

## Board Type Switching (CRITICAL):
When the user asks to use a **different board** (e.g., "use ESP32 instead of Arduino"):
1. **ALWAYS** call `create_circuit` with the correct `board_fqbn` for the NEW board. This is the ONLY way to switch the board on the canvas.
   - Arduino Uno → `arduino:avr:uno`
   - Arduino Nano → `arduino:avr:nano:cpu=atmega328`
   - Arduino Mega → `arduino:avr:mega`
   - ESP32 → `esp32:esp32:esp32`
   - ESP32-S3 → `esp32:esp32:esp32s3`
   - ESP32-C3 → `esp32:esp32:esp32c3`
   - Raspberry Pi Pico → `rp2040:rp2040:rpipico`
2. The `board_fqbn` field in `create_circuit` REPLACES the existing board — do NOT add the old board as a component.
3. Do NOT include any board/microcontroller in the `components` list — only peripheral components (LEDs, sensors, resistors, etc.).
4. After creating the circuit with the new board, always regenerate the code with `generate_code_files` using the new board's pin conventions.

Be concise but helpful. Always verify your circuit designs and code before presenting to users.
"""

def create_velxio_agent() -> Agent[AgentDependencies, str]:
    """Create and configure the Velxio AI agent."""
    agent = Agent(
        model=settings.AGENT_MODEL,
        instructions=AGENT_INSTRUCTIONS,
    )

    # Use tool_plain because these tools do not need RunContext.
    @agent.tool_plain
    async def create_circuit(
        components: list[ComponentDef] = None,
        connections: list[ConnectionDef] = None,
        board_fqbn: str = "arduino:avr:uno"
    ) -> dict[str, Any]:
        """Create a circuit with components and connections.
        
        Args:
            components: List of components to add.
            connections: List of wiring connections.
            board_fqbn: Target board (arduino:avr:uno, rp2040:rp2040:rpipico, esp32:esp32:esp32)
        """
        components_dict = [c.model_dump() for c in (components or [])]
        connections_dict = [c.model_dump() for c in (connections or [])]
        return await tools.create_circuit(components_dict, connections_dict, board_fqbn)

    @agent.tool
    async def validate_circuit(
        ctx: RunContext[AgentDependencies],
        board_variant: str = "arduino:avr:uno"
    ) -> dict[str, Any]:
        """Validate circuit for electrical and compatibility issues.
        
        Checks:
        - Pin conflicts (same pin wired twice)
        - Voltage domain mismatches
        - Power budget (total mA)
        - Component compatibility
        """
        result = await tools.validate_circuit(ctx.deps.current_circuit, board_variant)
        return {
            "is_valid": result.is_valid,
            "errors": result.errors,
            "warnings": result.warnings,
            "pin_conflicts": result.pin_conflicts,
            "power_budget_mA": result.power_budget_mA
        }

    @agent.tool
    async def optimize_circuit(
        ctx: RunContext[AgentDependencies],
        components_metadata: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        """Get optimization suggestions for the circuit.
        
        Suggests:
        - Resistor values for LEDs
        - Pull-up/pull-down resistors
        - Decoupling capacitors
        - Component swaps
        """
        result = await tools.optimize_circuit(ctx.deps.current_circuit, components_metadata)
        return {
            "suggestions": result.suggestions,
            "power_optimization": result.power_optimization,
            "layout_tips": result.layout_tips
        }

    @agent.tool
    async def generate_code_files(
        ctx: RunContext[AgentDependencies],
        sketch_name: str = "sketch"
    ) -> dict[str, Any]:
        """Generate Arduino starter code from circuit.
        
        Returns:
        - List of code files with proper includes and initialization
        - Board FQBN
        """
        return await tools.generate_code_files(ctx.deps.current_circuit, sketch_name=sketch_name)

    @agent.tool
    async def apply_code_modification(
        ctx: RunContext[AgentDependencies],
        files: list[CodeFileDef],
        replace_all: bool = False,
    ) -> dict[str, Any]:
        """Apply direct file edits to the active code workspace.

        Use this after `get_code_files` when the user asks for code changes.
        - `files`: full file contents for files to create/update
        - `replace_all`: if true, remove unspecified files
        """
        payload = [f.model_dump() for f in files]
        return await tools.apply_code_modification(
            active_code=ctx.deps.active_code,
            files=payload,
            replace_all=replace_all,
        )

    @agent.tool
    async def debug_code(
        ctx: RunContext[AgentDependencies],
        compilation_error: Optional[str] = None,
        serial_output: Optional[str] = None
    ) -> dict[str, Any]:
        """Debug code for compilation or runtime errors.
        
        Analyzes:
        - Compiler error messages
        - Serial monitor output
        - Code-circuit mismatches
        """
        code = "\n".join(ctx.deps.active_code.values())
        result = await tools.debug_code(code, ctx.deps.current_circuit, compilation_error, serial_output)
        return {
            "issue_type": result.issue_type,
            "severity": result.severity,
            "explanation": result.explanation,
            "code_fix": result.code_fix,
            "why_it_works": result.why_it_works
        }

    @agent.tool
    async def fix_errors(
        ctx: RunContext[AgentDependencies],
        error_type: str
    ) -> dict[str, Any]:
        """Auto-fix common code errors.
        
        Fixes:
        - Missing includes
        - Undefined variables
        - Wrong pin numbers
        - Syntax errors
        - Logic errors
        """
        code = "\n".join(ctx.deps.active_code.values())
        return await tools.fix_errors(code, error_type, ctx.deps.current_circuit)

    @agent.tool
    async def analyze_serial_logs(
        ctx: RunContext[AgentDependencies],
        serial_output: str
    ) -> dict[str, Any]:
        """Analyze serial monitor output for patterns and issues.
        
        Detects:
        - Sensor failures (NaN, "not found")
        - Communication timeouts
        - Baud rate mismatches
        - Timing issues
        """
        code = "\n".join(ctx.deps.active_code.values())
        result = await tools.analyze_serial_logs(serial_output, ctx.deps.current_circuit, code)
        return {
            "observations": result.observations,
            "likely_issues": result.likely_issues,
            "suggestions": result.suggestions,
            "is_working": result.is_working
        }

    @agent.tool_plain
    async def suggest_components(
        requirements: str,
        constraints: Optional[dict[str, Any]] = None
    ) -> list[dict[str, Any]]:
        """Suggest components based on requirements.
        
        Uses RAG knowledge base to find best components.
        
        Args:
            requirements: Natural language (e.g., "temperature sensor with I2C")
            constraints: Optional {power_supply: "3.3V", max_cost: 5, interface: "I2C"}
        
        Returns:
            Top-5 components with relevance scores and explanations
        """
        suggestions = await tools.suggest_components(requirements, constraints)
        return [
            {
                "component_type": s.component_type,
                "part_name": s.part_name,
                "relevance_score": s.relevance_score,
                "why_good": s.why_good,
                "pinout_info": s.pinout_info
            }
            for s in suggestions
        ]

    @agent.tool_plain
    async def compile_code(
        files: list[dict[str, str]],
        board: str = "arduino:avr:uno"
    ) -> dict[str, Any]:
        """Compile code files for the requested board."""
        return await tools.compile_code(files, board)

    @agent.tool
    async def compile_current_code(
        ctx: RunContext[AgentDependencies],
        board: Optional[str] = None,
    ) -> dict[str, Any]:
        """Compile the current project code files and return compiler outputs."""
        files = [
            {"name": name, "content": content}
            for name, content in sorted(ctx.deps.active_code.items())
        ]
        if not files:
            return {
                "success": False,
                "hex_content": None,
                "binary_content": None,
                "binary_type": None,
                "stdout": "",
                "stderr": "",
                "error": "No active code files found to compile.",
            }

        target_board = board or str(ctx.deps.current_circuit.get("board_fqbn") or "arduino:avr:uno")
        return await tools.compile_code(files, target_board)

    @agent.tool
    async def get_serial_monitor_output(
        ctx: RunContext[AgentDependencies],
        max_chars: int = 2000,
    ) -> dict[str, Any]:
        """Get current serial monitor output tail from runtime context."""
        text = ctx.deps.serial_output or ""
        safe_max = max(200, min(int(max_chars), 20000))
        tail = text[-safe_max:] if text else ""
        return {
            "serial_output": tail,
            "chars": len(tail),
            "has_data": bool(tail.strip()),
        }

    @agent.tool
    async def control_simulation(
        ctx: RunContext[AgentDependencies],
        control: SimulationControlDef,
    ) -> dict[str, Any]:
        """Request runtime actions (compile/run/stop/reset/terminal/serial)."""
        return await tools.control_simulation_action(
            action=control.action,
            board_id=control.board_id,
            ensure_compiled=control.ensure_compiled,
            serial_input=control.serial_input,
            board_fqbn=str(ctx.deps.current_circuit.get("board_fqbn") or "arduino:avr:uno"),
        )

    @agent.tool
    async def export_wokwi_json(ctx: RunContext[AgentDependencies]) -> dict[str, Any]:
        """Export the Velxio circuit to Wokwi diagram.json format."""
        return await tools.export_wokwi_json(ctx.deps.current_circuit)

    @agent.tool_plain
    async def import_wokwi_json(diagram_json: dict[str, Any]) -> dict[str, Any]:
        """Import Wokwi diagram.json content into Velxio circuit format."""
        return await tools.import_wokwi_json(diagram_json)

    @agent.tool
    async def get_circuit_recommendations(ctx: RunContext[AgentDependencies]) -> dict[str, Any]:
        """Suggest circuit improvements and next steps."""
        return await tools.get_circuit_recommendations(ctx.deps.current_circuit)

    @agent.tool
    async def apply_circuit_modification(
        ctx: RunContext[AgentDependencies],
        operations: Optional[list[CircuitOperationDef]] = None,
        modification: Optional[str] = None
    ) -> dict[str, Any]:
        """Apply robust circuit modifications via operation objects.

        Preferred usage:
        - Provide `operations` as structured edits.
        Backward compatibility:
        - `modification` text is accepted, but less reliable.
        """
        payload: dict[str, Any] = {}
        if operations:
            payload["operations"] = [op.model_dump(exclude_none=True) for op in operations]
        if modification:
            payload["modification"] = modification

        if not payload:
            return {
                "modified_circuit": ctx.deps.current_circuit,
                "changes": [],
                "warnings": [
                    "No operations provided. Supply structured operations for robust updates."
                ],
                "errors": [],
            }

        return await tools.apply_circuit_modification(ctx.deps.current_circuit, payload)

    @agent.tool
    async def get_circuit_topology(ctx: RunContext[AgentDependencies]) -> dict[str, Any]:
        """Get a lightweight, token-efficient summary of the current circuit topology. Always use this to inspect the circuit before modifying it!"""
        return tools.get_circuit_topology(ctx.deps.current_circuit)

    @agent.tool
    async def get_code_files(ctx: RunContext[AgentDependencies]) -> dict[str, str]:
        """Get the contents of the current code files in the project. Always use this to inspect existing code before generating new code or suggesting changes."""
        return ctx.deps.active_code

    @agent.tool_plain
    async def get_component_details(component_type: str) -> dict[str, Any]:
        """Get full pinout and property metadata for a specific wokwi component type (e.g. 'wokwi-arduino-uno'). Use this before wiring to verify pin names."""
        details = await tools.get_component_details(component_type)
        return details if details else {"error": "Component not found"}

    @agent.tool_plain
    async def search_components_db(query: str, limit: int = 5) -> list[dict[str, Any]]:
        """Search the component database for parts matching a natural language query."""
        return await tools.search_components_db(query, limit)

    return agent


async def get_velxio_agent(api_key: str) -> Agent[None, str]:
    """Create a fresh agent instance for each request/session with isolated API key scope."""
    async with _openai_env_lock:
        prev_key = os.environ.get("OPENAI_API_KEY")
        prev_base = os.environ.get("OPENAI_BASE_URL")
        
        os.environ["OPENAI_API_KEY"] = api_key
        if settings.OPENAI_BASE_URL:
            os.environ["OPENAI_BASE_URL"] = settings.OPENAI_BASE_URL
            
        try:
            return create_velxio_agent()
        finally:
            if prev_key is None:
                os.environ.pop("OPENAI_API_KEY", None)
            else:
                os.environ["OPENAI_API_KEY"] = prev_key
                
            if prev_base is None:
                os.environ.pop("OPENAI_BASE_URL", None)
            else:
                os.environ["OPENAI_BASE_URL"] = prev_base


# ============================================================================
# Agent Chat Interface
# ============================================================================

async def agent_chat(
    agent: Agent[None, str],
    db_session: AsyncSession,
    session_id: str,
    user_prompt: str,
    include_serial_logs: bool = False,
    serial_output: Optional[str] = None,
    emit_event: Optional[Callable[[dict[str, Any]], Awaitable[None]]] = None,
) -> dict[str, Any]:
    """Run agent chat with streaming support.
    
    Args:
        agent: Configured Pydantic AI agent
        db_session: Database session for context persistence
        session_id: Agent session ID
        user_prompt: User's natural language input
        include_serial_logs: Whether to include serial output in context
        serial_output: Optional serial monitor output
    
    Returns:
        Dict with response text and artifact payload for persistence.
    """
    context_mgr = ContextManager(db_session)
    
    # Load conversation history
    context = await context_mgr.load_session(session_id)
    conversation_history = await context_mgr.get_context_window(session_id, max_messages=20)
    
    # Build context message for agent
    history_snippet = "\n".join(
        f"{msg.role}: {msg.content}" for msg in conversation_history[-8:]
    )
    context_info = f"""
Current Project State:
- Board: {context.current_circuit.get('board_fqbn', 'arduino:avr:uno')}
- Note: The circuit may have components. Use the `get_circuit_topology` tool to see the current state.
- Note: There are {len(context.active_code)} active code files. Use the `get_code_files` tool to see their contents.

Recent conversation:
{history_snippet if history_snippet else '(none)'}
"""
    
    if include_serial_logs and serial_output:
        context_info += f"\nSerial Monitor Output:\n{serial_output}\n"
    
    # Build full prompt
    full_prompt = f"{context_info}\nUser: {user_prompt}"

    def _event_payload(event: dict[str, Any]) -> dict[str, Any]:
        return event

    # Run agent
    try:
        response_chunks: list[str] = []
        thinking_chunks: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        tool_results: list[dict[str, Any]] = []

        async def on_stream_event(_ctx: Any, events: Any) -> None:
            async for event in events:
                if isinstance(event, FunctionToolCallEvent):
                    part = event.part
                    tool_event = {
                        "type": "tool_call",
                        "content": f"Calling {part.tool_name}...",
                        "tool_call": {
                            "tool_name": part.tool_name,
                            "tool_call_id": part.tool_call_id,
                            "args": part.args,
                        },
                    }
                    tool_calls.append(tool_event["tool_call"])
                    if emit_event:
                        await emit_event(_event_payload(tool_event))

                elif isinstance(event, FunctionToolResultEvent):
                    result_part = event.result
                    result_tool_name = getattr(result_part, "tool_name", "")
                    result_tool_call_id = getattr(result_part, "tool_call_id", "")
                    result_tool_content = getattr(result_part, "content", None)
                    tool_result_event = {
                        "type": "tool_result",
                        "content": f"{result_tool_name} completed.",
                        "tool_result": {
                            "tool_name": result_tool_name,
                            "tool_call_id": result_tool_call_id,
                            "content": result_tool_content,
                        },
                    }
                    tool_results.append(tool_result_event["tool_result"])
                    if emit_event:
                        await emit_event(_event_payload(tool_result_event))

                elif isinstance(event, PartStartEvent):
                    part = event.part
                    if isinstance(part, ThinkingPart) and part.content:
                        thinking_chunks.append(part.content)
                        if emit_event:
                            await emit_event(
                                _event_payload(
                                    {
                                        "type": "thinking",
                                        "content": part.content,
                                    }
                                )
                            )
                    elif isinstance(part, TextPart) and part.content:
                        response_chunks.append(part.content)
                        if emit_event:
                            await emit_event(
                                _event_payload(
                                    {
                                        "type": "response_chunk",
                                        "content": part.content,
                                    }
                                )
                            )

                elif isinstance(event, PartDeltaEvent):
                    delta = event.delta
                    if isinstance(delta, ThinkingPartDelta) and delta.content_delta:
                        thinking_chunks.append(delta.content_delta)
                        if emit_event:
                            await emit_event(
                                _event_payload(
                                    {
                                        "type": "thinking",
                                        "content": delta.content_delta,
                                    }
                                )
                            )
                    elif isinstance(delta, TextPartDelta) and delta.content_delta:
                        response_chunks.append(delta.content_delta)
                        if emit_event:
                            await emit_event(
                                _event_payload(
                                    {
                                        "type": "response_chunk",
                                        "content": delta.content_delta,
                                    }
                                )
                            )

        run_kwargs: dict[str, Any] = {
            "deps": AgentDependencies(
                session_id=session_id,
                db_session=db_session,
                current_circuit=context.current_circuit,
                active_code=context.active_code,
                serial_output=serial_output if include_serial_logs else None,
            ),
            "event_stream_handler": on_stream_event,
        }
        result = await agent.run(full_prompt, **run_kwargs)
        output = getattr(result, "output", None)
        if output is None:
            output = getattr(result, "data", "")
        response_text = str(output).strip()
        if not response_text and response_chunks:
            response_text = "".join(response_chunks).strip()

        artifacts: dict[str, Any] = {}
        for tool_result in tool_results:
            tool_name = tool_result.get("tool_name")
            content = tool_result.get("content")
            if not tool_name or not isinstance(content, dict):
                continue

            if tool_name in {"create_circuit", "apply_circuit_modification", "import_wokwi_json"}:
                if tool_name == "create_circuit":
                    artifacts["circuit_changes"] = content
                elif tool_name == "apply_circuit_modification":
                    artifacts["circuit_changes"] = content.get("modified_circuit", {})
                elif tool_name == "import_wokwi_json":
                    artifacts["circuit_changes"] = content

            if tool_name in {"generate_code_files", "fix_errors", "apply_code_modification"}:
                if tool_name == "generate_code_files":
                    artifacts["code_changes"] = content.get("files", [])
                elif tool_name == "fix_errors":
                    artifacts["code_changes"] = [{
                        "name": "sketch.ino",
                        "content": content.get("fixed_code", ""),
                    }]
                elif tool_name == "apply_code_modification":
                    artifacts["code_changes"] = content.get("files", [])

            if tool_name in {"compile_code", "compile_current_code"}:
                artifacts["compile_result"] = content

            if tool_name == "control_simulation":
                artifacts["simulation_action"] = content

            if tool_name == "get_serial_monitor_output":
                artifacts["serial_snapshot"] = content

        if artifacts.get("circuit_changes"):
            await context_mgr.update_circuit_state(session_id, artifacts["circuit_changes"])

        if artifacts.get("code_changes"):
            code_snapshot = {
                f.get("name", f"file-{idx}"): f.get("content", "")
                for idx, f in enumerate(artifacts["code_changes"])
                if isinstance(f, dict)
            }
            await context_mgr.update_code_state(session_id, code_snapshot)
        
        await context_mgr.append_message(
            session_id,
            AgentMessage(
                role="user",
                content=user_prompt,
                timestamp=datetime.utcnow(),
                tool_calls=None,
                artifacts=None,
                status="sent",
            ),
        )
        await context_mgr.append_message(
            session_id,
            AgentMessage(
                role="assistant",
                content=response_text,
                timestamp=datetime.utcnow(),
                tool_calls=[tc.get("tool_name", "") for tc in tool_calls] or None,
                artifacts=artifacts or None,
                status="received",
            ),
        )
        await db_session.flush()

        return {
            "response_text": response_text,
            "artifacts": artifacts,
        }
    except Exception as e:
        return {
            "error": f"Agent error: {str(e)}",
        }
