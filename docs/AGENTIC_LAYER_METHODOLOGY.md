# IntelliBoard Agentic Layer Methodology

## Overview

The IntelliBoard agentic layer is an autonomous embedded hardware engineering agent that designs circuits, writes firmware, compiles, debugs, and simulates directly on the IntelliBoard canvas. It is built on **Pydantic AI** with a structured methodology emphasizing **operation-based mutations**, **deterministic safety**, and **streaming observability**.

---

## Core Architectural Principles

### 1. Operation-Based Mutation Model

The agent follows a strict **operation-based** (rather than state-based) mutation methodology:

```
Traditional approach: Agent generates full JSON → replaces entire state
IntelliBoard approach: Agent calls granular tools → each tool performs single operation
```

**Rationale:**
- Prevents accidental destruction of user work
- Enables precise conflict detection
- Supports streaming granular updates to the UI
- Allows event replay for debugging

**Key Files:**
- `@backend/app/agent/snapshot_ops.py` — All mutation operations
- `@backend/app/agent/tools.py` — Tool implementations

### 2. Snapshot Authority with Draft Pattern

The system maintains a **dual-snapshot** methodology:

| Snapshot | Purpose | Persistence |
|----------|---------|-------------|
| `base_snapshot` | Original project state at session start | Immutable reference |
| `draft_snapshot` | Accumulated agent mutations | Live, streamed to frontend |

**Flow:**
```
Session Start: base = current_project, draft = base
Agent Runs:    draft = mutation(draft) after each tool call
User Applies:  project = draft, base = null
User Discards: draft = base, session ends
```

**Key File:** `@backend/app/agent/sessions.py`

### 3. Event-Driven Observability

Every significant action emits a **structured event** for SSE streaming:

```
Run Lifecycle:     session.created → run.started → run.completed/failed/cancelled
Tool Execution:    tool.call.started → tool.call.result
Model Streaming:   model.output.delta (aggregated) → model.output.final
State Changes:     snapshot.updated (with changed entity IDs)
```

**Event Schema:** `@backend/app/agent/schemas.py:209-215`

---

## Agent Runtime Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AGENT RUNTIME                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │   Pydantic   │───▶│  Agent Core  │───▶│   Tool Set   │                   │
│  │    Agent     │    │  (agent.py) │    │  (tools.py)  │                   │
│  └──────────────┘    └──────┬───────┘    └──────┬───────┘                   │
│                             │                    │                          │
│                             ▼                    ▼                          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │ AgentDeps    │◀───│   Session    │───▶│  SnapshotOps │                   │
│  │  (Context)   │    │  Management  │    │  (Mutation)  │                   │
│  └──────────────┘    └──────────────┘    └──────────────┘                   │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │   Database   │    │   Frontend   │    │  Validation  │                   │
│  │   (Async)    │    │   Actions    │    │  (Safety)    │                   │
│  └──────────────┘    └──────────────┘    └──────────────┘                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Agent Initialization Flow

```python
# @backend/app/agent/agent.py:94-386

def build_agent(model_name, defer_model_check=False) -> Agent[AgentDeps, str]:
    # 1. Define comprehensive instructions (system prompt)
    instructions = "..."  # 9 sections covering all methodologies
    
    # 2. Configure model with built-in tools (WebSearch for OpenAI)
    agent = Agent(
        model,
        deps_type=AgentDeps,
        instructions=instructions,
        defer_model_check=defer_model_check,
        builtin_tools=[WebSearchTool()] if openai else [],
    )
    
    # 3. Register all tool functions with @agent.tool decorator
    @agent.tool
    async def get_project_outline(ctx: RunContext[AgentDeps]) -> dict:
        ...
    
    # 4. Return configured agent instance
    return agent
```

### Contextual Prompt Building

To maintain conversation continuity across independent model runs:

```python
# @backend/app/agent/agent.py:58-91

async def _build_contextual_prompt(db, session_id, message) -> str:
    # 1. Replay event history
    events = await replay_events(db, session_id=session_id, after_seq=0)
    
    # 2. Extract message.turns from session history
    turns = []
    for event in events:
        if event.event_type == "message.received":
            turns.append(("user", payload["message"]))
        elif event.event_type == "run.completed":
            turns.append(("assistant", payload["output"]))
    
    # 3. Format as conversation history + latest message
    return "\n".join([
        "Conversation history (most recent turns):",
        *[f"{role.upper()}: {text}" for role, text in turns[-12:]],
        "",
        "Latest user message:",
        message
    ])
```

---

## Tool Methodology

### Tool Categories

The agent exposes **40+ tools** organized into categories:

