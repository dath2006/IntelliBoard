import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceFile } from '../../store/useEditorStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useAgentStore } from '../../store/useAgentStore';
import {
  type ProjectSnapshotV2,
  applyAgentSession,
  createAgentSession,
  discardAgentSession,
  getAgentSessionSnapshot,
  listAgentSessionEvents,
  listAgentSessions,
  sendAgentMessage,
  stopAgentSession,
  syncCanvasToSession,
} from '../../services/agentSessions';
import { AgentEventStream } from './AgentEventStream';
import { ModelSelector } from './ModelSelector';
import { ToolTraceRow } from './ToolTraceRow';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import type { BoardKind } from '../../types/board';
import type { WireSignalType } from '../../types/wire';
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

type ChatRow = {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  expandable?: boolean;
  // tool-specific
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolFailed?: boolean;
};

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const boldRegex = /\*\*(.+?)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null = null;
  while ((match = boldRegex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(<strong key={`b-${match.index}-${match[0].length}`}>{match[1]}</strong>);
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderMarkdownLite(text: string): React.ReactNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*-\s+/, '');
        items.push(<li key={`li-${i}`}>{renderInlineMarkdown(itemText)}</li>);
        i += 1;
      }
      blocks.push(<ul key={`ul-${i}`}>{items}</ul>);
      continue;
    }
    const paragraphLines: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      paragraphLines.push(lines[i]);
      i += 1;
    }
    const para = paragraphLines.join(' ').trim();
    blocks.push(<p key={`p-${i}`}>{renderInlineMarkdown(para)}</p>);
  }
  return <>{blocks}</>;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

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
function buildSnapshotFromStores(): ProjectSnapshotV2 {
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
      start: { componentId: w.start.componentId, pinName: w.start.pinName, x: w.start.x ?? 0, y: w.start.y ?? 0 },
      end: { componentId: w.end.componentId, pinName: w.end.pinName, x: w.end.x ?? 0, y: w.end.y ?? 0 },
      waypoints: w.waypoints ?? [],
      color: w.color ?? '#22c55e',
      signalType: (w.signalType as string | null | undefined) ?? null,
    })),
    fileGroups,
    activeGroupId: editor.activeGroupId,
  };
}

function statusClass(status: string): string {
  if (status === 'running' || status === 'queued') return 'agent-status-badge--running';
  if (status === 'completed') return 'agent-status-badge--completed';
  if (status === 'failed') return 'agent-status-badge--failed';
  if (status === 'stopped') return 'agent-status-badge--stopped';
  return 'agent-status-badge--idle';
}

