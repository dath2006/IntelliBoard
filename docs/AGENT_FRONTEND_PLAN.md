# Agentic Frontend Buildout (Phase Plan)

## Scope and goals

Build a right-docked, collapsible, resizable agent chat panel (VS Code-style) that streams full agent traces with compact-by-default display. The panel must:

- Stream SSE events (run lifecycle, tool calls, model deltas) and render them live.
- Apply snapshot updates in real time to canvas, wires, and code files.
- Provide per-project session picker and run history.
- Default to compact view with expand controls for full trace detail.

## Current backend capabilities (ground truth)

- SSE stream endpoint: [backend/app/api/routes/agent_sessions.py](backend/app/api/routes/agent_sessions.py#L107-L139)
- Event emission and tool streaming: [backend/app/agent/agent.py](backend/app/agent/agent.py#L360-L505)
- Event persistence and replay: [backend/app/agent/sessions.py](backend/app/agent/sessions.py#L126-L158)

### Event types to render

Run lifecycle:

- `session.created`
- `message.received`
- `run.started`
- `run.completed`
- `run.failed`
- `run.cancelled`

Tool and model stream:

- `tool.call.started`
- `tool.call.result`
- `model.output.delta`
- `model.output.final`

Snapshot mutation:

- `snapshot.updated` (payload includes changed ids)

## Current frontend structure (integration points)

Layout and panel patterns:

- Editor split layout and resizers: [frontend/src/pages/EditorPage.tsx](frontend/src/pages/EditorPage.tsx#L301-L448)
- Panel styles and split layout: [frontend/src/App.css](frontend/src/App.css#L164-L260)
- Collapsible/resizable sidebar pattern: [frontend/src/components/editor/FileExplorer.tsx](frontend/src/components/editor/FileExplorer.tsx#L135-L270)

State stores for live updates:

- Code files and groups: [frontend/src/store/useEditorStore.ts](frontend/src/store/useEditorStore.ts)
- Components and wires: [frontend/src/store/useSimulatorStore.ts](frontend/src/store/useSimulatorStore.ts)

## Phase 0 — Panel placement and layout

### Goal

Create a right-docked, collapsible, resizable agent panel integrated into the editor layout.

### Implementation notes

- Add a right-side panel container adjacent to the editor/simulator split.
- Reuse the existing split-resize logic from [frontend/src/pages/EditorPage.tsx](frontend/src/pages/EditorPage.tsx#L301-L448).
- Use a persistent width state (localStorage) so the panel restores size on reload.

### Deliverables

- `AgentPanel` component (new).
- `AgentPanelToggle` in header or toolbar (new).
- Right-panel container with drag-to-resize behavior.

## Phase 1 — Session management and API wiring

### Goal

Support per-project sessions with a session picker and run history.

### Backend mapping

- Create session: `POST /api/agent/sessions`
- List sessions: `GET /api/agent/sessions?project_id=...`
- Send message: `POST /api/agent/sessions/{id}/messages`
- Apply session: `POST /api/agent/sessions/{id}/apply`
- Discard session: `POST /api/agent/sessions/{id}/discard`
- Stop session: `POST /api/agent/sessions/{id}/stop`

### UI requirements

- Session picker (per project) with last updated timestamps.
- Run history list (per session) with status and elapsed time.
- Model selector (session-level `modelName`).

### Data model (frontend)

- `AgentSession { id, projectId, status, modelName, createdAt, updatedAt }`
- `AgentRun { sessionId, startedAt, endedAt, status, summary }`

## Phase 2 — SSE streaming and rendering (compact by default)

### Goal

Stream events to the panel and render compact summaries with expand-to-full detail.

### Streaming client

- Implement `AgentEventStream` using `EventSource` on:
  `GET /api/agent/sessions/{id}/events?stream=true&after=0`.
- Track `lastSeq` and reconnect with `after=lastSeq` on disconnect.

### Rendering rules

Compact view (default):

- `run.started` => single line with message preview.
- `tool.call.started` / `tool.call.result` => one collapsed group per tool call.
- `model.output.delta` => buffer into a single assistant message (no per-delta rows).
- `snapshot.updated` => one line with changed ids (boards/components/wires/files).

Expanded view:

- Show per-delta tokens and tool call detail payloads.
- Show raw event payloads with timestamps.

### UI controls

- Compact/Expanded toggle (global for the panel).
- Per-event expand control for payload and timestamps.

## Phase 3 — Live updates to code and canvas

### Goal

Apply agent changes to the editor and simulator in real time.

### Source of truth

`snapshot.updated` events (payload contains changed ids). The agent runtime saves the snapshot on each mutation and emits `snapshot.updated` with a `ToolResult` payload.

### Update strategy

- If event has `changedFileGroups`: use `useEditorStore` to update the active group files.
- If event has `changedComponentIds` or `changedWireIds`: update `useSimulatorStore` components/wires.
- If event has `changedBoardIds`: update board list and active board info.

### Precedence rules

- Always respect the snapshot as the authoritative state when applying changes.
- When in conflict with local unsaved edits, show a toast and duplicate the file (suffix `-agent`), then apply agent changes to the duplicated file.

## Phase 4 — Panel controls and workflow

### Goal

Provide the core controls: Start/Stop/Resume, Approve/Reject, Model selector, Run history, Session picker.

### Controls mapping

- Start: create session if needed, then post message.
- Stop: `POST /api/agent/sessions/{id}/stop`.
- Resume: post new message to the same session.
- Approve: `POST /api/agent/sessions/{id}/apply`.
- Reject: `POST /api/agent/sessions/{id}/discard`.

### UX requirements

- Disable Start when a run is active.
- Show run status badge (queued, running, completed, failed, stopped).
- Show “Applying…” state on approve, then update project state.

## Phase 5 — Failure modes and recovery

### SSE reconnect behavior

- On disconnect, reconnect using `after=lastSeq`.
- If gap detection fails, request `GET /events?after=0` and reconcile.

### Errors

- `run.failed` => show error block with retry action.
- Tool failures => show inline error on tool call group.

## Phase 6 — Metadata gaps and correctness

Component metadata is stored in [frontend/public/components-metadata.json](frontend/public/components-metadata.json). It includes `pinCount`, `properties`, and `defaultValues`, but often lacks explicit pin names.

Agent tooling for schema lookup and gaps:

- `get_component_schema` and `list_component_schema_gaps` in [backend/app/agent/catalog.py](backend/app/agent/catalog.py)

Roadmap:

- Extend component schema with pin names and property constraints for common components.
- Use examples as reference to standardize pin names and resistor property keys.

## Phase 7 — Final validation checklist

- SSE stream renders compact view by default with expand controls.
- Right panel is resizable, collapsible, and state persists.
- Live updates to code and canvas are visible within 1 event cycle.
- Session picker is per project and retains history.
- Approve/Reject updates project state and writes back snapshots.

## Appendix — Suggested new files

- `frontend/src/components/agent/AgentPanel.tsx`
- `frontend/src/components/agent/AgentEventStream.ts`
- `frontend/src/components/agent/AgentRunHistory.tsx`
- `frontend/src/components/agent/AgentTraceRow.tsx`
- `frontend/src/store/useAgentStore.ts`
- `frontend/src/services/agentSessions.ts`