| Category | Tools | Purpose |
|----------|-------|---------|
| **Context** | `get_project_outline`, `get_component_detail`, `list_files`, `read_file` | Read current state |
| **Discovery** | `search_component_catalog`, `get_full_component_catalog`, `get_component_schema` | Find components |
| **Canvas** | `add_board`, `add_component`, `move_component`, `remove_component` | Physical layout |
| **Wiring** | `connect_pins`, `disconnect_wire`, `route_wire` | Electrical connections |
| **Firmware** | `create_file`, `patch_file_lines`, `apply_file_patch`, `replace_file_content` | Code editing |
| **Build** | `compile_in_frontend`, `validate_compile_readiness_state` | Compilation |
| **Simulate** | `run_simulation`, `capture_serial_monitor`, `send_serial_message` | Testing |
| **Validate** | `validate_snapshot_state`, `validate_pin_mapping_state` | Quality checks |

### Tool Safety Pattern

Every tool follows a **guarded execution** pattern:

```python
# @backend/app/agent/agent.py:396-406

async def _safe_tool_call(ctx, tool_name, fn) -> Any:
    try:
        # 1. Execute the tool
        result = fn()
        if inspect.isawaitable(result):
            result = await result
        return result
    except Exception as exc:
        # 2. Capture and log error
        error = str(exc)
        await ctx.deps.emit_event("tool.call.failed", {"tool": tool_name, "error": error})
        log_event("tool.call.failed", session_id=ctx.deps.session_id, tool=tool_name, error=error)
        # 3. Return structured failure (never crash the agent)
        return {"ok": False, "tool": tool_name, "error": error}
```

### Tool Budgeting

Prevents runaway agent behavior:

```python
# @backend/app/agent/deps.py:38-41

def guard_tool_call(self) -> None:
    self.tool_calls += 1
    ensure_tool_budget(self.tool_calls)   # Max 100 calls
    ensure_time_budget(self.started_at)     # Max 5 minutes
```

---

## Wiring Methodology

The agent follows a **rigorous 7-step wiring protocol** defined in the system instructions:

### Protocol Steps

| Step | Action | Critical Rule |
|------|--------|---------------|
| 1 | Add component/board | Note exact ID returned |
| 2 | **Fetch runtime pins** | `get_canvas_runtime_pins()` — NEVER guess |
| 3 | Plan all wires | List complete connection table first |
| 4 | Connect power/ground | VCC before signal pins |
| 5 | Connect signal pins | Shared buses first, point-to-point last |
| 6 | Route every wire | `route_wire()` with computed waypoints |
| 7 | Validate | `validate_pin_mapping_state()` |

### Wire Routing Rules

**Rule R1: No Diagonal Wires**
- All wires travel only horizontally and vertically
- Waypoints must share X or Y with adjacent waypoint

**Rule R2: L-Shaped Routing (Default)**
```
Segment 1: Horizontal from start to midpoint X
Segment 2: Vertical from midpoint X to end Y

Waypoints: [
  { 'x': midX, 'y': start_pin_y },
  { 'x': midX, 'y': end_pin_y }
]
```

**Rule R3: Pin Exit Clearance**
- First waypoint places wire OUTSIDE component bounding box
- Use 20px clearance in exit direction

**Rule R4: Lane Staggering**
- When multiple wires share corridor, assign unique offsets
- Pattern: midX, midX+10, midX+20, midX-10...

**Rule R5: Power Bus Consolidation**
- For 3+ components: dedicate power bus columns
- VCC at `board_x - 60`, GND at `board_x - 40`

### Signal Type Semantics

| Signal | Color | Type |
|--------|-------|------|
| VCC/5V | `#ef4444` | `power` |
| GND | `#374151` | `ground` |
| SDA (I2C) | `#3b82f6` | `i2c-data` |
| SCL (I2C) | `#f59e0b` | `i2c-clock` |
| MOSI (SPI) | `#8b5cf6` | `spi-mosi` |
| TX (UART) | `#84cc16` | `uart-tx` |
| RX (UART) | `#14b8a6` | `uart-rx` |

---

## Session Lifecycle Methodology

### State Machine

```
         ┌─────────────┐
         │   queued    │◀── Session created
         └──────┬──────┘
                │ Message received
                ▼
         ┌─────────────┐
         │   running   │◀── Agent actively executing
         └──────┬──────┘
                │
       ┌────────┼────────┐
       │        │        │
       ▼        ▼        ▼
  ┌────────┐ ┌────────┐ ┌────────┐
  │completed│ │ failed │ │ stopped│
  └────┬───┘ └────────┘ └────────┘
       │
       ▼
  User applies/discard
```

