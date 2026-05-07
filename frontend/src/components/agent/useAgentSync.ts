import { useEffect, useRef } from 'react';
import type { WorkspaceFile } from '../../store/useEditorStore';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useAgentStore } from '../../store/useAgentStore';
import type { BoardKind } from '../../types/board';
import type { WireSignalType } from '../../types/wire';
import { AgentEventStream } from './AgentEventStream';
import {
  getAgentSessionSnapshot,
  listAgentSessionEvents,
  postFrontendActionResult,
  syncCanvasToSession,
  type ProjectSnapshotV2,
} from '../../services/agentSessions';
import { runFrontendAction, type FrontendActionRequest } from '../../services/agentFrontendActions';
import {
  boardPinToNumber,
  isBoardComponent,
  normalizeBoardPinName,
} from '../../utils/boardPinMapping';
import { getAllPinPositions } from '../../utils/pinPositionCalculator';
import {
  scanAndReportCanvasPins,
  invalidatePinObservationCache,
} from '../../utils/canvasPinScanner';

const WIRE_SIGNAL_TYPES: ReadonlySet<WireSignalType> = new Set([
  'power-vcc',
  'power-gnd',
  'analog',
  'digital',
  'pwm',
  'i2c',
  'spi',
  'usart',
]);

/** Build a ProjectSnapshotV2 from the current Zustand store state. */
export function buildSnapshotFromStores(): ProjectSnapshotV2 {
  const sim = useSimulatorStore.getState();
  const editor = useEditorStore.getState();

  const fileGroups: Record<string, { name: string; content: string }[]> = {};
  for (const [groupId, files] of Object.entries(editor.fileGroups)) {
    fileGroups[groupId] = files.map((f) => ({ name: f.name, content: f.content }));
  }

  return {
    version: 2,
    boards: sim.boards.map((b) => ({
      id: b.id,
      boardKind: b.boardKind,
      x: b.x,
      y: b.y,
      languageMode: (b.languageMode ?? 'arduino') as 'arduino' | 'micropython',
      activeFileGroupId: b.activeFileGroupId,
    })),
    activeBoardId: sim.activeBoardId,
    components: sim.components.map((c) => ({
      id: c.id,
      metadataId: c.metadataId,
      x: c.x,
      y: c.y,
      properties: (c.properties ?? {}) as Record<string, unknown>,
    })),
    wires: sim.wires.map((w) => ({
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
    fileGroups,
    activeGroupId: editor.activeGroupId,
  };
}

export function useAgentSync(sessionId: string | null) {
  const { clearTrace, ingestEvent, markSnapshotSynced, setError, setStreamStatus, upsertSession } =
    useAgentStore();

  const streamRef = useRef<AgentEventStream | null>(null);
  const reconcilingRef = useRef(false);
  const syncCanvasDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncedFingerprintRef = useRef<string | null>(null);

  const bumpSessionStatus = (id: string, status: string, updatedAt: string) => {
    const existing = useAgentStore.getState().sessions.find((s) => s.id === id);
    if (!existing) return;
    upsertSession({ ...existing, status, updatedAt });
  };

  const applySnapshotToStores = (snapshot: ProjectSnapshotV2) => {
    const warningMessages: string[] = [];
    const editorState = useEditorStore.getState();
    const simulatorState = useSimulatorStore.getState();
    const boardKindById = new Map(
      snapshot.boards.map((board) => [board.id, board.boardKind as BoardKind]),
    );
    const boardKindToId = new Map(
      snapshot.boards.map((board) => [board.boardKind as string, board.id]),
    );
    const resolveComponentId = (componentId: string): string => {
      if (boardKindById.has(componentId)) return componentId;
      const resolvedId = boardKindToId.get(componentId);
      if (resolvedId) return resolvedId;
      return componentId;
    };
    const resolveBoardKind = (componentId: string): BoardKind | undefined => {
      const direct = boardKindById.get(componentId);
      if (direct) return direct;
      if (boardKindToId.has(componentId)) return componentId as BoardKind;
      return undefined;
    };
    const componentById = new Map(
      snapshot.components.map((component) => [component.id, component]),
    );

    simulatorState.hydrateBoardsFromSnapshot(
      (snapshot.boards ?? []).map((board) => ({
        id: board.id,
        boardKind: board.boardKind as BoardKind,
        x: board.x,
        y: board.y,
        languageMode: board.languageMode,
        activeFileGroupId: board.activeFileGroupId,
      })),
      snapshot.activeBoardId,
    );

    const nextFileGroups: Record<string, WorkspaceFile[]> = {};
    const nextActiveGroupFileId: Record<string, string> = {};
    const nextOpenGroupFileIds: Record<string, string[]> = {};

    for (const [groupId, snapshotFiles] of Object.entries(snapshot.fileGroups ?? {})) {
      const existingGroup = editorState.fileGroups[groupId] ?? [];
      const existingByName = new Map(existingGroup.map((file) => [file.name, file]));
      const nextGroup: WorkspaceFile[] = [];

      for (const snapFile of snapshotFiles) {
        const existing = existingByName.get(snapFile.name);
        if (existing && existing.modified && existing.content !== snapFile.content) {
          const dot = snapFile.name.lastIndexOf('.');
          const base = dot > 0 ? snapFile.name.slice(0, dot) : snapFile.name;
          const ext = dot > 0 ? snapFile.name.slice(dot) : '';
          nextGroup.push(existing);
          nextGroup.push({
            id: crypto.randomUUID(),
            name: `${base}-agent${ext}`,
            content: snapFile.content,
            modified: false,
          });
          warningMessages.push(
            `Kept local edits in ${snapFile.name}, wrote agent update to ${base}-agent${ext}.`,
          );
        } else {
          nextGroup.push({
            id: existing?.id ?? crypto.randomUUID(),
            name: snapFile.name,
            content: snapFile.content,
            modified: false,
          });
        }
      }

      for (const file of existingGroup) {
        if (!snapshotFiles.some((snap) => snap.name === file.name) && file.modified) {
          nextGroup.push(file);
          warningMessages.push(`Preserved unsaved local file ${file.name} in ${groupId}.`);
        }
      }

      nextFileGroups[groupId] = nextGroup;
      nextActiveGroupFileId[groupId] = nextGroup[0]?.id ?? '';
      nextOpenGroupFileIds[groupId] = nextGroup[0] ? [nextGroup[0].id] : [];
    }

    const selectedGroupId =
      snapshot.activeGroupId && nextFileGroups[snapshot.activeGroupId]
        ? snapshot.activeGroupId
        : (Object.keys(nextFileGroups)[0] ?? editorState.activeGroupId);
    const selectedFiles = nextFileGroups[selectedGroupId] ?? [];
    useEditorStore.setState({
      fileGroups: nextFileGroups,
      activeGroupId: selectedGroupId,
      activeGroupFileId: nextActiveGroupFileId,
      openGroupFileIds: nextOpenGroupFileIds,
      files: selectedFiles,
      activeFileId: nextActiveGroupFileId[selectedGroupId] ?? selectedFiles[0]?.id ?? '',
      openFileIds: nextOpenGroupFileIds[selectedGroupId] ?? [],
    });

    simulatorState.setComponents(snapshot.components ?? []);
    const unresolvedBoardPins: string[] = [];
    const unresolvedComponentPins: string[] = [];
    simulatorState.setWires(
      (snapshot.wires ?? []).map((wire) => {
        const startId = resolveComponentId(wire.start.componentId);
        const endId = resolveComponentId(wire.end.componentId);

        const normalizeComponentPin = (componentId: string, rawPinName: string): string => {
          const comp = componentById.get(componentId);
          if (!comp) return rawPinName.trim();
          const pins = getAllPinPositions(comp.id, comp.x + 4, comp.y + 6);
          if (pins.length === 0) return rawPinName.trim();
          const target = rawPinName.trim().toLowerCase();
          const exact = pins.find((p) => p.name === rawPinName.trim());
          if (exact) return exact.name;
          const ci = pins.find((p) => p.name.trim().toLowerCase() === target);
          if (ci) return ci.name;
          if (!rawPinName.includes('.')) {
            const targetDot = `${rawPinName}.1`.trim().toLowerCase();
            const ciDot = pins.find((p) => p.name.trim().toLowerCase() === targetDot);
            if (ciDot) return ciDot.name;
          }
          return rawPinName.trim();
        };

        const normalizedStartPin = isBoardComponent(startId)
          ? normalizeBoardPinName(resolveBoardKind(startId) ?? startId, wire.start.pinName)
          : normalizeComponentPin(startId, wire.start.pinName);
        const normalizedEndPin = isBoardComponent(endId)
          ? normalizeBoardPinName(resolveBoardKind(endId) ?? endId, wire.end.pinName)
          : normalizeComponentPin(endId, wire.end.pinName);

        if (isBoardComponent(startId)) {
          const boardKind = resolveBoardKind(startId) ?? startId;
          if (boardPinToNumber(boardKind, normalizedStartPin) === null) {
            unresolvedBoardPins.push(`${startId}:${wire.start.pinName}`);
          }
        } else {
          const comp = componentById.get(startId);
          if (!comp) {
            unresolvedComponentPins.push(`${startId}:${wire.start.pinName}`);
          } else {
            const pins = getAllPinPositions(comp.id, comp.x + 4, comp.y + 6);
            if (
              pins.length > 0 &&
              !pins.some((p) => {
                const n = p.name.trim().toLowerCase();
                const raw = wire.start.pinName.trim();
                const rawLc = raw.toLowerCase();
                return (
                  n === rawLc ||
                  n === `${rawLc}.1` ||
                  n === normalizedStartPin.trim().toLowerCase() ||
                  n === `${normalizedStartPin.trim().toLowerCase()}.1`
                );
              })
            ) {
              unresolvedComponentPins.push(`${startId}:${wire.start.pinName}`);
            }
          }
        }

        if (isBoardComponent(endId)) {
          const boardKind = resolveBoardKind(endId) ?? endId;
          if (boardPinToNumber(boardKind, normalizedEndPin) === null) {
            unresolvedBoardPins.push(`${endId}:${wire.end.pinName}`);
          }
        } else {
          const comp = componentById.get(endId);
          if (!comp) {
            unresolvedComponentPins.push(`${endId}:${wire.end.pinName}`);
          } else {
            const pins = getAllPinPositions(comp.id, comp.x + 4, comp.y + 6);
            if (
              pins.length > 0 &&
              !pins.some((p) => {
                const n = p.name.trim().toLowerCase();
                const raw = wire.end.pinName.trim();
                const rawLc = raw.toLowerCase();
                return (
                  n === rawLc ||
                  n === `${rawLc}.1` ||
                  n === normalizedEndPin.trim().toLowerCase() ||
                  n === `${normalizedEndPin.trim().toLowerCase()}.1`
                );
              })
            ) {
              unresolvedComponentPins.push(`${endId}:${wire.end.pinName}`);
            }
          }
        }

        return {
          ...wire,
          start: { ...wire.start, componentId: startId, pinName: normalizedStartPin },
          end: { ...wire.end, componentId: endId, pinName: normalizedEndPin },
          waypoints: wire.waypoints ?? [],
          color: wire.color ?? '#22c55e',
          signalType:
            wire.signalType && WIRE_SIGNAL_TYPES.has(wire.signalType as WireSignalType)
              ? (wire.signalType as WireSignalType)
              : undefined,
        };
      }),
    );
    simulatorState.recalculateAllWirePositions();

    if (warningMessages.length > 0) {
      console.warn('[Agent Sync] applied with warnings:', warningMessages);
    }
  };

  const flushCanvasPins = (changedMetadataIds?: string[]) => {
    const { boards, components } = useSimulatorStore.getState();
    if (changedMetadataIds) {
      for (const mid of changedMetadataIds) {
        invalidatePinObservationCache(mid);
      }
    }
    void scanAndReportCanvasPins({ boards, components, upgradeDelayMs: 250 });
  };

  const handleFrontendActionRequest = async (event: { payload?: Record<string, unknown> }) => {
    if (!sessionId) return;
    const payload = event.payload ?? {};
    const actionId = typeof payload.actionId === 'string' ? payload.actionId : null;
    const action = typeof payload.action === 'string' ? payload.action : null;
    if (!actionId || !action) return;

    const request: FrontendActionRequest = {
      actionId,
      action,
      payload:
        typeof payload.payload === 'object' && payload.payload
          ? (payload.payload as Record<string, unknown>)
          : undefined,
      timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined,
    };

    const result = await runFrontendAction(request);
    await postFrontendActionResult(sessionId, actionId, { ...result, action });
  };

  const reconcileEvents = async (id: string, fromSeq: number) => {
    if (reconcilingRef.current) return;
    reconcilingRef.current = true;
    try {
      const replay = await listAgentSessionEvents(id, fromSeq - 1);
      const sorted = [...replay].sort((a, b) => a.seq - b.seq);
      for (const ev of sorted) {
        ingestEvent(id, ev);
        if (ev.eventType === 'run.started') bumpSessionStatus(id, 'running', ev.createdAt);
        if (ev.eventType === 'run.completed') bumpSessionStatus(id, 'completed', ev.createdAt);
        if (ev.eventType === 'run.failed') bumpSessionStatus(id, 'failed', ev.createdAt);
        if (ev.eventType === 'run.cancelled') bumpSessionStatus(id, 'stopped', ev.createdAt);
      }
      if (sorted.some((ev) => ev.eventType === 'snapshot.updated')) {
        const snapshot = await getAgentSessionSnapshot(id);
        applySnapshotToStores(snapshot);
        markSnapshotSynced(id);
        flushCanvasPins();
      }
    } catch (err: unknown) {
      console.error('Stream recovery failed', err);
    } finally {
      reconcilingRef.current = false;
    }
  };

  useEffect(() => {
    if (!sessionId) {
      streamRef.current?.stop();
      streamRef.current = null;
      setStreamStatus('idle');
      return;
    }
    let cancelled = false;
    const loadHistory = async () => {
      const lastSeq = useAgentStore.getState().lastSeqBySession[sessionId] ?? 0;
      if (lastSeq > 0) return;
      clearTrace(sessionId);
      try {
        const replay = await listAgentSessionEvents(sessionId, 0);
        if (cancelled) return;
        const sorted = [...replay].sort((a, b) => a.seq - b.seq);
        for (const ev of sorted) {
          ingestEvent(sessionId, ev);
          if (ev.eventType === 'run.started') bumpSessionStatus(sessionId, 'running', ev.createdAt);
          if (ev.eventType === 'run.completed')
            bumpSessionStatus(sessionId, 'completed', ev.createdAt);
          if (ev.eventType === 'run.failed') bumpSessionStatus(sessionId, 'failed', ev.createdAt);
          if (ev.eventType === 'run.cancelled')
            bumpSessionStatus(sessionId, 'stopped', ev.createdAt);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          console.warn('Failed to preload session history', err);
        }
      }
    };

    void loadHistory();

    streamRef.current?.stop();
    const stream = new AgentEventStream(
      sessionId,
      useAgentStore.getState().lastSeqBySession[sessionId] ?? 0,
      {
        onStatus: (status) => setStreamStatus(status),
        onError: (msg) => setError(msg),
        onGap: async (expectedNextSeq, actualSeq) => {
          console.warn(
            `Stream gap detected (expected ${expectedNextSeq}, got ${actualSeq}). Replaying...`,
          );
          await reconcileEvents(sessionId, expectedNextSeq);
        },
        onEvent: async (event) => {
          ingestEvent(sessionId, event);
          if (event.eventType === 'frontend.action.request') {
            void handleFrontendActionRequest(event);
          }
          if (event.eventType === 'run.started')
            bumpSessionStatus(sessionId, 'running', event.createdAt);
          if (event.eventType === 'run.completed')
            bumpSessionStatus(sessionId, 'completed', event.createdAt);
          if (event.eventType === 'run.failed')
            bumpSessionStatus(sessionId, 'failed', event.createdAt);
          if (event.eventType === 'run.cancelled')
            bumpSessionStatus(sessionId, 'stopped', event.createdAt);
          if (event.eventType === 'snapshot.updated') {
            try {
              const snapshot = await getAgentSessionSnapshot(sessionId);
              applySnapshotToStores(snapshot);
              markSnapshotSynced(sessionId);
              const payload = event.payload ?? {};
              const changedComponentIds = Array.isArray(payload.changedComponentIds)
                ? (payload.changedComponentIds as string[])
                : [];
              const changedBoardIds = Array.isArray(payload.changedBoardIds)
                ? (payload.changedBoardIds as string[])
                : [];
              const { components: storeComponents, boards: storeBoards } =
                useSimulatorStore.getState();
              const changedMetadataIds = [
                ...changedComponentIds.flatMap((cid) => {
                  const c = storeComponents.find((c) => c.id === cid);
                  return c ? [c.metadataId] : [];
                }),
                ...changedBoardIds.flatMap((bid) => {
                  const b = storeBoards.find((b) => b.id === bid);
                  return b ? [b.boardKind] : [];
                }),
              ];
              flushCanvasPins(changedMetadataIds.length > 0 ? changedMetadataIds : undefined);
            } catch (err: unknown) {
              console.error('Snapshot refresh failed', err);
            }
          }
        },
      },
    );
    streamRef.current = stream;
    stream.start();
    return () => {
      cancelled = true;
      stream.stop();
      if (streamRef.current === stream) streamRef.current = null;
    };
  }, [sessionId, clearTrace, ingestEvent, markSnapshotSynced, setError, setStreamStatus]);

  useEffect(() => {
    if (!sessionId) return;

    const scheduleSync = () => {
      const sessionStatus = useAgentStore
        .getState()
        .sessions.find((s) => s.id === sessionId)?.status;
      if (sessionStatus === 'running' || sessionStatus === 'queued') return;

      const sim = useSimulatorStore.getState();
      const editor = useEditorStore.getState();

      const fingerprint = [
        sim.boards.map((b) => `${b.id}:${b.x}:${b.y}`).join('|'),
        sim.components.map((c) => `${c.id}:${c.x}:${c.y}`).join('|'),
        sim.wires
          .map(
            (w) =>
              `${w.id}:${w.start.componentId}:${w.start.pinName}:${w.end.componentId}:${w.end.pinName}`,
          )
          .join('|'),
        Object.entries(editor.fileGroups)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([gid, fs]) => `${gid}:${fs.map((f) => `${f.name}=${f.content}`).join(',')}`)
          .join('|'),
      ].join('||');

      if (fingerprint === lastSyncedFingerprintRef.current) return;

      if (syncCanvasDebounceRef.current) clearTimeout(syncCanvasDebounceRef.current);
      syncCanvasDebounceRef.current = setTimeout(() => {
        const liveSnapshot = buildSnapshotFromStores();
        syncCanvasToSession(sessionId, liveSnapshot)
          .then(() => {
            lastSyncedFingerprintRef.current = fingerprint;
          })
          .catch(() => {
            // Non-fatal
          });
      }, 1500);
    };

    const unsubSim = useSimulatorStore.subscribe(scheduleSync);
    const unsubEditor = useEditorStore.subscribe(scheduleSync);

    return () => {
      unsubSim();
      unsubEditor();
      if (syncCanvasDebounceRef.current) clearTimeout(syncCanvasDebounceRef.current);
    };
  }, [sessionId]);
}
