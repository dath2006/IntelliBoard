# Agent Backend Implementation Checklist

This checklist converts the backend portion of the agentic plan into an execution-ready sprint sequence.

Scope:

- Backend only (frontend implementation deferred).
- Canonical snapshot persistence and agent sessions.
- Pydantic AI agent runtime with OpenAI model.
- Full testing and validation strategy.

Out of scope for this document:

- Frontend panel, preview rendering, UI affordances.

## Working Agreement

- Keep legacy project fields backward-compatible.
- Treat `snapshot_json` as authoritative when present.
- Use operation-based tools only for mutations.
- Every mutating tool must update draft snapshot and emit compact events.
- Never duplicate compile logic; route through existing compile services.

## Sprint Plan Overview

| Sprint   | Goal                                                      | Exit Criteria                                                    |
| -------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| Sprint 0 | Foundation and dependency bootstrap                       | Env, deps, and feature flags are in place; tests scaffolded      |
| Sprint 1 | Canonical snapshot domain and compatibility conversion    | `ProjectSnapshotV2` and conversion rules fully tested            |
| Sprint 2 | DB persistence for snapshots and agent sessions           | Schema additive migration works; CRUD/session persistence passes |
| Sprint 3 | Agent tool layer and validators                           | Operation tools implemented with deterministic unit tests        |
| Sprint 4 | Session APIs + SSE + run orchestration                    | Endpoints and stream behavior validated, including apply/discard |
| Sprint 5 | Compile/library integration, hardening, and release gates | Integration scenarios pass and rollout checklist is green        |

---

## Sprint 0 - Foundation and Bootstrap

### Per-file tasks

#### `backend/requirements.txt`

- [x] Add `pydantic-ai`.
- [x] Add SSE dependency (`sse-starlette`) or document native `StreamingResponse` approach.
- [x] Optionally add `orjson` for event serialization.

#### `backend/app/core/config.py`

- [x] Add `AGENT_MODEL` default (`openai:gpt-5.2`).
- [x] Add optional `AGENT_FALLBACK_MODEL`.
- [x] Add `AGENT_ENABLED` feature flag.
- [x] Add runtime limits (`AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_PROMPT_CHARS`, `AGENT_SNAPSHOT_MAX_BYTES`).
- [x] Add `AGENT_ENABLE_LOGFIRE` flag.

#### `backend/app/main.py`

- [x] Register new agent routes module (once added).
- [x] Keep startup migrations additive and idempotent.
- [x] Ensure no behavior change for existing non-agent routes.

#### `test/backend/unit/test_agent_config.py` (new)

- [x] Validate settings load with defaults.
- [x] Validate env override behavior.
- [x] Validate disabled/invalid model config handling.

### Sprint 0 test commands

```bash
pytest test/backend/unit/test_agent_config.py -v
pytest test/backend/unit -k "agent_config" -v
```

---

## Sprint 1 - Canonical Snapshot Models and Compatibility

### Per-file tasks

#### `backend/app/agent/schemas.py` (new)

- [x] Define `ProjectSnapshotV2` with strict fields:
  - [x] `version: 2`
  - [x] `boards`
  - [x] `activeBoardId`
  - [x] `components`
  - [x] `wires`
  - [x] `fileGroups`
  - [x] `activeGroupId`
- [x] Define strict operation input/output models.
- [x] Define event models for stream payloads.
- [x] Define validator result models.

#### `backend/app/agent/snapshot_compat.py` (new)

- [x] Implement legacy-to-v2 conversion.
- [x] Implement v2-to-legacy compatibility derivation from active board only.
- [x] Preserve board ID stability separate from `boardKind`.
- [x] Add defensive normalization for missing optional fields.

#### `backend/app/schemas/project.py`

- [x] Add optional `snapshot_json` on create/update/response schemas.
- [x] Keep existing fields intact to avoid breaking clients.

#### `test/backend/unit/test_snapshot_schemas.py` (new)

- [x] Validate accepted snapshot payloads.
- [x] Validate rejected malformed payloads.
- [x] Validate duplicate ID and endpoint invariants.

#### `test/backend/unit/test_snapshot_compat.py` (new)

- [x] Test legacy to v2 conversion with single-board legacy projects.
- [x] Test active-board derivation to legacy fields.
- [x] Test zero-board analog fixture behavior.
- [x] Test multi-board fixture behavior.

### Fixture source references

- [ ] Build test fixtures derived from:
  - `frontend/src/data/examples.ts`
  - `frontend/src/data/examples-circuits.ts`
  - `frontend/src/data/examples-analog.ts`

### Sprint 1 test commands

```bash
pytest test/backend/unit/test_snapshot_schemas.py -v
pytest test/backend/unit/test_snapshot_compat.py -v
pytest test/backend/unit -k "snapshot" -v
```

---

## Sprint 2 - Persistence and Session Storage

### Per-file tasks

#### `backend/app/models/project.py`

- [x] Add `snapshot_json: Text | None`.
- [x] Keep all legacy project columns unchanged.