export const AgentPanel: React.FC = () => {
  const currentProject = useProjectStore((s) => s.currentProject);
  const {
    sessions,
    activeSessionId,
    defaultModelName,
    isLoadingSessions,
    isSendingMessage,
    streamStatus,
    tracesBySession,
    bufferedTextBySession,
    syncWarning,
    error,
    setActiveSessionId,
    setDefaultModelName,
    setSessions,
    upsertSession,
    setIsLoadingSessions,
    setIsSendingMessage,
    setStreamStatus,
    ingestEvent,
    markSnapshotSynced,
    setSyncWarning,
    setError,
  } = useAgentStore();

  const [message, setMessage] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isRecoveringStream, setIsRecoveringStream] = useState(false);
  const [streamRecoveryWarning, setStreamRecoveryWarning] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const streamRef = useRef<AgentEventStream | null>(null);
  const reconcilingRef = useRef(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );
  const hasProject = Boolean(currentProject?.id);
  const runIsActive = activeSession?.status === 'running' || activeSession?.status === 'queued';
  const activeTraces = activeSessionId ? (tracesBySession[activeSessionId] ?? []) : [];
  const streamingAssistantText = activeSessionId
    ? (bufferedTextBySession[activeSessionId] ?? '')
    : '';
  const actionBusy = isApplying || isDiscarding || isStopping || isSendingMessage;

  // Pending changes are derived from stream events:
  // show Accept/Reject only if there was a snapshot mutation since last apply/discard.
  const lastSnapshotUpdatedTrace = useMemo(() => {
    const sorted = [...activeTraces].sort((a, b) => b.seq - a.seq);
    return sorted.find((t) => t.eventType === 'snapshot.updated') ?? null;
  }, [activeTraces]);
  const lastDecisionSeq = useMemo(() => {
    const sorted = [...activeTraces].sort((a, b) => b.seq - a.seq);
    const decision = sorted.find(
      (t) => t.eventType === 'session.applied' || t.eventType === 'session.discarded',
    );
    return decision?.seq ?? 0;
  }, [activeTraces]);
  const hasPendingChanges = Boolean(
    lastSnapshotUpdatedTrace && lastSnapshotUpdatedTrace.seq > lastDecisionSeq,
  );
  const showAcceptReject = !!activeSession && !runIsActive && hasPendingChanges;

  const pendingSummary = useMemo(() => {
    if (!lastSnapshotUpdatedTrace) return null;
    const payload = lastSnapshotUpdatedTrace.payload ?? {};
    const changedBoards = Array.isArray(payload.changedBoardIds)
      ? payload.changedBoardIds.length
      : 0;
    const changedComponents = Array.isArray(payload.changedComponentIds)
      ? payload.changedComponentIds.length
      : 0;
    const changedWires = Array.isArray(payload.changedWireIds) ? payload.changedWireIds.length : 0;
    const changedFiles = Array.isArray(payload.changedFileGroups)
      ? payload.changedFileGroups.length
      : 0;
    const tool = typeof payload.tool === 'string' ? payload.tool : undefined;
    return {
      tool,
      changedBoards,
      changedComponents,
      changedWires,
      changedFiles,
      payload,
      createdAt: lastSnapshotUpdatedTrace.createdAt,
      seq: lastSnapshotUpdatedTrace.seq,
    };
  }, [lastSnapshotUpdatedTrace]);

  const refreshSessionsForProject = async (projectId?: string) => {
    const freshSessions = await listAgentSessions(projectId);
    setSessions(freshSessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
  };

  const bumpSessionStatus = (sessionId: string, status: string, updatedAt: string) => {
    const existing = useAgentStore.getState().sessions.find((s) => s.id === sessionId);
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
    // Reverse lookup: boardKind → board id. Used to resolve wires that
    // reference a board by its boardKind string (e.g. "esp32") instead of its
    // instance id (e.g. "arduino-uno" after change_board_kind).
    const boardKindToId = new Map(
      snapshot.boards.map((board) => [board.boardKind as string, board.id]),
    );
    /** Resolve a wire endpoint componentId to the actual board/component id. */
    const resolveComponentId = (componentId: string): string => {
      // Already a known board id.
      if (boardKindById.has(componentId)) return componentId;
      // It's a boardKind string — find the board instance id.
      const resolvedId = boardKindToId.get(componentId);
      if (resolvedId) return resolvedId;
      // Not a board — return as-is (component id).
      return componentId;
    };
    const resolveBoardKind = (componentId: string): BoardKind | undefined => {
      // Direct lookup by board id.
      const direct = boardKindById.get(componentId);
      if (direct) return direct;
      // The componentId is itself a boardKind.
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
        // Resolve componentIds that may be boardKind strings (e.g. "esp32") to
        // the actual board instance id (e.g. "arduino-uno" after change_board_kind).
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
          ? normalizeBoardPinName(
              resolveBoardKind(startId) ?? startId,
              wire.start.pinName,
            )
          : normalizeComponentPin(startId, wire.start.pinName);
        const normalizedEndPin = isBoardComponent(endId)
          ? normalizeBoardPinName(
              resolveBoardKind(endId) ?? endId,
              wire.end.pinName,
            )
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

    if (unresolvedBoardPins.length > 0) {
      warningMessages.push(
        `Unresolved board pin names: ${[...new Set(unresolvedBoardPins)].slice(0, 6).join(', ')}${unresolvedBoardPins.length > 6 ? ' ...' : ''}`,
      );
    }
    if (unresolvedComponentPins.length > 0) {
      warningMessages.push(
        `Unresolved component pin names: ${[...new Set(unresolvedComponentPins)].slice(0, 6).join(', ')}${unresolvedComponentPins.length > 6 ? ' ...' : ''}`,
      );
    }

    setSyncWarning(warningMessages.length > 0 ? warningMessages.join(' ') : null);
  };

  /**
   * Eagerly flush a canvas pin scan after a snapshot has been applied.
   *
   * Called immediately after applySnapshotToStores() so that any newly-added
   * board or component has its pinInfo POST-ed to the backend *before* the
   * agent's next `get_canvas_runtime_pins` tool call resolves.
   *
   * `changedMetadataIds` — optional list of metadataId strings whose cache
   * entries should be invalidated first (forces a re-POST even if the pin
   * set hasn't changed, e.g. after add_component with a fresh instance).
   */
  const flushCanvasPins = (changedMetadataIds?: string[]) => {
    const { boards, components } = useSimulatorStore.getState();
    // Invalidate stale dedup cache for any metadata IDs that just changed so
    // their new DOM elements are always reported.
    if (changedMetadataIds) {
      for (const mid of changedMetadataIds) {
        invalidatePinObservationCache(mid);
      }
    }
    // Fire eagerly — no awaiting so the caller isn't blocked.
    void scanAndReportCanvasPins({ boards, components, upgradeDelayMs: 250 });
  };

  const reconcileEvents = async (sessionId: string, fromSeq: number) => {
    if (reconcilingRef.current) return;
    reconcilingRef.current = true;
    setIsRecoveringStream(true);
    try {
      const replay = await listAgentSessionEvents(sessionId, fromSeq - 1);
      const sorted = [...replay].sort((a, b) => a.seq - b.seq);
      for (const ev of sorted) {
        ingestEvent(sessionId, ev);
        if (ev.eventType === 'run.started') bumpSessionStatus(sessionId, 'running', ev.createdAt);
        if (ev.eventType === 'run.completed')
          bumpSessionStatus(sessionId, 'completed', ev.createdAt);
        if (ev.eventType === 'run.failed') bumpSessionStatus(sessionId, 'failed', ev.createdAt);
        if (ev.eventType === 'run.cancelled') bumpSessionStatus(sessionId, 'stopped', ev.createdAt);
      }
      if (sorted.some((ev) => ev.eventType === 'snapshot.updated')) {
        const snapshot = await getAgentSessionSnapshot(sessionId);
        applySnapshotToStores(snapshot);
        markSnapshotSynced(sessionId);
        // Flush pin observations so the agent's next get_canvas_runtime_pins
        // call sees live data from the freshly-rendered canvas.
        flushCanvasPins();
      }
      setStreamRecoveryWarning(null);
    } catch (err: unknown) {
      setStreamRecoveryWarning(
        err instanceof Error ? `Stream recovery failed: ${err.message}` : 'Stream recovery failed.',
      );
    } finally {
      reconcilingRef.current = false;
      setIsRecoveringStream(false);
    }
  };

  useEffect(() => {
    if (!currentProject?.id) {
      setSessions([]);
      setActiveSessionId(null);
      return;
    }
    let cancelled = false;
    setIsLoadingSessions(true);
    setError(null);
    listAgentSessions(currentProject.id)
      .then((items) => {
        if (cancelled) return;
        const sorted = [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        setSessions(sorted);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load sessions');
      })
      .finally(() => {
        if (!cancelled) setIsLoadingSessions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentProject?.id, setActiveSessionId, setError, setIsLoadingSessions, setSessions]);

  useEffect(() => {
    if (!activeSessionId) {
      streamRef.current?.stop();
      streamRef.current = null;
      setStreamStatus('idle');
      return;
    }
    streamRef.current?.stop();
    const stream = new AgentEventStream(
      activeSessionId,
      useAgentStore.getState().lastSeqBySession[activeSessionId] ?? 0,
      {
        onStatus: (status) => setStreamStatus(status),
        onError: (msg) => setError(msg),
        onGap: async (expectedNextSeq, actualSeq) => {
          setStreamRecoveryWarning(
            `Stream gap detected (expected ${expectedNextSeq}, got ${actualSeq}). Replaying...`,
          );
          await reconcileEvents(activeSessionId, expectedNextSeq);
        },
        onEvent: async (event) => {
          ingestEvent(activeSessionId, event);
          if (event.eventType === 'run.started')
            bumpSessionStatus(activeSessionId, 'running', event.createdAt);
          if (event.eventType === 'run.completed')
            bumpSessionStatus(activeSessionId, 'completed', event.createdAt);
          if (event.eventType === 'run.failed')
            bumpSessionStatus(activeSessionId, 'failed', event.createdAt);
          if (event.eventType === 'run.cancelled')
            bumpSessionStatus(activeSessionId, 'stopped', event.createdAt);
          if (
            event.eventType === 'run.completed' ||
            event.eventType === 'run.failed' ||
            event.eventType === 'run.cancelled'
          ) {
            try {
              await refreshSessionsForProject(currentProject?.id);
            } catch {
              // noop
            }
          }
          if (event.eventType === 'snapshot.updated') {
            try {
              const snapshot = await getAgentSessionSnapshot(activeSessionId);
              applySnapshotToStores(snapshot);
              markSnapshotSynced(activeSessionId);
              // Derive which metadataIds changed so we can bust their cache
              // entries and force a fresh pinInfo report to the backend.
              const payload = event.payload ?? {};
              const changedComponentIds: string[] = Array.isArray(payload.changedComponentIds)
                ? (payload.changedComponentIds as string[])
                : [];
              const changedBoardIds: string[] = Array.isArray(payload.changedBoardIds)
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
              // Eagerly scan & report — resolves before the agent can call
              // get_canvas_runtime_pins again.
              flushCanvasPins(changedMetadataIds.length > 0 ? changedMetadataIds : undefined);
            } catch (err: unknown) {
              setSyncWarning(
                err instanceof Error
                  ? `Snapshot refresh failed: ${err.message}`
                  : 'Snapshot refresh failed.',
              );
            }
          }
        },
      },
    );
    streamRef.current = stream;
    stream.start();
    return () => {
      stream.stop();
      if (streamRef.current === stream) streamRef.current = null;
    };
  }, [
    activeSessionId,
    currentProject?.id,
    ingestEvent,
    markSnapshotSynced,
    setError,
    setSessions,
    setStreamStatus,
    setSyncWarning,
  ]);

  const syncCanvasDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncedFingerprintRef = useRef<string | null>(null);

  // Whenever the canvas meaningfully changes while a session is active,
  // debounce-sync the live state back to the agent. Uses store subscriptions
  // (not React state) to avoid reference-churn false positives.
  useEffect(() => {
    if (!activeSessionId) return;

    const scheduleSync = () => {
      // Don't sync while the agent is actively running.
      const sessionStatus = useAgentStore.getState().sessions.find(
        (s) => s.id === activeSessionId,
      )?.status;
      if (sessionStatus === 'running' || sessionStatus === 'queued') return;

      const sim = useSimulatorStore.getState();
      const editor = useEditorStore.getState();

      // Build a cheap fingerprint — only sync when data actually changed.
      const fingerprint = [
        sim.boards.map((b) => `${b.id}:${b.x}:${b.y}`).join('|'),
        sim.components.map((c) => `${c.id}:${c.x}:${c.y}`).join('|'),
        sim.wires.map((w) => `${w.id}:${w.start.componentId}:${w.start.pinName}:${w.end.componentId}:${w.end.pinName}`).join('|'),
        Object.entries(editor.fileGroups)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([gid, fs]) => `${gid}:${fs.map((f) => `${f.name}=${f.content}`).join(',')}`)
          .join('|'),
      ].join('||');

      if (fingerprint === lastSyncedFingerprintRef.current) return;

      if (syncCanvasDebounceRef.current) clearTimeout(syncCanvasDebounceRef.current);
      syncCanvasDebounceRef.current = setTimeout(() => {
        const liveSnapshot = buildSnapshotFromStores();
        syncCanvasToSession(activeSessionId, liveSnapshot)
          .then(() => { lastSyncedFingerprintRef.current = fingerprint; })
          .catch(() => {
            // Non-fatal: sync failure just means the agent may have slightly stale state.
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
  }, [activeSessionId]);

  const sendPrompt = async (prompt: string) => {
    if (!prompt.trim()) return;
    if (!currentProject?.id) {
      setError('Save the project first to start an agent session.');
      return;
    }
    setIsSendingMessage(true);
    setError(null);
    setSyncWarning(null);
    try {
      let sessionId = activeSessionId;
      if (!sessionId) {
        // Pass the current live canvas state so the agent starts with the
        // latest user edits, not the potentially stale DB snapshot.
        const liveSnapshot = buildSnapshotFromStores();
        const created = await createAgentSession({
          projectId: currentProject.id,
          snapshotJson: JSON.stringify(liveSnapshot),
          modelName: defaultModelName || undefined,
        });
        upsertSession(created);
        sessionId = created.id;
      }
      const updated = await sendAgentMessage(sessionId, prompt.trim());
      upsertSession(updated);
      setMessage('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setIsSendingMessage(false);
    }
  };

  const handleStop = async () => {
    if (!activeSessionId) return;
    setIsStopping(true);
    setError(null);
    try {
      const updated = await stopAgentSession(activeSessionId);
      upsertSession(updated);
      await refreshSessionsForProject(currentProject?.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to stop session');
    } finally {
      setIsStopping(false);
    }
  };

  const handleApply = async () => {
    if (!activeSessionId) return;
    setIsApplying(true);
    setError(null);
    try {
      const updated = await applyAgentSession(activeSessionId);
      upsertSession(updated);
      const snapshot = await getAgentSessionSnapshot(activeSessionId);
      applySnapshotToStores(snapshot);
      markSnapshotSynced(activeSessionId);
      await refreshSessionsForProject(currentProject?.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to apply session');
    } finally {
      setIsApplying(false);
    }
  };

  const handleDiscard = async () => {
    if (!activeSessionId) return;
    setIsDiscarding(true);
    setError(null);
    try {
      const updated = await discardAgentSession(activeSessionId);
      upsertSession(updated);
      await refreshSessionsForProject(currentProject?.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to reject session');
    } finally {
      setIsDiscarding(false);
    }
  };

  const handleReconnectNow = async () => {
    if (!activeSessionId) return;
    setStreamRecoveryWarning(null);
    const lastSeq = useAgentStore.getState().lastSeqBySession[activeSessionId] ?? 0;
    await reconcileEvents(activeSessionId, Math.max(1, lastSeq));
    streamRef.current?.reconnectNow();
  };

  const chatRows = useMemo(() => {
    const rows: ChatRow[] = [];
    const sorted = [...activeTraces].sort((a, b) => a.seq - b.seq);

    console.log('[chatRows] Building from', sorted.length, 'traces');
    console.log('[chatRows] Event types:', sorted.map(t => t.eventType).join(', '));

    // Pre-build a map: toolCallId → result trace, so started rows can look up
    // their result and render as completed immediately.
    const resultByCallId = new Map<string, typeof sorted[number]>();
    for (const t of sorted) {
      if (t.eventType === 'tool.call.result') {
        const callId = typeof t.payload?.toolCallId === 'string' ? t.payload.toolCallId : null;
        if (callId) resultByCallId.set(callId, t);
      }
    }
    // Track which result callIds were consumed so we can render orphan results.
    const consumedResultCallIds = new Set<string>();

    for (const t of sorted) {
      if (t.eventType === 'run.started') {
        rows.push({
          id: t.id,
          kind: 'user',
          text: typeof t.payload?.message === 'string' ? t.payload.message : 'Start run',
          createdAt: t.createdAt,
        });

      } else if (t.eventType === 'model.output.final') {
        rows.push({ id: t.id, kind: 'assistant', text: t.compactText, createdAt: t.createdAt });

      } else if (t.eventType === 'tool.call.started') {
        const callId = typeof t.payload?.toolCallId === 'string' ? t.payload.toolCallId : null;
        const result = callId ? resultByCallId.get(callId) : undefined;
        const toolName = typeof t.payload?.tool === 'string' ? t.payload.tool : '';
        const input = t.payload?.input ?? null;

        if (result && callId) {
          consumedResultCallIds.add(callId);
          const output = result.payload?.output ?? null;
          const failed = typeof output === 'object' && output !== null
            && (output as Record<string, unknown>).ok === false;
          rows.push({
            id: t.id,
            kind: 'tool',
            text: toolName,
            createdAt: result.createdAt,
            toolName,
            toolInput: input,
            toolOutput: output,
            toolFailed: failed,
          });
        } else {
          // Still in progress — show as pending (no output yet).
          rows.push({
            id: t.id,
            kind: 'tool',
            text: toolName,
            createdAt: t.createdAt,
            toolName,
            toolInput: input,
            toolOutput: undefined,
          });
        }

      } else if (t.eventType === 'tool.call.result') {
        // Only render standalone if there was no matching started trace.
        const callId = typeof t.payload?.toolCallId === 'string' ? t.payload.toolCallId : null;
        if (!callId || !consumedResultCallIds.has(callId)) {
          const toolName = typeof t.payload?.tool === 'string' ? t.payload.tool : '';
          const output = t.payload?.output ?? null;
          const failed = typeof output === 'object' && output !== null
            && (output as Record<string, unknown>).ok === false;
          rows.push({
            id: t.id,
            kind: 'tool',
            text: toolName,
            createdAt: t.createdAt,
            toolName,
            toolInput: null,
            toolOutput: output,
            toolFailed: failed,
          });
        }

      } else if (t.eventType === 'run.failed' || t.eventType === 'run.cancelled') {
        rows.push({
          id: t.id,
          kind: 'system',
          text: t.eventType === 'run.cancelled'
            ? 'Run cancelled.'
            : `Run failed${typeof t.payload?.error === 'string' ? `: ${t.payload.error}` : ''}`,
          createdAt: t.createdAt,
          payload: t.payload,
          expandable: true,
        });

      } else if (t.eventType === 'snapshot.updated') {
        rows.push({
          id: t.id,
          kind: 'system',
          text: t.compactText,
          createdAt: t.createdAt,
          payload: t.payload,
          expandable: true,
        });

      } else if (t.eventType === 'session.applied') {
        rows.push({ id: t.id, kind: 'system', text: 'Changes accepted and applied to project.', createdAt: t.createdAt });

      } else if (t.eventType === 'session.discarded') {
        rows.push({ id: t.id, kind: 'system', text: 'Draft changes discarded.', createdAt: t.createdAt });
      }
    }

    if (activeSession?.status === 'queued' && !rows.some((r) => r.kind === 'assistant')) {
      rows.push({
        id: 'queued-hint',
        kind: 'system',
        text: 'Queued - waiting for agent worker to start...',
        createdAt: new Date().toISOString(),
      });
    }
    if (streamingAssistantText.trim()) {
      rows.push({
        id: 'streaming-assistant',
        kind: 'assistant',
        text: streamingAssistantText,
        createdAt: new Date().toISOString(),
      });
    }

    // Merge adjacent assistant chunks from the same response window.
    const merged: ChatRow[] = [];
    for (const row of rows) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.kind === 'assistant' &&
        row.kind === 'assistant' &&
        Math.abs(Date.parse(row.createdAt) - Date.parse(prev.createdAt)) <= 2000
      ) {
        merged[merged.length - 1] = {
          ...prev,
          text: `${prev.text}${prev.text.endsWith('\n') ? '' : '\n'}${row.text}`,
          createdAt: row.createdAt,
        };
        continue;
      }
      merged.push({ ...row });
    }
    return merged;
  }, [activeTraces, activeSession?.status, streamingAssistantText]);

  useEffect(() => {
    if (!chatScrollRef.current) return;
    chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [chatRows.length, streamingAssistantText]);

  const toggleExpand = (id: string) => setExpandedRows((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <aside className="agent-panel">
      <div className="agent-chat-header">
        <div className="agent-panel__title-wrap">
          <h3 className="agent-panel__title">Agent</h3>
          {activeSession?.status && (
            <span className={`agent-status-badge ${statusClass(activeSession.status)}`}>
              {activeSession.status}
            </span>
          )}
          {hasPendingChanges && <span className="agent-draft-badge">Draft changes</span>}
        </div>
        <button
          className="agent-panel__new-btn"
          onClick={async () => {
            if (!currentProject?.id) return;
            const liveSnapshot = buildSnapshotFromStores();
            const created = await createAgentSession({
              projectId: currentProject.id,
              snapshotJson: JSON.stringify(liveSnapshot),
              modelName: defaultModelName || undefined,
            });
            upsertSession(created);
          }}
          disabled={!hasProject || actionBusy}
        >
          New
        </button>
      </div>

      <div className="agent-chat-meta">
        <select
          value={activeSessionId ?? ''}
          onChange={(e) => setActiveSessionId(e.target.value || null)}
          disabled={isLoadingSessions || sessions.length === 0}
        >
          <option value="">No session</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id.slice(0, 8)} - {s.status}
            </option>
          ))}
        </select>
        <ModelSelector
          value={defaultModelName}
          onChange={setDefaultModelName}
          disabled={actionBusy}
        />
      </div>

      <div className="agent-chat-thread" ref={chatScrollRef}>
        {showAcceptReject && pendingSummary && (
          <div className="agent-draft-banner">
            <div className="agent-draft-banner__title">
              Draft changes ready to apply
              {pendingSummary.tool ? (
                <span className="agent-draft-banner__tool">via {pendingSummary.tool}</span>
              ) : null}
            </div>
            <div className="agent-draft-banner__meta">
              {pendingSummary.changedFiles > 0
                ? `${pendingSummary.changedFiles} file group(s)`
                : null}
              {pendingSummary.changedComponents > 0
                ? ` · ${pendingSummary.changedComponents} component(s)`
                : null}
              {pendingSummary.changedWires > 0 ? ` · ${pendingSummary.changedWires} wire(s)` : null}
              {pendingSummary.changedBoards > 0
                ? ` · ${pendingSummary.changedBoards} board(s)`
                : null}
            </div>
            <button
              className="agent-chat-row__toggle"
              onClick={() => toggleExpand(`draft-${pendingSummary.seq}`)}
            >
              {expandedRows[`draft-${pendingSummary.seq}`] ? 'Hide details' : 'Show details'}
            </button>
            {expandedRows[`draft-${pendingSummary.seq}`] && (
              <pre className="agent-panel__trace-payload">
                {JSON.stringify(pendingSummary.payload, null, 2)}
              </pre>
            )}
          </div>
        )}
        {chatRows.length === 0 ? (
          <div className="agent-panel__muted">
            Start a session and send a message to chat with the agent.
          </div>
        ) : (
          chatRows.map((row) => {
            if (row.kind === 'tool') {
              return (
                <ToolTraceRow
                  key={row.id}
                  toolName={row.toolName}
                  input={row.toolInput}
                  output={row.toolOutput}
                  createdAt={row.createdAt}
                  failed={row.toolFailed}
                />
              );
            }
            if (row.kind === 'system') {
              const isError = row.text.startsWith('Run failed');
              const isCancelled = row.text.startsWith('Run cancelled');
              const isApplied = row.text.startsWith('Changes accepted');
              const isDiscarded = row.text.startsWith('Draft changes discarded');
              return (
                <div key={row.id} className={`agent-system-row ${isError ? 'agent-system-row--error' : isCancelled ? 'agent-system-row--warn' : isApplied ? 'agent-system-row--success' : isDiscarded ? 'agent-system-row--muted' : ''}`}>
                  <span className="agent-system-row__icon">
                    {isError ? '✗' : isCancelled ? '⏹' : isApplied ? '✓' : isDiscarded ? '↩' : 'ℹ'}
                  </span>
                  <span className="agent-system-row__text">{row.text}</span>
                  {row.expandable && row.payload && (
                    <>
                      <button className="agent-system-row__toggle" onClick={() => toggleExpand(row.id)}>
                        {expandedRows[row.id] ? '▲' : '▼'}
                      </button>
                      {expandedRows[row.id] && (
                        <pre className="tool-trace__pre agent-system-row__pre">{prettyJson(row.payload)}</pre>
                      )}
                    </>
                  )}
                </div>
              );
            }
            // user / assistant
            return (
              <div key={row.id} className={`agent-chat-row agent-chat-row--${row.kind}`}>
                <div className="agent-chat-row__text">
                  {row.kind === 'assistant' ? renderMarkdownLite(row.text) : row.text}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="agent-chat-actions">
        {runIsActive && (
          <button onClick={handleStop} disabled={actionBusy || !activeSessionId}>
            {isStopping ? 'Stopping...' : 'Stop'}
          </button>
        )}
        {showAcceptReject && (
          <>
            <button onClick={handleApply} disabled={actionBusy}>
              {isApplying ? 'Accepting...' : 'Accept'}
            </button>
            <button onClick={handleDiscard} disabled={actionBusy}>
              {isDiscarding ? 'Rejecting...' : 'Reject'}
            </button>
          </>
        )}
        {(streamStatus === 'reconnecting' || streamRecoveryWarning || isRecoveringStream) && (
          <button onClick={handleReconnectNow} disabled={isRecoveringStream || !activeSessionId}>
            {isRecoveringStream ? 'Recovering...' : 'Reconnect'}
          </button>
        )}
      </div>

      <div className="agent-chat-composer">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Ask the agent to modify your circuit or code..."
          rows={3}
        />
        <button onClick={() => void sendPrompt(message)} disabled={actionBusy || !message.trim()}>
          {isSendingMessage ? 'Sending...' : 'Send'}
        </button>
      </div>

      {streamRecoveryWarning && <div className="agent-panel__warning">{streamRecoveryWarning}</div>}
      {syncWarning && <div className="agent-panel__warning">{syncWarning}</div>}
      {error && <div className="agent-panel__error">{error}</div>}
    </aside>
  );
};
