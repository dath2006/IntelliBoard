# Project Isolation Bug Fix V2

## Problem Description

**Critical Bug**: When creating a new project or switching between projects, the agent's `get_project_outline` tool returns circuit data (components, wires) from the **previous project** instead of the current project.

### User-Reported Scenario:
1. User builds Project A with components and wires
2. User creates a new Project B (empty project)
3. Canvas appears empty (correct)
4. User sends a prompt to the agent in Project B
5. **BUG**: Agent calls `get_project_outline` and receives Project A's circuit data
6. Agent operates on wrong project data

## Root Cause Analysis

### The Problem Chain:

The issue is a **race condition** between project loading and agent session creation:

1. **User creates new project** → `NewProjectModal` creates project and navigates to `/project/{id}`
2. **Two components mount simultaneously**:
   - `ProjectByIdPage` - loads project data from server
   - `AgUiPanel` - initializes agent session
3. **Race condition occurs**:
   - `ProjectByIdPage` clears stores and starts loading project data
   - `AgUiPanel` immediately calls `createAndActivate()`
   - `createAndActivate()` calls `buildSnapshotFromStores()` **before** project data finishes loading
4. **Snapshot captures wrong data**:
   - If stores still contain old project data → snapshot has old project
   - If stores are partially cleared → snapshot has incomplete data
5. **Agent uses wrong snapshot**:
   - Backend stores the snapshot with the session
   - `get_project_outline` reads from this snapshot
   - Agent sees wrong project's circuit

### Code Flow:

```typescript
// NewProjectModal.tsx - Creates project
const saved = await createProject(payload);
navigate(`/project/${saved.id}`); // Triggers navigation
window.location.reload(); // ❌ Forces reload but race still happens

// ProjectByIdPage.tsx - Loads project (ASYNC)
useEffect(() => {
  // Clear stores
  simulatorState.setComponents([]);
  simulatorState.setWires([]);
  
  // Load project data (ASYNC - takes time)
  getProjectById(id).then((project) => {
    setComponents(JSON.parse(project.components_json));
    setWires(JSON.parse(project.wires_json));
    // ...
  });
}, [id]);

// AgUiPanel.tsx - Creates session (RUNS IMMEDIATELY)
useEffect(() => {
  refreshSessions(currentProject.id).then(async () => {
    // ❌ This runs BEFORE ProjectByIdPage finishes loading!
    await createAndActivate(currentProject.id);
  });
}, [currentProject?.id]);

// createAndActivate - Captures snapshot
const createAndActivate = async (projectId: string) => {
  const snapshot = buildSnapshotFromStores(); // ❌ Captures OLD or EMPTY data!
  const session = await createAgentSession({
    projectId,
    snapshotJson: JSON.stringify(snapshot), // ❌ Wrong data sent to backend
  });
};
```

### Why Previous Fix Wasn't Enough:

The previous fix (documented in `PROJECT_ISOLATION_BUG_FIX.md`) added store clearing in `ProjectByIdPage` and `ProjectPage`. This fixed the issue when **switching between existing projects**, but **not when creating new projects** because:

1. Store clearing happens in `ProjectByIdPage.useEffect()`
2. Agent session creation happens in `AgUiPanel.useEffect()`
3. Both effects run **simultaneously** when the component tree mounts
4. There's no guarantee which one completes first
5. The agent often wins the race and captures stale data

## The Fix

### Solution 1: Wait for Stores to be Ready (AgUiPanel.tsx)

Modified `AgUiPanel.tsx` to **poll and wait** for stores to be populated before creating a session:

```typescript
useEffect(() => {
  if (!currentProject?.id) {
    setSessionId(null);
    return;
  }
  
  // CRITICAL FIX: Wait for stores to be populated before creating session
  const waitForStoresReady = async () => {
    const maxAttempts = 20; // 2 seconds max wait
    const pollInterval = 100; // 100ms between checks
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sim = useSimulatorStore.getState();
      const editor = useEditorStore.getState();
      
      // Check if stores have been initialized with project data
      const hasFileGroups = Object.keys(editor.fileGroups).length > 0;
      const hasFiles = Object.values(editor.fileGroups).some(files => files.length > 0);
      
      if (hasFileGroups && hasFiles) {
        return true; // Stores are ready
      }
      
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    
    console.warn('[AgUiPanel] Store initialization timeout');
    return true;
  };

  const initSession = async () => {
    await waitForStoresReady(); // ✅ Wait for project to load
    await refreshSessions(currentProject.id);
    
    const existing = /* find existing session */;
    if (existing) {
      setSessionId(existing.id);
    } else {
      await createAndActivate(currentProject.id); // ✅ Now captures correct data
    }
  };

  initSession().catch(/* handle error */);
}, [currentProject?.id]);
```

**Why this works:**
- Polls stores every 100ms until file groups are populated
- File groups are the first thing loaded by `ProjectByIdPage`
- Once file groups exist, we know the project data is loading/loaded
- Maximum 2-second wait prevents infinite loops
- Ensures `buildSnapshotFromStores()` captures the correct project

### Solution 2: Clear Stores in NewProjectModal (NewProjectModal.tsx)

Modified `NewProjectModal.tsx` to **clear stores immediately** after creating the project:

```typescript
const saved = await createProject(payload);

// CRITICAL FIX: Clear stores before navigating to new project
const editorState = useEditorStore.getState();
const simulatorState = useSimulatorStore.getState();

// Clear editor state
editorState.loadFiles([{ name: `main${defaultExt}`, content: defaultCode }]);

// Clear simulator state
simulatorState.setComponents([]);
simulatorState.setWires([]);
simulatorState.setBoardType(boardType as any);

setCurrentProject({ /* ... */ });
navigate(`/project/${saved.id}`, { replace: true });
// ✅ Removed window.location.reload() - stores are now properly cleared
```

**Why this works:**
- Clears stores **before** navigation
- Ensures old project data is gone before `ProjectByIdPage` mounts
- Removes the `window.location.reload()` hack
- Provides a cleaner, more predictable state transition

### Solution 3: Debug Logging (AgUiPanel.tsx)

Added debug logging to `createAndActivate` to help diagnose future issues:

```typescript
const createAndActivate = async (projectId: string) => {
  const snapshot = buildSnapshotFromStores();
  
  // Debug logging to help diagnose snapshot issues
  console.log('[AgUiPanel] Creating session with snapshot:', {
    projectId,
    boards: snapshot.boards.length,
    components: snapshot.components.length,
    wires: snapshot.wires.length,
    fileGroups: Object.keys(snapshot.fileGroups),
    activeBoardId: snapshot.activeBoardId,
  });
  
  const session = await createAgentSession({ /* ... */ });
};
```

**Why this helps:**
- Logs what data is being captured in the snapshot
- Makes it easy to verify the fix is working
- Helps diagnose any future similar issues
- Can be removed once the fix is confirmed stable

## Files Modified

1. **frontend/src/components/agent/AgUiPanel.tsx**
   - Added `waitForStoresReady()` polling logic
   - Modified session initialization to wait for stores
   - Added debug logging to `createAndActivate()`

2. **frontend/src/components/layout/NewProjectModal.tsx**
   - Added store clearing before navigation
   - Removed `window.location.reload()` hack
   - Imported `useEditorStore` and `useSimulatorStore`

## Testing Checklist

### Test Case 1: Create New Project
- [ ] Create Project A with components and wires
- [ ] Click "New Project" button
- [ ] Create Project B (empty)
- [ ] Verify canvas is empty
- [ ] Open browser console
- [ ] Send a prompt to the agent
- [ ] Check console log: should show `components: 0, wires: 0`
- [ ] Verify agent doesn't mention Project A's components

### Test Case 2: Switch Between Projects
- [ ] Open Project A (has components)
- [ ] Navigate to Project B (empty)
- [ ] Verify canvas is empty
- [ ] Send a prompt to the agent
- [ ] Verify agent sees empty project
- [ ] Navigate back to Project A
- [ ] Verify components are still there
- [ ] Send a prompt to the agent
- [ ] Verify agent sees Project A's components