#### `backend/app/models/agent_session.py` (new)

- [x] Add session model (`id`, `project_id`, `user_id`, status, base/draft snapshots, model, timestamps).
- [x] Add indexes for user/project/time queries.

#### `backend/app/models/agent_session_event.py` (new)

- [x] Add append-only event model (`session_id`, seq, event_type, payload_json, created_at).
- [x] Add uniqueness/index constraints for ordered replay.

#### `backend/app/main.py`

- [x] Register new models import for metadata creation.
- [x] Add additive legacy migration SQL statements for new columns/tables.

#### `backend/app/agent/sessions.py` (new)

- [x] Implement session lifecycle helpers:
  - [x] create
  - [x] list
  - [x] append event
  - [x] load draft
  - [x] apply draft
  - [x] discard draft
- [x] Enforce per-session lock for concurrent requests.

#### `test/backend/unit/test_agent_sessions_store.py` (new)

- [x] Validate create/list transitions.
- [x] Validate event sequencing and replay ordering.
- [x] Validate apply/discard semantics.

### Sprint 2 test commands

```bash
pytest test/backend/unit/test_agent_sessions_store.py -v
pytest test/backend/unit -k "agent_session or snapshot_json" -v
```

---

## Sprint 3 - Operation-Based Tool Layer and Validation

### Per-file tasks

#### `backend/app/agent/tools.py` (new)

- [x] Implement read tools:
  - [x] `get_project_outline`
  - [x] `get_component_detail`
  - [x] `search_component_catalog`
  - [x] `list_files`
  - [x] `read_file`
- [ ] Implement mutation tools:
  - [x] `add_board`
  - [x] `change_board_kind`
  - [x] `remove_board`
  - [x] `add_component`
  - [x] `update_component`
  - [x] `remove_component`
  - [x] `connect_pins`
  - [x] `disconnect_wire`
  - [x] `move_component`
  - [x] `route_wire`
  - [x] `create_file`
  - [x] `replace_file_range`
  - [x] `apply_file_patch`

#### `backend/app/agent/validators.py` (new)

- [x] Implement `validate_snapshot`.
- [x] Implement `validate_pin_mapping`.
- [x] Implement `validate_compile_readiness`.

#### `backend/app/agent/board_mapping.py` (new)

- [x] Define authoritative boardKind to FQBN map.
- [x] Validate board-kind support and fallback errors.
- [x] Ensure board ID is unchanged on kind switch.

#### `backend/app/agent/snapshot_ops.py` (new)

- [x] Centralize immutable-style operation handlers.
- [x] Emit compact changed IDs for event stream.
- [x] Invalidate compile artifacts when board kind/code changes.

#### `test/backend/unit/test_agent_tools_snapshot_ops.py` (new)

- [x] Add deterministic tests per mutation tool.
- [x] Add edge tests for nonexistent IDs and invalid endpoints.
- [x] Add board-kind change invariant tests.

#### `test/backend/unit/test_agent_validators.py` (new)

- [x] Add tests for all validator outcomes.

### Sprint 3 test commands

```bash
pytest test/backend/unit/test_agent_tools_snapshot_ops.py -v
pytest test/backend/unit/test_agent_validators.py -v
pytest test/backend/unit -k "agent_tools or snapshot_ops or validate" -v
```

---

## Sprint 4 - Agent Runtime, Session APIs, and SSE

### Per-file tasks

#### `backend/app/agent/agent.py` (new)

- [x] Build Pydantic AI `Agent` with deps type.
- [x] Configure model from settings (`AGENT_MODEL`, OpenAI key).
- [x] Add event stream handler for tool call start/end and final output.
- [x] Add run limits and guardrails.

#### `backend/app/agent/deps.py` (new)

- [x] Define `AgentDeps` with repositories/services:
  - [x] sessions store
  - [x] snapshot ops
  - [x] compile adapter
  - [x] libraries adapter
  - [x] event emitter

#### `backend/app/api/routes/agent_sessions.py` (new)

- [x] Implement `POST /api/agent/sessions`.
- [x] Implement `GET /api/agent/sessions`.
- [x] Implement `POST /api/agent/sessions/{id}/messages`.
- [x] Implement `GET /api/agent/sessions/{id}/events` (SSE).
- [x] Implement `POST /api/agent/sessions/{id}/apply`.
- [x] Implement `POST /api/agent/sessions/{id}/discard`.
- [x] Implement optional `POST /api/agent/sessions/{id}/stop`.
- [x] Enforce ownership and auth checks via existing dependencies.

#### `backend/app/main.py`

- [x] Include `agent_sessions` router under `/api/agent`.

#### `test/backend/unit/test_agent_runtime_pydantic_ai.py` (new)

- [x] Use `TestModel` for deterministic no-network test flow.
- [x] Use `FunctionModel` for explicit multi-tool call behavior assertions.

#### `test/backend/unit/test_agent_sessions_api.py` (new)

