# Agentic Embedded Build Layer

## Summary
Build an in-app Pydantic AI agent that can autonomously edit Velxio projects through safe, structured tools, while streaming every action to the frontend for review. The main fix is to add a canonical `ProjectSnapshotV2` so board changes, multi-board files, circuit state, and pin mapping update from one source of truth instead of the current legacy `board_type + active files + components_json + wires_json` path.

## Key Changes

- Add `pydantic-ai` to the backend and create an `app/agent/` module with:
  - `agent.py`: Pydantic AI `Agent` using `deps_type=AgentDeps`.
  - `tools.py`: token-efficient project, circuit, file, library, compile, and validation tools.
  - `schemas.py`: strict Pydantic models for snapshots, tool inputs, tool outputs, events, and review patches.
  - `sessions.py`: session lifecycle and draft snapshot management.

- Add canonical project persistence:
  - Extend `Project` with `snapshot_json: Text | None`.
  - Keep legacy fields for compatibility, but treat `snapshot_json` as authoritative when present.
  - Define `ProjectSnapshotV2`:
    - `version: 2`
    - `boards: [{ id, boardKind, x, y, languageMode, activeFileGroupId }]`
    - `activeBoardId`
    - `components: [{ id, metadataId, x, y, properties }]`
    - `wires: [{ id, start, end, waypoints, color, signalType? }]`
    - `fileGroups: { [groupId]: [{ name, content }] }`
    - `activeGroupId`
  - Save legacy `board_type`, `files`, `components_json`, and `wires_json` as derived compatibility fields from the active board only.

- Replace project hydration with one frontend apply path:
  - Add `hydrateProjectSnapshot(snapshot)` to update `useSimulatorStore`, `useEditorStore`, runtime simulator maps, active board, file groups, VFS init, interconnect bindings, and wire positions together.
  - Update project load/save to use `snapshot_json` when present.
  - Stop relying on `setBoardType(project.board_type)` for loaded projects.
  - Board changes must call a single reducer-style action that replaces board kind, recreates the simulator/bridge, preserves board id unless explicitly changed, clears stale compiled firmware, recalculates wires, and updates active file group.

- Add agent session APIs:
  - `POST /api/agent/sessions`: create a session for a project or current unsaved snapshot.
  - `GET /api/agent/sessions?project_id=...`: list multiple sessions per project.
  - `POST /api/agent/sessions/{id}/messages`: send a prompt and start/continue a run.
  - `GET /api/agent/sessions/{id}/events`: SSE stream for tool calls, diffs, compile output, validation results, and final response.
  - `POST /api/agent/sessions/{id}/apply`: apply approved draft snapshot to the live project/editor.
  - `POST /api/agent/sessions/{id}/discard`: discard draft changes.

- Agent tools should be operation-based, not whole-JSON based:
  - `get_project_outline`: boards, active board, component ids/types/positions, wire endpoints, file metadata.
  - `get_component_detail(component_id)`.
  - `search_component_catalog(query, category?)`.
  - `add_board`, `change_board_kind`, `remove_board`.
  - `add_component`, `update_component`, `remove_component`.
  - `connect_pins`, `disconnect_wire`, `move_component`, `route_wire`.
  - `list_files(board_id?)`, `read_file(file, board_id?, start_line?, end_line?)`.
  - `create_file`, `replace_file_range`, `apply_file_patch`.
  - `search_libraries`, `install_library`, `list_installed_libraries`.
  - `compile_board(board_id)`.
  - `validate_snapshot`, `validate_pin_mapping`, `validate_compile_readiness`.
  - All mutating tools update the session draft snapshot and emit compact action events.

- Frontend agent UI:
  - Add an agent side panel in `EditorPage`.
  - Show chat messages, current run status, and a chronological action feed.
  - Apply streamed draft events live to the canvas/editor in “preview” mode.
  - Mark modified components, wires, files, and boards with subtle visual indicators.
  - Provide `Apply changes`, `Discard`, and per-run `Stop` controls.
  - For file edits, show concise diffs and open the affected file automatically.
  - For circuit edits, pan/select the affected board/component/wire as events arrive.

## Reliability Rules

- The agent must never write a full circuit JSON blob for small edits; it must use typed operations against a validated draft snapshot.
- Board identity and board type must be separate:
  - `board.id` is the stable canvas/component id used by wires.
  - `board.boardKind` controls renderer, FQBN, simulator, and pin mapping.
  - `BOARD_KIND_FQBN` remains frontend compile mapping; backend tools validate against the same board-kind mapping.
- Changing board kind must invalidate compiled artifacts and rebuild runtime bridge/simulator state before compile/run.
- Agent context must be summarized:
  - Default tool context returns ids, board kinds, wire endpoints, and file metadata only.
  - Full component/file content is fetched only on demand.
- Compile/run/debug loops should use existing `/api/compile` and simulation bridges, not duplicate simulator logic in the agent.

## Test Plan

- Backend unit tests:
  - Snapshot v2 validation and legacy conversion.
  - Agent tools for add/change/remove board, component ops, wire ops, file range edits, and library install calls.
  - Board-kind change keeps board id stable and updates compile FQBN/pin validation.
  - Pydantic AI tests with `TestModel`/`FunctionModel` for deterministic tool-call flows.

- Frontend tests:
  - Hydrating snapshot v2 with one board, multiple boards, and zero-board analog circuits.
  - Changing board kind updates canvas board renderer, active board, file group, pin mapping, and wire positions.
  - Saving/loading preserves all boards and file groups.
  - Agent event stream applies preview changes and can discard back to the base snapshot.

- Integration scenarios:
  - Prompt: “make an ESP32 DHT22 temperature monitor” creates board, sensor, wires, code, installs library if needed, compiles.
  - Prompt: “change this Uno project to ESP32” changes board kind, remaps compatible pins, updates code/FQBN, and recompiles.
  - Prompt: “add a second Arduino that sends serial data to the first” creates second board, file group, UART wires, and board-specific code.

## Assumptions

- Initial implementation is in-app chat first, not external MCP-first.
- Agent changes use apply-with-review: draft changes stream live, but final project save/run requires explicit user approval.
- `snapshot_json` is additive and backward-compatible; legacy projects continue to load through conversion.
- The existing MCP server can later reuse the same agent tool service, but it is not the primary UI for this milestone.
