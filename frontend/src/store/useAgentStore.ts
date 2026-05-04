import { create } from 'zustand';
import type { AgentSession, AgentSessionEvent } from '../services/agentSessions';

const AGENT_PANEL_OPEN_KEY = 'velxio.agent.panel.open';
const AGENT_PANEL_WIDTH_KEY = 'velxio.agent.panel.width';
const AGENT_PANEL_COMPACT_KEY = 'velxio.agent.panel.compact';

const AGENT_PANEL_DEFAULT_WIDTH = 360;
const AGENT_PANEL_MIN = 280;
const AGENT_PANEL_MAX = 720;

interface AgentState {
  panelOpen: boolean;
  panelWidth: number;
  compactView: boolean;
  sessions: AgentSession[];
  activeSessionId: string | null;
  defaultModelName: string;
  isLoadingSessions: boolean;
  isSendingMessage: boolean;
  streamStatus: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
  lastSeqBySession: Record<string, number>;
  tracesBySession: Record<string, AgentTraceItem[]>;
  bufferedTextBySession: Record<string, string>;
  pendingToolBySession: Record<string, Record<string, PendingToolCall>>;
  lastSnapshotSyncBySession: Record<string, string>;
  syncWarning: string | null;
  error: string | null;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  setPanelWidth: (width: number) => void;
  setCompactView: (compact: boolean) => void;
  setSessions: (sessions: AgentSession[]) => void;
  upsertSession: (session: AgentSession) => void;
  setActiveSessionId: (sessionId: string | null) => void;
  setDefaultModelName: (model: string) => void;
  setIsLoadingSessions: (loading: boolean) => void;
  setIsSendingMessage: (sending: boolean) => void;
  setStreamStatus: (status: AgentState['streamStatus']) => void;
  ingestEvent: (sessionId: string, event: AgentSessionEvent) => void;
  clearTrace: (sessionId: string) => void;
  markSnapshotSynced: (sessionId: string) => void;
  setSyncWarning: (warning: string | null) => void;
  setError: (error: string | null) => void;
}

export interface PendingToolCall {
  toolCallId: string;
  tool: string;
  startedAt?: string;
}

export interface AgentTraceItem {
  id: string;
  sessionId: string;
  seq: number;
  eventType: string;
  createdAt: string;
  compactText: string;
  payload: Record<string, unknown>;
  expanded: boolean;
}

function clampPanelWidth(width: number): number {
  return Math.max(AGENT_PANEL_MIN, Math.min(AGENT_PANEL_MAX, width));
}

function readLocalBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === '1';
  } catch {
    return fallback;
  }
}

function readLocalNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export const useAgentStore = create<AgentState>((set) => ({
  panelOpen: readLocalBoolean(AGENT_PANEL_OPEN_KEY, false),
  panelWidth: clampPanelWidth(readLocalNumber(AGENT_PANEL_WIDTH_KEY, AGENT_PANEL_DEFAULT_WIDTH)),
  compactView: readLocalBoolean(AGENT_PANEL_COMPACT_KEY, true),
  sessions: [],
  activeSessionId: null,
  defaultModelName: 'openai:gpt-5.4-mini',
  isLoadingSessions: false,
  isSendingMessage: false,
  streamStatus: 'idle',
  lastSeqBySession: {},
  tracesBySession: {},
  bufferedTextBySession: {},
  pendingToolBySession: {},
  lastSnapshotSyncBySession: {},
  syncWarning: null,
  error: null,

  setPanelOpen: (panelOpen) => {
    try {
      localStorage.setItem(AGENT_PANEL_OPEN_KEY, panelOpen ? '1' : '0');
    } catch {
      // Ignore storage errors.
    }
    set({ panelOpen });
  },
  togglePanel: () =>
    set((state) => {
      const next = !state.panelOpen;
      try {
        localStorage.setItem(AGENT_PANEL_OPEN_KEY, next ? '1' : '0');
      } catch {
        // Ignore storage errors.
      }
      return { panelOpen: next };
    }),
  setPanelWidth: (panelWidth) => {
    const next = clampPanelWidth(panelWidth);
    try {
      localStorage.setItem(AGENT_PANEL_WIDTH_KEY, String(next));
    } catch {
      // Ignore storage errors.
    }
    set({ panelWidth: next });
  },
  setCompactView: (compactView) => {
    try {
      localStorage.setItem(AGENT_PANEL_COMPACT_KEY, compactView ? '1' : '0');
    } catch {
      // Ignore storage errors.
    }
    set({ compactView });
  },
  setSessions: (sessions) =>
    set((state) => {
      const activeSessionStillExists =
        state.activeSessionId !== null && sessions.some((s) => s.id === state.activeSessionId);
      return {
        sessions,
        activeSessionId: activeSessionStillExists
          ? state.activeSessionId
          : (sessions[0]?.id ?? null),
      };
    }),
  upsertSession: (session) =>
    set((state) => {
      const index = state.sessions.findIndex((s) => s.id === session.id);
      if (index === -1) {
        return { sessions: [session, ...state.sessions], activeSessionId: session.id };
      }
      const sessions = [...state.sessions];
      sessions[index] = session;
      sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return { sessions };
    }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  setDefaultModelName: (defaultModelName) => set({ defaultModelName }),
  setIsLoadingSessions: (isLoadingSessions) => set({ isLoadingSessions }),
  setIsSendingMessage: (isSendingMessage) => set({ isSendingMessage }),
  setStreamStatus: (streamStatus) => set({ streamStatus }),
  ingestEvent: (sessionId, event) =>
    set((state) => {
      const lastSeq = state.lastSeqBySession[sessionId] ?? 0;
      if (event.seq <= lastSeq) return state;

      const traces = [...(state.tracesBySession[sessionId] ?? [])];
      const pendingBySession = { ...(state.pendingToolBySession[sessionId] ?? {}) };
      const bufferedText = state.bufferedTextBySession[sessionId] ?? '';

      let nextBufferedText = bufferedText;
      let nextTrace: AgentTraceItem | null = null;

      // DEBUG: Log all events to see what's coming through
      console.log('[ingestEvent]', event.eventType, event.seq, event.payload);

      if (event.eventType === 'model.output.delta') {
        const delta = typeof event.payload?.delta === 'string' ? event.payload.delta : '';
        nextBufferedText = bufferedText + delta;
      } else if (event.eventType === 'model.output.final') {
        const finalText = nextBufferedText.trim();
        if (finalText) {
          nextTrace = {
            id: `trace-${sessionId}-${event.seq}`,
            sessionId,
            seq: event.seq,
            eventType: 'model.output.final',
            createdAt: event.createdAt,
            compactText: finalText,
            payload: event.payload ?? {},
            expanded: false,
          };
        }
        nextBufferedText = '';
      } else if (event.eventType === 'tool.call.started') {
        const toolCallId =
          typeof event.payload?.toolCallId === 'string'
            ? event.payload.toolCallId
            : `tool-${event.seq}-${Math.random().toString(36).slice(2, 8)}`;
        const tool = typeof event.payload?.tool === 'string' ? event.payload.tool : 'tool';
        pendingBySession[toolCallId] = { toolCallId, tool, startedAt: event.createdAt };
        // Also store as a trace so in-progress calls are visible in the UI.
        nextTrace = {
          id: `trace-${sessionId}-${event.seq}`,
          sessionId,
          seq: event.seq,
          eventType: event.eventType,
          createdAt: event.createdAt,
          compactText: `${tool} …`,
          payload: { ...event.payload, toolCallId },
          expanded: false,
        };
      } else if (event.eventType === 'tool.call.result') {
        const toolCallId =
          typeof event.payload?.toolCallId === 'string' ? event.payload.toolCallId : undefined;
        const toolNameFromPayload =
          typeof event.payload?.tool === 'string' ? event.payload.tool : undefined;
        const pending = toolCallId ? pendingBySession[toolCallId] : undefined;
        const toolName = toolNameFromPayload ?? pending?.tool ?? 'tool';
        nextTrace = {
          id: `trace-${sessionId}-${event.seq}`,
          sessionId,
          seq: event.seq,
          eventType: event.eventType,
          createdAt: event.createdAt,
          compactText: `${toolName} completed`,
          payload: { ...event.payload, toolCallId },
          expanded: false,
        };
        if (toolCallId) delete pendingBySession[toolCallId];
      } else if (event.eventType === 'run.started') {
        const msg = typeof event.payload?.message === 'string' ? event.payload.message : '';
        nextTrace = {
          id: `trace-${sessionId}-${event.seq}`,
          sessionId,
          seq: event.seq,
          eventType: event.eventType,
          createdAt: event.createdAt,
          compactText: msg ? `Run started: ${msg.slice(0, 120)}` : 'Run started',
          payload: event.payload ?? {},
          expanded: false,
        };
      } else if (event.eventType === 'run.completed') {
        const outputFromPayload =
          typeof event.payload?.output === 'string' ? event.payload.output.trim() : '';
        const finalText = (nextBufferedText || outputFromPayload).trim();
        if (finalText) {
          nextTrace = {
            id: `trace-${sessionId}-${event.seq}`,
            sessionId,
            seq: event.seq,
            eventType: 'model.output.final',
            createdAt: event.createdAt,
            compactText: finalText,
            payload: event.payload ?? {},
            expanded: false,
          };
        }
        nextBufferedText = '';
      } else if (event.eventType === 'snapshot.updated') {
        const parts = [
          Array.isArray(event.payload?.changedBoardIds)
            ? `boards ${(event.payload.changedBoardIds as unknown[]).length}`
            : null,
          Array.isArray(event.payload?.changedComponentIds)
            ? `components ${(event.payload.changedComponentIds as unknown[]).length}`
            : null,
          Array.isArray(event.payload?.changedWireIds)
            ? `wires ${(event.payload.changedWireIds as unknown[]).length}`
            : null,
          Array.isArray(event.payload?.changedFileGroups)
            ? `files ${(event.payload.changedFileGroups as unknown[]).length}`
            : null,
        ].filter(Boolean);
        nextTrace = {
          id: `trace-${sessionId}-${event.seq}`,
          sessionId,
          seq: event.seq,
          eventType: event.eventType,
          createdAt: event.createdAt,
          compactText: `Snapshot updated${parts.length ? ` (${parts.join(', ')})` : ''}`,
          payload: event.payload ?? {},
          expanded: false,
        };
      } else {
        nextTrace = {
          id: `trace-${sessionId}-${event.seq}`,
          sessionId,
          seq: event.seq,
          eventType: event.eventType,
          createdAt: event.createdAt,
          compactText: event.eventType,
          payload: event.payload ?? {},
          expanded: false,
        };
      }

      if (nextTrace) traces.push(nextTrace);
      traces.sort((a, b) => a.seq - b.seq);

      return {
        lastSeqBySession: { ...state.lastSeqBySession, [sessionId]: event.seq },
        tracesBySession: { ...state.tracesBySession, [sessionId]: traces },
        bufferedTextBySession: { ...state.bufferedTextBySession, [sessionId]: nextBufferedText },
        pendingToolBySession: { ...state.pendingToolBySession, [sessionId]: pendingBySession },
      };
    }),
  clearTrace: (sessionId) =>
    set((state) => ({
      tracesBySession: { ...state.tracesBySession, [sessionId]: [] },
      lastSeqBySession: { ...state.lastSeqBySession, [sessionId]: 0 },
      bufferedTextBySession: { ...state.bufferedTextBySession, [sessionId]: '' },
      pendingToolBySession: { ...state.pendingToolBySession, [sessionId]: {} },
    })),
  markSnapshotSynced: (sessionId) =>
    set((state) => ({
      lastSnapshotSyncBySession: {
        ...state.lastSnapshotSyncBySession,
        [sessionId]: new Date().toISOString(),
      },
    })),
  setSyncWarning: (syncWarning) => set({ syncWarning }),
  setError: (error) => set({ error }),
}));

export const agentPanelBounds = {
  min: AGENT_PANEL_MIN,
  max: AGENT_PANEL_MAX,
};
