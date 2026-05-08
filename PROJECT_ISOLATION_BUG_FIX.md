# Project Isolation Bug Fix

## Problem Description

**Critical Bug**: When switching between projects, the agent would load state from the previous project instead of the current project. This caused circuits, code, and components from Project A to appear in Project B when the agent was invoked.

### User-Reported Scenario:
1. User creates Project A
2. Agent creates a circuit in Project A
3. User creates Project B (new empty project)
4. User sends a prompt to the agent in Project B
5. **BUG**: Project A's circuit and code appear in Project B

## Root Cause Analysis

### The Problem Chain:

1. **Zustand stores are global and persistent** across navigation
   - `useSimulatorStore` holds boards, components, wires
   - `useEditorStore` holds files and code
   - These stores are NOT automatically cleared when switching projects

2. **Agent session creation captures current store state**
   - When `AgUiPanel` initializes for a new project, it calls `createAndActivate()`
   - This calls `buildSnapshotFromStores()` which reads the CURRENT state from Zustand stores
   - If stores still contain Project A's data, the snapshot will contain Project A's data

3. **Session snapshot is used by the agent**
   - The agent loads the snapshot that was captured at session creation time
   - This snapshot contains the wrong project's data

### Code Flow:

```typescript
// AgUiPanel.tsx - Session creation
const createAndActivate = async (projectId: string) => {
  const snapshot = buildSnapshotFromStores(); // ❌ Captures OLD project data!
  const session = await createAgentSession({
    projectId,
    snapshotJson: JSON.stringify(snapshot),
    modelName: defaultModelName,
  });
  // ...
};

// useAgentSync.ts - Snapshot builder
export function buildSnapshotFromStores(): ProjectSnapshotV2 {
  const sim = useSimulatorStore.getState(); // ❌ Still has old project's components/wires
  const editor = useEditorStore.getState(); // ❌ Still has old project's files
  
  return {
    boards: sim.boards,
    components: sim.components, // ❌ Wrong project!
    wires: sim.wires,           // ❌ Wrong project!
    fileGroups: editor.fileGroups, // ❌ Wrong project!
    // ...
  };
}
```

### Why It Happened:

**ProjectByIdPage.tsx** and **ProjectPage.tsx** would load new project data by calling:
- `loadFiles(files)` - overwrites files
- `setComponents(components)` - overwrites components  
- `setWires(wires)` - overwrites wires

BUT these functions **update** the stores, they don't **clear** them first. If the new project has fewer items, old items remain in the store.

## The Fix

### Solution: Clear stores BEFORE loading new project data

Modified both `ProjectByIdPage.tsx` and `ProjectPage.tsx` to explicitly clear all store state before loading the new project:

```typescript
useEffect(() => {
  if (!id) return;
  if (currentProject?.id === id && ready) return;

  // ✅ CRITICAL FIX: Clear stores before loading new project
  const editorState = useEditorStore.getState();
  const simulatorState = useSimulatorStore.getState();
  
  // Clear editor state
  editorState.loadFiles([{ name: 'sketch.ino', content: '' }]);
  
  // Clear simulator state
  simulatorState.setComponents([]);
  simulatorState.setWires([]);
  simulatorState.setBoardType('arduino-uno');

  // Now load the new project data
  getProjectById(id).then((project) => {
    loadFiles(project.files);
    setBoardType(project.board_type);
    setComponents(JSON.parse(project.components_json));
    setWires(JSON.parse(project.wires_json));
    // ...
  });
}, [id]);
```

### What This Fixes:

1. **Ensures clean slate**: Every project load starts with empty stores
2. **Prevents cross-contamination**: Old project data cannot leak into new projects
3. **Correct agent snapshots**: `buildSnapshotFromStores()` now captures the correct project's state
4. **Proper isolation**: Each project is truly independent

## Files Modified

1. **frontend/src/pages/ProjectByIdPage.tsx**
   - Added store clearing before `getProjectById()` call
   - Clears editor files, simulator components, wires, and board type

2. **frontend/src/pages/ProjectPage.tsx**
   - Added store clearing before `getProject()` call
   - Same clearing logic as ProjectByIdPage

## Testing Checklist

- [ ] Create Project A with some components and code
- [ ] Create Project B (new empty project)
- [ ] Verify Project B starts empty (no components from Project A)
- [ ] Send a prompt to the agent in Project B
- [ ] Verify agent works with empty project (doesn't see Project A's data)
- [ ] Switch back to Project A
- [ ] Verify Project A still has its original components
- [ ] Switch between projects multiple times
- [ ] Verify no cross-contamination occurs

## Related Issues

This fix also prevents:
- Components appearing in wrong projects
- Code files from one project showing in another
- Wire connections persisting across projects
- Board type not updating when switching projects

## Prevention

To prevent similar issues in the future:

1. **Always clear stores when loading projects** - Don't assume stores are empty
2. **Consider adding a `clearAll()` method** to each store for easier cleanup
3. **Add project ID validation** - Verify snapshot projectId matches current project
4. **Add store reset on navigation** - Consider clearing stores on route changes
5. **Add debug logging** - Log store state during project switches to catch issues early

## Backend Considerations

The backend correctly stores sessions per project (`session.project_id`), but it trusts the snapshot provided by the frontend. The backend cannot detect if the frontend sent the wrong project's snapshot.

**Future Enhancement**: Add validation in `create_agent_session` to verify the snapshot matches the project:
- Compare snapshot board types with project board type
- Validate file names match project files
- Add checksum or fingerprint validation
