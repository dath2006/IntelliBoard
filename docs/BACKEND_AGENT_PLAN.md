**Execution strategy**
Implement in 9 phases so backend remains shippable after each phase, with strict backward compatibility for existing project APIs.

### 1. Foundation and dependency setup

1. Add dependencies to requirements.txt:

- pydantic-ai
- sse-starlette (or native StreamingResponse if you prefer no extra package)
- orjson (optional, for fast event serialization)

2. Extend settings in config.py:

- OPENAI_API_KEY (already exists)
- AGENT_MODEL default: openai:gpt-5.2
- AGENT_FALLBACK_MODEL optional
- AGENT_MAX_TOOL_CALLS, AGENT_MAX_PROMPT_CHARS, AGENT_SNAPSHOT_MAX_BYTES
- AGENT_ENABLE_LOGFIRE optional

3. Define runtime preflight:

- Fail fast on missing OPENAI_API_KEY when agent endpoints are used
- Keep non-agent backend endpoints unaffected

Validation:

- Unit tests for settings parsing with and without env values.

---

### 2. Canonical snapshot domain model (ProjectSnapshotV2)

Create new backend agent schema module:

- backend/app/agent/schemas.py

Define strict models:

1. ProjectSnapshotV2

- version: literal 2
- boards, activeBoardId, components, wires, fileGroups, activeGroupId

2. Snapshot operation input/output models

- AddBoardInput, ChangeBoardKindInput, ConnectPinsInput, ReplaceFileRangeInput, etc.
- ToolResult with minimal payload + changed entity ids

3. Validation models

- PinMappingValidationResult
- CompileReadinessValidationResult
- SnapshotValidationResult

4. Event models

- AgentEvent for SSE stream
- RunState transitions: queued, running, waiting_approval, stopped, completed, failed

Key backend rule:

- Separate board identity from board kind exactly as in your plan:
- board.id stable
- board.boardKind mutable

Validation:

- Unit tests for strict schema acceptance/rejection, including malformed wire endpoints, missing file groups, duplicate ids.

---

### 3. Persistence and compatibility layer

Update project persistence model:

- Add snapshot_json to project.py

Update project response/request schemas:

- project.py

Add conversion service:

- backend/app/agent/snapshot_compat.py
- Legacy -> V2 converter
- V2 -> legacy derived fields (active board only), including:
- board_type
- files/code
- components_json
- wires_json

Apply read/write rules in projects.py:

1. On read:

- If snapshot_json exists, derive legacy fields from snapshot for response compatibility.

2. On create/update:

- If snapshot_json provided, store it authoritative and derive legacy fields.
- If only legacy payload provided, convert to V2 and store both.

Migration approach (aligned with current style in main.py):

- Add additive ALTER TABLE projects ADD COLUMN snapshot_json TEXT
- Keep idempotent try/except migration pattern for now.

Validation:

- Unit tests for round-trip conversion stability.
- API tests verifying old clients still receive expected fields.

---

### 4. Agent session persistence and lifecycle

Add new model(s):

- backend/app/models/agent_session.py
- Optional: backend/app/models/agent_event.py

Recommended tables:

1. agent_sessions

- id, project_id nullable, user_id, status, base_snapshot_json, draft_snapshot_json, model_name, created_at, updated_at

2. agent_session_events

- id, session_id, seq, event_type, payload_json, created_at
- Enables replay for reconnecting SSE clients

Add SQLAlchemy imports in startup model registration:

- main.py

Validation:

- Unit tests for session create/load/update transitions.
- Event ordering test on seq monotonicity.

---

### 5. Agent runtime with OpenAI model via Pydantic AI

Create runtime module:

- backend/app/agent/agent.py
- backend/app/agent/deps.py

Core design:

1. Agent deps object should include:

- db session or repository facade
- session id
- current user id
- snapshot service
- compile service adapter
- library service adapter
- event emitter callback

2. Initialize model from config:

- model string from AGENT_MODEL (example: openai:gpt-5.2)
- OPENAI_API_KEY from env

3. Use event stream handler:

- Stream tool call start/end, token text chunks, final output, validation events

4. Guardrails:

- Max tool calls
- Max message length
- No direct full-JSON rewrite tool allowed

Validation:

- Deterministic unit tests using TestModel and FunctionModel (per Pydantic AI best practice).
- No network required for most unit tests.

---

### 6. Operation-based tools only (no full snapshot replace)

Create tool layer:

- backend/app/agent/tools.py
- backend/app/agent/snapshot_ops.py
- backend/app/agent/validators.py

Implement tools from your plan:

1. Read-only context tools

- get_project_outline
- get_component_detail
- list_files
- read_file
- search_component_catalog

2. Mutating snapshot tools

- add_board, change_board_kind, remove_board
- add_component, update_component, remove_component
- connect_pins, disconnect_wire, move_component, route_wire
- create_file, replace_file_range, apply_file_patch