### Test Case 3: Rapid Project Switching
- [ ] Create 3 projects with different circuits
- [ ] Rapidly switch between them
- [ ] For each project, send a prompt to the agent
- [ ] Verify agent always sees the correct project's data

### Test Case 4: New Project from Template
- [ ] Create a new project from an example template
- [ ] Verify canvas shows template components
- [ ] Send a prompt to the agent
- [ ] Verify agent sees template components

## Prevention Strategies

To prevent similar issues in the future:

### 1. Store Initialization Contract
Add a `ready` flag to each store to indicate when it's been initialized:

```typescript
interface SimulatorStore {
  ready: boolean;
  setReady: (ready: boolean) => void;
  // ...
}

// In ProjectByIdPage:
simulatorState.setReady(false); // Mark as not ready
// ... load data ...
simulatorState.setReady(true); // Mark as ready

// In AgUiPanel:
const waitForStoresReady = async () => {
  while (!useSimulatorStore.getState().ready) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
```

### 2. Project ID in Snapshot
Add project ID validation to the snapshot:

```typescript
interface ProjectSnapshotV2 {
  projectId: string; // Add this field
  version: 2;
  boards: Board[];
  // ...
}

// In backend:
def create_agent_session(body: AgentSessionCreateRequest):
    snapshot = json.loads(body.snapshot_json)
    if snapshot.get('projectId') != body.project_id:
        raise ValueError('Snapshot project ID mismatch')
```

### 3. Snapshot Fingerprinting
Add a fingerprint to detect stale snapshots:

```typescript
interface ProjectSnapshotV2 {
  fingerprint: string; // Hash of components + wires + files
  capturedAt: string; // ISO timestamp
  // ...
}
```

### 4. Explicit Store Reset Method
Add a `reset()` method to each store for cleaner clearing:

```typescript
interface SimulatorStore {
  reset: () => void;
}

const useSimulatorStore = create<SimulatorStore>((set) => ({
  // ...
  reset: () => set({
    boards: [/* default board */],
    components: [],
    wires: [],
    activeBoardId: null,
    ready: false,
  }),
}));
```

## Backend Considerations

The backend correctly stores sessions per project (`session.project_id`), but it **trusts the snapshot** provided by the frontend. The backend cannot detect if the frontend sent the wrong project's snapshot.

### Future Enhancement: Backend Validation

Add validation in `create_agent_session` to verify the snapshot matches the project:

```python
@router.post("/sessions")
async def create_agent_session(
    body: AgentSessionCreateRequest,
    db: AsyncSession = Depends(get_db),
):
    # Load the project from database
    project = await get_project_by_id(db, body.project_id)
    
    # Parse the snapshot
    snapshot = json.loads(body.snapshot_json)
    
    # Validate snapshot matches project
    if snapshot.get('boards'):
        snapshot_board = snapshot['boards'][0]['boardKind']
        if snapshot_board != project.board_type:
            raise ValueError(
                f"Snapshot board type mismatch: "
                f"snapshot has {snapshot_board}, "
                f"project has {project.board_type}"
            )
    
    # Validate file groups match
    snapshot_files = set()
    for files in snapshot.get('fileGroups', {}).values():
        snapshot_files.update(f['name'] for f in files)
    
    project_files = set(f['name'] for f in project.files)
    
    if snapshot_files != project_files:
        logger.warning(
            f"Snapshot file mismatch for project {body.project_id}: "
            f"snapshot={snapshot_files}, project={project_files}"
        )
    
    # Create session...
```

## Related Issues

This fix also prevents:
- Agent seeing components from previous project
- Agent seeing code files from previous project
- Agent seeing wire connections from previous project
- Agent operating on wrong board type
- Inconsistent state between canvas and agent

## Success Criteria

The fix is successful when:
1. ✅ Creating a new project always shows empty canvas to agent
2. ✅ Switching projects always shows correct project to agent
3. ✅ Console logs show correct snapshot data
4. ✅ No `window.location.reload()` needed
5. ✅ No race conditions between project loading and session creation
6. ✅ Agent's `get_project_outline` always returns current project data