- [x] Endpoint auth/ownership tests.
- [x] Session lifecycle response contract tests.
- [x] Apply/discard idempotency tests.

#### `test/backend/unit/test_agent_sse_stream.py` (new)

- [x] Ordered event emission tests.
- [x] Replay-from-sequence tests.
- [ ] Disconnect/reconnect behavior tests.

### Sprint 4 test commands

```bash
pytest test/backend/unit/test_agent_runtime_pydantic_ai.py -v
pytest test/backend/unit/test_agent_sessions_api.py -v
pytest test/backend/unit/test_agent_sse_stream.py -v
pytest test/backend/unit -k "agent_sessions or pydantic_ai or sse" -v
```

---

## Sprint 5 - Compile and Library Integration, Hardening, Release Gates

### Per-file tasks

#### `backend/app/agent/tools.py`

- [x] Implement integration tools:
  - [x] `search_libraries`
  - [x] `install_library`
  - [x] `list_installed_libraries`
  - [x] `compile_board`
- [x] Route compile through existing compile service.
- [x] Route library actions through existing library service.

#### `backend/app/agent/observability.py` (new)

- [x] Structured logging helpers (`session_id`, `run_id`, `tool_name`, `latency_ms`).
- [x] Optional Logfire wiring behind feature flag.

#### `backend/app/agent/safety.py` (new)

- [x] Snapshot and prompt size checks.
- [x] File patch bounds and path traversal protection.
- [x] Tool call count/time budget guards.

#### `test/backend/integration/test_agent_compile_flow.py` (new)

- [ ] Draft changes to compile flow scenario.
- [ ] Board-kind change invalidates stale compile outputs.

#### `test/backend/integration/test_agent_apply_discard_flow.py` (new)

- [ ] End-to-end apply and discard consistency.

#### `test/backend/integration/test_agent_multi_board_flow.py` (new)

- [ ] Multi-board draft mutation and per-board compile flow.

### Sprint 5 test commands

```bash
pytest test/backend/unit -k "agent and not integration" -v
pytest test/backend/integration/test_agent_compile_flow.py -v -m integration
pytest test/backend/integration/test_agent_apply_discard_flow.py -v -m integration
pytest test/backend/integration/test_agent_multi_board_flow.py -v -m integration
pytest test/backend -v
```

---

## Pytest Command Matrix (By Area)

| Area                      | Commands                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------ |
| Config/bootstrap          | `pytest test/backend/unit/test_agent_config.py -v`                                   |
| Snapshot schema           | `pytest test/backend/unit/test_snapshot_schemas.py -v`                               |
| Snapshot compatibility    | `pytest test/backend/unit/test_snapshot_compat.py -v`                                |
| Session persistence       | `pytest test/backend/unit/test_agent_sessions_store.py -v`                           |
| Tool operations           | `pytest test/backend/unit/test_agent_tools_snapshot_ops.py -v`                       |
| Validators                | `pytest test/backend/unit/test_agent_validators.py -v`                               |
| Runtime orchestration     | `pytest test/backend/unit/test_agent_runtime_pydantic_ai.py -v`                      |
| API contracts             | `pytest test/backend/unit/test_agent_sessions_api.py -v`                             |
| SSE behavior              | `pytest test/backend/unit/test_agent_sse_stream.py -v`                               |
| Integration compile flow  | `pytest test/backend/integration/test_agent_compile_flow.py -v -m integration`       |
| Integration apply/discard | `pytest test/backend/integration/test_agent_apply_discard_flow.py -v -m integration` |
| Integration multi-board   | `pytest test/backend/integration/test_agent_multi_board_flow.py -v -m integration`   |
| Full backend suite        | `pytest test/backend -v`                                                             |

## Suggested execution helpers

```bash
# Unit only (fast iteration)
pytest test/backend/unit -v

# Unit subset for active sprint
pytest test/backend/unit -k "snapshot or agent_sessions" -v

# Integration only (manual or CI stage)
pytest test/backend/integration -v -m integration
```

---

## Release Readiness Checklist

- [ ] `snapshot_json` is authoritative and legacy fields are derived correctly.
- [ ] Board ID remains stable when board kind changes.
- [ ] No mutating tool performs full-blob JSON replacement.
- [ ] Apply/discard flow is deterministic and race-safe.
- [ ] SSE replay supports reconnect without event loss.
- [ ] Compile and library tools delegate to existing backend services.
- [ ] Unit and integration command matrix pass in CI/staging.
- [ ] Feature flag allows controlled rollout and rollback.

## Ownership and Sequencing

Assign one owner per sprint and one backup reviewer.

| Sprint   | Owner | Reviewer | Planned Dates | Status      |
| -------- | ----- | -------- | ------------- | ----------- |
| Sprint 0 |       |          |               | In Progress |
| Sprint 1 |       |          |               | In Progress |
| Sprint 2 |       |          |               | In Progress |
| Sprint 3 |       |          |               | In Progress |
| Sprint 4 |       |          |               | In Progress |
| Sprint 5 |       |          |               | In Progress |