### Per-Session Concurrency Control

```python
# @backend/app/agent/sessions.py:20-24

_session_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

def get_session_lock(session_id: str) -> asyncio.Lock:
    return _session_locks[session_id]

# Usage: All mutations hold the session lock
async with get_session_lock(session_id):
    # Perform atomic snapshot update
    ...
```

---

## Frontend Integration Methodology

### Bidirectional Communication

```
Backend Agent ──SSE──▶ Frontend UI
       ▲                    │
       └────HTTP POST───────┘
              (actions)
```

### Frontend Action Pattern

For operations requiring frontend state (compilation, simulation):

```python
# @backend/app/agent/agent.py:408-439

async def _run_frontend_action(ctx, action, payload, timeout_ms=20000):
    # 1. Create request with unique action ID
    request = create_frontend_action_request(
        session_id=ctx.deps.session_id,
        action=action,
        payload=payload,
    )
    
    # 2. Emit event to frontend
    await ctx.deps.emit_event("frontend.action.request", {
        "actionId": request.action_id,
        "action": action,
        "payload": payload,
    })
    
    # 3. Wait for result (async with timeout)
    result = await wait_for_frontend_action_result(
        action_id=request.action_id,
        timeout_ms=timeout_ms,
    )
    
    return result.payload
```

**Supported Actions:**
- `compile` — Compile board code
- `sim_run` / `sim_pause` / `sim_reset` — Simulation control
- `serial_monitor_open` / `serial_capture` — Serial I/O

---

## Safety & Guardrails

### Size Limits

```python
# @backend/app/agent/safety.py

MAX_PROMPT_CHARS = 50_000      # Prevent token overflow
MAX_SNAPSHOT_BYTES = 5_000_000  # Prevent memory exhaustion
MAX_TOOL_CALLS = 100           # Prevent infinite loops
MAX_RUN_TIME_SECONDS = 300     # Prevent runaway execution
```

### Snapshot Validation

Every mutation triggers validation:

```python
# @backend/app/agent/snapshot_ops.py

def _validate(snapshot: ProjectSnapshotV2) -> ProjectSnapshotV2:
    # Pydantic validators check:
    # - Unique entity IDs
    # - Wire endpoints reference existing components
    # - Active board exists
    # - File groups are consistent
    return ProjectSnapshotV2.model_validate(snapshot.model_dump())
```

---

## Model Provider Strategy

### Supported Providers

| Provider | Model String | Resolution |
|----------|--------------|------------|
| OpenAI | `openai:gpt-4.1` | Direct API |
| OpenAI | `openai-responses:gpt-4.1` | Responses API with web search |
| GitHub Copilot | `github-copilot:*` | Token-based auth |

### Model Resolution Flow

```python
# @backend/app/agent/agent.py:1246-1266

resolved_model = await resolve_pydantic_ai_model(db, user_id, session.model_name)

# Returns either:
# - str: "openai:gpt-4.1" → used directly
# - OpenAIModel object: For Copilot (complex auth)

agent = build_agent(resolved_model, defer_model_check=is_complex_model)

# Override support for testing/special cases
with agent.override(model=effective_override):
    result = await agent.run(contextual_prompt, deps=deps)
```

---

## Key Files Reference

| File | Responsibility |
|------|----------------|
| `@backend/app/agent/agent.py` | Agent runtime, tool registration, main loop |
| `@backend/app/agent/deps.py` | Context object (db, snapshot, session state) |
| `@backend/app/agent/schemas.py` | Pydantic models for all data structures |
| `@backend/app/agent/snapshot_ops.py` | All mutation operations on snapshots |
| `@backend/app/agent/tools.py` | Tool implementations and catalog access |
| `@backend/app/agent/sessions.py` | Session CRUD, event persistence, locking |
| `@backend/app/agent/safety.py` | Guardrails and limits |
| `@backend/app/agent/validators.py` | Business logic validation |
| `@backend/app/agent/frontend_actions.py` | Frontend coordination |
| `@backend/app/agent/catalog.py` | Component metadata resolution |

---

## Summary

The IntelliBoard agentic layer methodology emphasizes:

1. **Deterministic safety** — Operation-based mutations, budgeting, validation
2. **Streaming observability** — SSE events for every state change
3. **Structured reasoning** — 7-step wiring protocol with explicit waypoints
4. **Minimal invasiveness** — Draft pattern preserves user work
5. **Extensible tooling** — 40+ composable tools with safe execution
6. **Provider flexibility** — OpenAI, Copilot with unified interface

This architecture enables autonomous hardware engineering while maintaining user control and visibility throughout the process.