3. Integration tools

- search_libraries, install_library, list_installed_libraries
- compile_board
- validate_snapshot, validate_pin_mapping, validate_compile_readiness

Tool policy:

- Every mutating tool:
- edits draft snapshot only
- emits compact event with changed ids
- runs post-mutation validation hooks

Validation:

- Unit tests per tool for success and failure paths.
- Property-based tests on file range patch boundaries and wire endpoint invariants.

---

### 7. Agent session APIs and SSE transport

Add new route module:

- backend/app/api/routes/agent_sessions.py

Endpoints (backend-only implementation):

1. POST /api/agent/sessions
2. GET /api/agent/sessions?project_id=...
3. POST /api/agent/sessions/{id}/messages
4. GET /api/agent/sessions/{id}/events (SSE)
5. POST /api/agent/sessions/{id}/apply
6. POST /api/agent/sessions/{id}/discard
7. Optional: POST /api/agent/sessions/{id}/stop

Auth and ownership:

- Reuse require_auth pattern from existing routes
- User can only access own sessions or sessions on owned project

Concurrency:

- Per-session async lock to prevent conflicting mutations
- Session run cancellation token

Validation:

- API contract tests for status codes and auth checks
- SSE tests for reconnect replay and ordered delivery

---

### 8. Compile and library integration correctness

Compile integration should call existing compile route/service logic, not reimplement:

- Reuse adapter around compile.py
- Reuse library flows from libraries.py

Board-kind mapping backend source of truth:

- Add backend/app/agent/board_mapping.py
- Validate board kind -> FQBN deterministically
- Keep stable board id during kind change

Compile artifacts invalidation rule:

- On board kind change or relevant code change:
- mark compile readiness stale in draft metadata
- clear prior board compile result cache in session state

Validation:

- Unit tests for mapping and invalidation triggers.
- Integration tests with mocked compile service plus one optional real compile smoke path.

---

### 9. Observability, safety, and release gates

1. Structured logging

- Include session_id, run_id, tool_name, latency_ms
- Optional Logfire integration if enabled by env

2. Safety limits

- Snapshot size caps
- Max events per run
- File content and patch size limits
- Strict file path sanitizer (no traversal)

3. Rollout plan

- Feature flag AGENT_ENABLED
- Shadow mode first: run tools and events without apply
- Enable apply endpoint after pass criteria met

Validation:

- Adversarial tests for malformed payloads, oversized prompts, path traversal attempts, invalid board ids.

---

**Testing and validation matrix (comprehensive)**

### Unit tests (fast, default)

Location: test/backend/unit

1. Snapshot schema validation and normalization.
2. Legacy conversion and active-board compatibility derivation.
3. Every mutating tool behavior and invariant checks.
4. Agent runtime orchestration with TestModel/FunctionModel.
5. Session state transitions and locking behavior.
6. Event serialization and sequence guarantees.
7. Board mapping and compile readiness validator logic.

### API contract tests

Location: test/backend/unit or separate test/backend/api

1. Session CRUD and auth.
2. Message endpoint run start/continue behavior.
3. Apply/discard semantics.
4. SSE event stream ordering and replay on reconnect.
5. Error taxonomy consistency for tool failures.

### Integration tests

Location: test/backend/integration

1. Real compile path for one AVR board (optional in CI, mandatory before release).
2. Library install/list flow with controlled fixtures.
3. End-to-end scenario with draft mutate -> validate -> apply.
4. Multi-board session scenario with board-kind switch and compile.

### Fixture strategy from examples

1. Convert sample projects from:

- examples-circuits.ts
- examples-analog.ts

2. Build fixture classes:

- single-board digital
- multi-component analog
- zero-board analog mode
- multi-board synthetic fixture (from examples.ts boards contract)

3. Use these as golden snapshots for converter and validation tests.

### Non-functional validation

1. Latency target:

- get_project_outline under 150 ms for medium projects

2. SSE durability:

- reconnect within 30s and replay missed events

3. Data integrity:

- no orphan wires/components after any operation

---

**Recommended implementation order (practical)**

1. Phase 1, 2, 3 first (schema, persistence, sessions).
2. Phase 6 minimal API skeleton next.
3. Phase 5 tools and validators.
4. Phase 4 agent runtime integration.
5. Phase 8 compile/library adapters.
6. Phase 9 hardening and release gating.

This ordering gives you early testable backend value before model calls and before frontend work starts.

---

**Definition of done for backend milestone**

1. snapshot_json authoritative read/write live in project APIs, legacy compatibility preserved.
2. Full session API set implemented with SSE event stream and replay.
3. Operation-only mutating tools implemented and validated.
4. OpenAI-backed Pydantic AI agent runs against configured model and API key.
5. Unit + integration suites pass for all new modules.
6. Apply/discard workflow is deterministic and safe under concurrent requests.
