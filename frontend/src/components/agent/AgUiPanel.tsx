import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { CopilotChat, CopilotKitProvider } from '@copilotkit/react-core/v2';
import { useCoAgent } from '@copilotkit/react-core';
import { useDefaultRenderTool } from '@copilotkit/react-core/v2';
import { HttpAgent } from '@ag-ui/client';
import {
  Plus,
  Trash2,
  StopCircle,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronRight,
  Terminal,
  Cpu,
  Plug,
  Settings2,
  Zap,
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useAgentStore } from '../../store/useAgentStore';
import {
  createAgentSession,
  deleteAgentSession,
  listAgentSessions,
  type AgentSession,
} from '../../services/agentSessions';
import { useAgentSync, buildSnapshotFromStores } from './useAgentSync';
import { CompactModelSelector } from './ModelSelector';
// import './agent-panel.css';

// ── Types ─────────────────────────────────────────────────────────────────────

type AgentUiState = {
  projectId: string | null;
  sessionId: string | null;
  modelName: string | null;
  activeBoardId: string | null;
  activeGroupId: string | null;
  activeFileId: string | null;
  activeFileName: string | null;
  selectedWireId: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusMeta(status: string): { label: string; color: string; icon: React.ReactNode } {
  switch (status) {
    case 'running':
    case 'queued':
      return {
        label: status === 'queued' ? 'Queued' : 'Running',
        color: '#f59e0b',
        icon: <Loader2 size={11} className="spin" />,
      };
    case 'completed':
      return { label: 'Done', color: '#10b981', icon: <CheckCircle2 size={11} /> };
    case 'failed':
      return { label: 'Failed', color: '#ef4444', icon: <XCircle size={11} /> };
    case 'stopped':
      return { label: 'Stopped', color: '#6b7280', icon: <StopCircle size={11} /> };
    default:
      return { label: 'Idle', color: '#4b5563', icon: <Clock size={11} /> };
  }
}

function formatSessionLabel(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return 'Session';
  const now = new Date();
  const diffMs = now.getTime() - when.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return when.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── Tool renderer ─────────────────────────────────────────────────────────────

const ToolCallCard: React.FC<{
  name: string;
  parameters: unknown;
  status: 'inProgress' | 'executing' | 'complete';
  result: string | undefined;
}> = ({ name, parameters, status, result }) => {
  const [expanded, setExpanded] = useState(false);

  const isPending = status === 'inProgress' || status === 'executing';

  let parsedResult: unknown = undefined;
  let isError = false;
  if (typeof result === 'string' && result.trim()) {
    try {
      const p = JSON.parse(result) as Record<string, unknown>;
      parsedResult = p;
      isError = p.ok === false || typeof p.error === 'string';
    } catch {
      parsedResult = result;
    }
  }

  // Friendly tool label
  const label = name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const toolIcon = (() => {
    if (name.startsWith('compile')) return <Zap size={12} />;
    if (name.startsWith('connect') || name.startsWith('disconnect')) return <Plug size={12} />;
    if (name.includes('file') || name.includes('read') || name.includes('create'))
      return <Terminal size={12} />;
    if (name.includes('board') || name.includes('component')) return <Cpu size={12} />;
    return <Settings2 size={12} />;
  })();

  return (
    <div
      className={`agu-tool-card ${isPending ? 'agu-tool-card--pending' : isError ? 'agu-tool-card--error' : 'agu-tool-card--done'}`}
    >
      <button
        type="button"
        className="agu-tool-card__header"
        onClick={() => !isPending && setExpanded((v) => !v)}
      >
        <span className="agu-tool-card__icon">{toolIcon}</span>
        <span className="agu-tool-card__name">{label}</span>
        <span className="agu-tool-card__status-dot">
          {isPending ? (
            <Loader2 size={10} className="spin" />
          ) : isError ? (
            <XCircle size={10} />
          ) : (
            <CheckCircle2 size={10} />
          )}
        </span>
        {!isPending && (
          <ChevronRight
            size={10}
            className="agu-tool-card__chevron"
            style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
          />
        )}
      </button>

      {expanded && !isPending && (
        <div className="agu-tool-card__body">
          {!!parameters && Object.keys(parameters as object).length > 0 && (
            <div className="agu-tool-card__section">
              <div className="agu-tool-card__section-label">Input</div>
              <pre className="agu-tool-card__pre">{JSON.stringify(parameters, null, 2)}</pre>
            </div>
          )}
          {parsedResult !== undefined && (
            <div className="agu-tool-card__section">
              <div className="agu-tool-card__section-label">Output</div>
              <pre className="agu-tool-card__pre">
                {typeof parsedResult === 'string'
                  ? parsedResult
                  : JSON.stringify(parsedResult, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const AgUiToolRendererRegistration: React.FC = () => {
  useDefaultRenderTool({
    render: ({ name, parameters, status, result }) => (
      <ToolCallCard name={name} parameters={parameters} status={status} result={result} />
    ),
  });
  return null;
};

// ── Session Rail ──────────────────────────────────────────────────────────────

const SessionRail: React.FC<{
  sessions: AgentSession[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  loading: boolean;
}> = ({ sessions, activeSessionId, onSelect, onNew, onDelete, loading }) => {
  return (
    <div className="agu-rail">
      <div className="agu-rail__header">
        <span className="agu-rail__title">History</span>
        <button className="agu-rail__new-btn" onClick={onNew} title="New session">
          <Plus size={13} />
        </button>
      </div>

      <div className="agu-rail__list">
        {loading && (
          <div className="agu-rail__empty">
            <Loader2 size={14} className="spin" />
          </div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="agu-rail__empty">No sessions yet</div>
        )}
        {sessions.map((s) => {
          const meta = statusMeta(s.status);
          const isActive = s.id === activeSessionId;
          return (
            <div key={s.id} className={`agu-rail__item ${isActive ? 'is-active' : ''}`}>
              <button type="button" className="agu-rail__item-btn" onClick={() => onSelect(s.id)}>
                <span className="agu-rail__item-dot" style={{ color: meta.color }}>
                  {meta.icon}
                </span>
                <div className="agu-rail__item-info">
                  <span className="agu-rail__item-time">{formatSessionLabel(s.updatedAt)}</span>
                  <span className="agu-rail__item-model">
                    {s.modelName?.split(':')[1] ?? s.status}
                  </span>
                </div>
              </button>
              <button
                type="button"
                className="agu-rail__item-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(s.id);
                }}
                title="Delete session"
              >
                <Trash2 size={11} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── Chat area with CoAgent state sync ─────────────────────────────────────────

const AgUiChatCore: React.FC<{
  sessionId: string;
  projectId: string;
  activeBoardId: string | null;
  activeGroupId: string;
  activeFileId: string;
  activeFileName: string | null;
  selectedWireId: string | null;
  modelName: string;
}> = ({
  sessionId,
  projectId,
  activeBoardId,
  activeGroupId,
  activeFileId,
  activeFileName,
  selectedWireId,
  modelName,
}) => {
  useAgentSync(sessionId);
  const [historyMessages, setHistoryMessages] = useState<any[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const agentState = useMemo<AgentUiState>(
    () => ({
      projectId,
      sessionId,
      modelName,
      activeBoardId,
      activeGroupId,
      activeFileId,
      activeFileName,
      selectedWireId,
    }),
    [
      projectId,
      sessionId,
      modelName,
      activeBoardId,
      activeGroupId,
      activeFileId,
      activeFileName,
      selectedWireId,
    ],
  );

  const { setState } = useCoAgent<AgentUiState>({
    name: 'velxio',
    initialState: agentState,
  });

  const lastStateRef = useRef('');
  useEffect(() => {
    const next = JSON.stringify(agentState);
    if (next === lastStateRef.current) return;
    lastStateRef.current = next;
    
    // Defer setState to avoid updating during render
    setTimeout(() => {
      setState(agentState);
    }, 0);
  }, [agentState, setState]);

  // Load conversation history for manual rendering
  // AG-UI doesn't display history automatically
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const apiBase = import.meta.env.VITE_API_BASE || '/api';
        const response = await fetch(
          `${apiBase}/agent/sessions/${sessionId}/events?stream=false`,
          {
            credentials: 'include',
          }
        );
        
        if (!response.ok) {
          console.error('Failed to load conversation history:', response.statusText);
          setHistoryLoaded(true);
          return;
        }

        const events = await response.json();
        const messages: any[] = [];

        for (const event of events) {
          if (event.eventType === 'run.started' && event.payload?.message) {
            messages.push({
              id: `msg-${event.seq}-user`,
              role: 'user',
              content: event.payload.message,
            });
          } 
          else if (event.eventType === 'run.completed' && event.payload?.output) {
            const output = event.payload.output;
            if (output && output.trim()) {
              messages.push({
                id: `msg-${event.seq}-assistant`,
                role: 'assistant',
                content: output,
              });
            }
          }
        }

        console.log('Loaded conversation history:', messages.length, 'messages');
        setHistoryMessages(messages);
        setHistoryLoaded(true);
      } catch (error) {
        console.error('Error loading conversation history:', error);
        setHistoryLoaded(true);
      }
    };

    loadHistory();
  }, [sessionId]);

  if (!historyLoaded) {
    return (
      <div className="agu-panel__empty">
        <Loader2 size={22} className="spin" />
        <p>Loading conversation…</p>
      </div>
    );
  }

  // Manually render history using CopilotKit's CSS classes
  return (
    <div className="agu-chat-with-history-manual">
      {historyMessages.length > 0 && (
        <div className="agu-history-messages">
          {historyMessages.map((msg) => (
            <div key={msg.id} className="copilotKitMessage">
              <div className={msg.role === 'user' ? 'copilotKitUserMessage' : 'copilotKitAssistantMessage'}>
                {msg.role === 'assistant' ? <div>{msg.content}</div> : msg.content}
              </div>
            </div>
          ))}
        </div>
      )}
      <CopilotChat className="agu-chat" agentId="velxio" threadId={sessionId} />
    </div>
  );
};

// Remove the CopilotChatWithHistory component - not needed

// ── Main Panel ────────────────────────────────────────────────────────────────

export const AgUiPanel: React.FC = () => {
  const currentProject = useProjectStore((s) => s.currentProject);
  const {
    defaultModelName,
    setDefaultModelName,
    streamStatus,
    sessions,
    setActiveSessionId,
    upsertSession,
  } = useAgentStore();

  // CRITICAL FIX: Validate and fix panel width on mount
  useEffect(() => {
    const storedWidth = localStorage.getItem('velxio.agent.panel.width');
    const numericWidth = Number(storedWidth);
    
    if (!storedWidth || isNaN(numericWidth) || numericWidth < 360 || numericWidth > 800) {
      console.warn('[AgUiPanel] Invalid panel width detected, resetting to 480px');
      localStorage.setItem('velxio.agent.panel.width', '480');
      useAgentStore.getState().setPanelWidth(480);
    }
  }, []);

  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const selectedWireId = useSimulatorStore((s) => s.selectedWireId);
  const activeGroupId = useEditorStore((s) => s.activeGroupId);
  const activeFileId = useEditorStore(
    (s) => s.activeGroupFileId[s.activeGroupId] ?? s.activeFileId,
  );
  const fileGroups = useEditorStore((s) => s.fileGroups);

  const activeFileName = useMemo(() => {
    const files = fileGroups[activeGroupId] ?? [];
    return files.find((f) => f.id === activeFileId)?.name ?? null;
  }, [fileGroups, activeGroupId, activeFileId]);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === sessionId) ?? null,
    [sessions, sessionId],
  );

  const apiBase = import.meta.env.VITE_API_BASE || '/api';
  const selectedModel = (defaultModelName || '').trim();
  const agUiUrl = sessionId
    ? `${apiBase}/agent/ag-ui?sessionId=${encodeURIComponent(sessionId)}${selectedModel ? `&modelName=${encodeURIComponent(selectedModel)}` : ''}`
    : `${apiBase}/agent/ag-ui`;

  const agents = useMemo(() => ({ velxio: new HttpAgent({ url: agUiUrl }) }), [agUiUrl]);

  // ── Session management ────────────────────────────────────────────────────

  const refreshSessions = useCallback(async (projectId: string) => {
    setLoadingSessions(true);
    try {
      const items = await listAgentSessions(projectId);
      const sorted = [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      useAgentStore.getState().setSessions(sorted);
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  const createAndActivate = useCallback(
    async (projectId: string) => {
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
      
      const session = await createAgentSession({
        projectId,
        snapshotJson: JSON.stringify(snapshot),
        modelName: defaultModelName,
      });
      setSessionId(session.id);
      setActiveSessionId(session.id);
      upsertSession(session);
      await refreshSessions(projectId);
    },
    [defaultModelName, setActiveSessionId, upsertSession, refreshSessions],
  );

  const handleSelectSession = useCallback(
    (id: string) => {
      setSessionId(id);
      setActiveSessionId(id);
      setRailOpen(false);
    },
    [setActiveSessionId],
  );

  const handleNewSession = useCallback(async () => {
    if (!currentProject?.id) return;
    setSessionError(null);
    try {
      await createAndActivate(currentProject.id);
      setRailOpen(false);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Failed to create session.');
    }
  }, [currentProject?.id, createAndActivate]);

  const handleDeleteSession = useCallback(
    async (id: string) => {
      if (!currentProject?.id) return;
      const confirmed = window.confirm('Delete this session and its history?');
      if (!confirmed) return;
      setSessionError(null);
      try {
        await deleteAgentSession(id);
        await refreshSessions(currentProject.id);
        const nextSessions = useAgentStore.getState().sessions;
        const nextId = id === sessionId ? (nextSessions[0]?.id ?? null) : sessionId;
        setSessionId(nextId);
        setActiveSessionId(nextId);
      } catch (err) {
        setSessionError(err instanceof Error ? err.message : 'Failed to delete session.');
      }
    },
    [currentProject?.id, sessionId, setActiveSessionId, refreshSessions],
  );

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!currentProject?.id) {
      setSessionId(null);
      return;
    }
    let cancelled = false;
    setSessionError(null);

    // CRITICAL FIX: Wait for stores to be populated before creating session
    // This prevents capturing stale data from previous project
    const waitForStoresReady = async () => {
      // Poll until we have valid store data or timeout
      const maxAttempts = 20; // 2 seconds max wait
      const pollInterval = 100; // 100ms between checks
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const sim = useSimulatorStore.getState();
        const editor = useEditorStore.getState();
        
        // Check if stores have been initialized with project data
        // A project is "ready" when it has at least one file group
        const hasFileGroups = Object.keys(editor.fileGroups).length > 0;
        const hasFiles = Object.values(editor.fileGroups).some(files => files.length > 0);
        
        if (hasFileGroups && hasFiles) {
          return true; // Stores are ready
        }
        
        if (cancelled) return false;
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
      
      // Timeout - proceed anyway but log warning
      console.warn('[AgUiPanel] Store initialization timeout - proceeding with current state');
      return true;
    };

    const initSession = async () => {
      // Wait for stores to be ready
      const ready = await waitForStoresReady();
      if (!ready || cancelled) return;

      await refreshSessions(currentProject.id);
      if (cancelled) return;
      
      const state = useAgentStore.getState();
      const projectSessions = state.sessions.filter((s) => s.projectId === currentProject.id);
      const existing = projectSessions[0];
      
      if (existing) {
        setSessionId(existing.id);
        setActiveSessionId(existing.id);
        return;
      }
      
      await createAndActivate(currentProject.id);
    };

    initSession().catch((err) => {
      if (!cancelled) {
        setSessionId(null);
        setSessionError(err instanceof Error ? err.message : 'Failed to start agent session.');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [currentProject?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Status indicator ──────────────────────────────────────────────────────

  const statusInfo = statusMeta(activeSession?.status ?? streamStatus ?? 'idle');

  // ── Render ────────────────────────────────────────────────────────────────

  if (!currentProject?.id) {
    return (
      <div className="agu-panel ag-ui-panel--pro">
        <div className="agu-panel__empty">
          <Cpu size={28} style={{ opacity: 0.25 }} />
          <p>Open a project to start the agent</p>
        </div>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="agu-panel ag-ui-panel--pro">
        <div className="agu-panel__empty agu-panel__empty--error">
          <XCircle size={24} />
          <p>{sessionError}</p>
          <button
            className="agu-btn agu-btn--sm"
            onClick={() => currentProject?.id && createAndActivate(currentProject.id)}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="agu-panel ag-ui-panel--pro">
      {/* ── Header ── */}
      <div className="agu-panel__header">
        <div className="agu-panel__header-left">
          <button
            className="agu-panel__history-btn"
            onClick={() => setRailOpen((v) => !v)}
            title="Session history"
          >
            <Clock size={14} />
          </button>
          <span className="agu-panel__title">Agent</span>
          <span
            className="agu-panel__status-pill"
            style={{ '--status-color': statusInfo.color } as React.CSSProperties}
          >
            {statusInfo.icon}
            {statusInfo.label}
          </span>
        </div>
        <div className="agu-panel__header-right">
          <button className="agu-panel__new-btn" onClick={handleNewSession} title="New session">
            <Plus size={13} />
            New
          </button>
        </div>
      </div>

      {/* ── Session rail overlay ── */}
      {railOpen && (
        <>
          <div className="agu-rail-overlay" onClick={() => setRailOpen(false)} />
          <SessionRail
            sessions={sessions}
            activeSessionId={sessionId}
            onSelect={handleSelectSession}
            onNew={handleNewSession}
            onDelete={handleDeleteSession}
            loading={loadingSessions}
          />
        </>
      )}

      {/* ── Chat ── */}
      {!sessionId ? (
        <div className="agu-panel__empty">
          <Loader2 size={22} className="spin" />
          <p>Starting session…</p>
        </div>
      ) : (
        <div className="agu-panel__chat-wrap">
          <CopilotKitProvider
            key={`${sessionId}-${agUiUrl}`}
            selfManagedAgents={agents}
            credentials="include"
          >
            <AgUiToolRendererRegistration />
            <AgUiChatCore
              sessionId={sessionId}
              projectId={currentProject.id}
              modelName={defaultModelName}
              activeBoardId={activeBoardId}
              activeGroupId={activeGroupId}
              activeFileId={activeFileId}
              activeFileName={activeFileName}
              selectedWireId={selectedWireId}
            />
          </CopilotKitProvider>
        </div>
      )}

      {/* ── Model selector pill (shown below chat input via CSS) ── */}
      <div className="agu-panel__footer">
        <CompactModelSelector
          value={defaultModelName}
          onChange={setDefaultModelName}
          open={modelSelectorOpen}
          onToggle={() => setModelSelectorOpen((v) => !v)}
        />
      </div>
    </div>
  );
};
