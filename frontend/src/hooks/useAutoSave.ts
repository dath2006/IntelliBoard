import { useEffect, useRef } from 'react';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import { updateProject } from '../services/projectService';
import type { ProjectSaveData } from '../services/projectService';

const DEBOUNCE_MS = 2000;

/**
 * Produce a stable string fingerprint of the canvas + code state.
 * Only the fields that matter for persistence are included — transient
 * runtime state (simulation running, serial output, etc.) is excluded so
 * it never triggers a spurious save.
 */
function buildFingerprint(
  sim: ReturnType<typeof useSimulatorStore.getState>,
  editor: ReturnType<typeof useEditorStore.getState>,
): string {
  const boards = sim.boards
    .map((b) => `${b.id}:${b.boardKind}:${b.x}:${b.y}:${b.activeFileGroupId}`)
    .join('|');
  const components = sim.components.map((c) => `${c.id}:${c.metadataId}:${c.x}:${c.y}`).join('|');
  const wires = sim.wires
    .map(
      (w) =>
        `${w.id}:${w.start.componentId}:${w.start.pinName}:${w.end.componentId}:${w.end.pinName}`,
    )
    .join('|');
  const files = Object.entries(editor.fileGroups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([gid, fs]) => `${gid}:${fs.map((f) => `${f.name}=${f.content}`).join(',')}`)
    .join('|');
  return `${sim.activeBoardId}||${boards}||${components}||${wires}||${files}`;
}

/**
 * Auto-saves the current canvas + code state to the DB whenever it meaningfully
 * changes, as long as a project is loaded (currentProject.id is set).
 *
 * Uses a content fingerprint to avoid firing on reference-only changes (Zustand
 * creates new array/object references on every state update even when data is
 * identical). Uses a 2-second debounce so rapid edits don't flood the API.
 */
export function useAutoSave() {
  const currentProjectId = useProjectStore((s) => s.currentProject?.id);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  // Track the fingerprint of the last successfully saved state so we never
  // re-save identical data.
  const lastSavedFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentProjectId) return;

    // Subscribe directly to the stores without pulling arrays into React state.
    // This avoids the reference-churn problem entirely.
    const checkAndSchedule = () => {
      const sim = useSimulatorStore.getState();
      const editor = useEditorStore.getState();
      const fingerprint = buildFingerprint(sim, editor);

      // Nothing changed since last save — skip.
      if (fingerprint === lastSavedFingerprintRef.current) return;

      if (timerRef.current) clearTimeout(timerRef.current);

      timerRef.current = setTimeout(async () => {
        if (savingRef.current) return;

        // Re-check fingerprint right before saving in case state changed again.
        const simNow = useSimulatorStore.getState();
        const editorNow = useEditorStore.getState();
        const currentFingerprint = buildFingerprint(simNow, editorNow);
        if (currentFingerprint === lastSavedFingerprintRef.current) return;

        savingRef.current = true;
        try {
          const fileGroupsSnap: Record<string, { name: string; content: string }[]> = {};
          for (const [groupId, files] of Object.entries(editorNow.fileGroups)) {
            fileGroupsSnap[groupId] = files.map((f) => ({ name: f.name, content: f.content }));
          }

          const entityIds = new Set<string>([
            ...simNow.boards.map((b) => b.id),
            ...simNow.components.map((c) => c.id),
          ]);

          const snapshot = {
            version: 2 as const,
            boards: simNow.boards.map((b) => ({
              id: b.id,
              boardKind: b.boardKind,
              x: b.x,
              y: b.y,
              languageMode: (b.languageMode ?? 'arduino') as 'arduino' | 'micropython',
              activeFileGroupId: b.activeFileGroupId,
            })),
            activeBoardId: simNow.activeBoardId,
            components: simNow.components.map((c) => ({
              id: c.id,
              metadataId: c.metadataId,
              x: c.x,
              y: c.y,
              properties: (c.properties ?? {}) as Record<string, unknown>,
            })),
            wires: simNow.wires
              .filter((w) => entityIds.has(w.start.componentId) && entityIds.has(w.end.componentId))
              .map((w) => ({
                id: w.id,
                start: {
                  componentId: w.start.componentId,
                  pinName: w.start.pinName,
                  x: w.start.x ?? 0,
                  y: w.start.y ?? 0,
                },
                end: {
                  componentId: w.end.componentId,
                  pinName: w.end.pinName,
                  x: w.end.x ?? 0,
                  y: w.end.y ?? 0,
                },
                waypoints: w.waypoints ?? [],
                color: w.color ?? '#22c55e',
                signalType: (w.signalType as string | null | undefined) ?? null,
              })),
            fileGroups: fileGroupsSnap,
            activeGroupId: editorNow.activeGroupId,
          };

          const activeBoard =
            simNow.boards.find((b) => b.id === simNow.activeBoardId) ?? simNow.boards[0];
          const activeGroupFiles =
            editorNow.fileGroups[activeBoard?.activeFileGroupId ?? ''] ?? editorNow.files;
          const code =
            activeGroupFiles.find((f) => f.name.endsWith('.ino'))?.content ??
            activeGroupFiles[0]?.content ??
            '';

          const filteredWires = simNow.wires.filter(
            (w) => entityIds.has(w.start.componentId) && entityIds.has(w.end.componentId),
          );

          await updateProject(currentProjectId, {
            snapshot_json: JSON.stringify(snapshot),
            components_json: JSON.stringify(simNow.components),
            wires_json: JSON.stringify(filteredWires),
            board_type: activeBoard?.boardKind ?? 'arduino-uno',
            files: activeGroupFiles.map((f) => ({ name: f.name, content: f.content })),
            code,
          } satisfies Partial<ProjectSaveData>);

          // Record what we just saved so identical state doesn't re-trigger.
          lastSavedFingerprintRef.current = currentFingerprint;

          // Clear modified flags without triggering another save cycle.
          // We update the ref first so the store subscription below sees the
          // new fingerprint and skips re-scheduling.
          useEditorStore.setState((s) => {
            const clearedGroups: typeof s.fileGroups = {};
            for (const [gid, files] of Object.entries(s.fileGroups)) {
              clearedGroups[gid] = files.map((f) => ({ ...f, modified: false }));
            }
            return {
              fileGroups: clearedGroups,
              files: s.files.map((f) => ({ ...f, modified: false })),
            };
          });
        } catch {
          // Silent — user can still manually save.
        } finally {
          savingRef.current = false;
        }
      }, DEBOUNCE_MS);
    };

    // Subscribe to both stores via their vanilla getState/subscribe APIs so we
    // never pull arrays into React state (which would cause reference churn).
    const unsubSim = useSimulatorStore.subscribe(checkAndSchedule);
    const unsubEditor = useEditorStore.subscribe(checkAndSchedule);

    // Run once on mount in case there's already unsaved state.
    checkAndSchedule();

    return () => {
      unsubSim();
      unsubEditor();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [currentProjectId]);
}
