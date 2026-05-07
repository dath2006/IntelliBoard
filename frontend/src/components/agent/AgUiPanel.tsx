import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CopilotChat,
  CopilotChatMessageView,
  type CopilotChatMessageViewProps,
  CopilotKitProvider,
} from '@copilotkit/react-core/v2';
import { useCoAgent } from '@copilotkit/react-core';
import { useDefaultRenderTool } from '@copilotkit/react-core/v2';
import type { Message } from '@ag-ui/core';
import { HttpAgent } from '@ag-ui/client';
import { useProjectStore } from '../../store/useProjectStore';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useAgentStore } from '../../store/useAgentStore';
import {
  createAgentSession,
  deleteAgentSession,
  listAgentSessions,
} from '../../services/agentSessions';
import { useAgentSync, buildSnapshotFromStores } from './useAgentSync';
import { ModelSelector } from './ModelSelector';

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

function statusClass(status: string): string {
  if (status === 'running' || status === 'queued') return 'agent-status-badge--running';
  if (status === 'completed') return 'agent-status-badge--completed';
  if (status === 'failed') return 'agent-status-badge--failed';
  if (status === 'stopped') return 'agent-status-badge--stopped';
  return 'agent-status-badge--idle';
}

function formatSessionLabel(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return 'Unknown session';
  const now = new Date();
  const sameDay = when.toDateString() === now.toDateString();
  if (sameDay)
    return `Today, ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return when.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const AgUiToolRendererRegistration: React.FC = () => {
  const InlineToolCard: React.FC<{
    name: string;
    parameters: unknown;
    status: 'inProgress' | 'executing' | 'complete';
    result: string | undefined;
  }> = ({ name, parameters, status, result }) => {
    const [expanded, setExpanded] = useState(false);
    let resultSummary = '';
    let parsedResult: unknown = result;
    if (typeof result === 'string' && result.trim()) {
      try {
        const parsed = JSON.parse(result) as Record<string, unknown>;
        parsedResult = parsed;
        if (typeof parsed.error === 'string') resultSummary = parsed.error;
        else if (typeof parsed.message === 'string') resultSummary = parsed.message;
        else resultSummary = result.slice(0, 180);
      } catch {
        resultSummary = result.slice(0, 180);
      }
    }
    const prettyResult = (() => {
      if (parsedResult === undefined || parsedResult === null) return '';
      if (typeof parsedResult === 'string') return parsedResult;
      try {
        return JSON.stringify(parsedResult, null, 2);
      } catch {
        return String(parsedResult);
      }
    })();
    return (
      <div className="ag-ui-inline-tool">
        <div className="ag-ui-inline-tool__head">
          <span className="ag-ui-inline-tool__name">{name}</span>
          <div className="ag-ui-inline-tool__head-actions">
            <span className={`ag-ui-inline-tool__status ag-ui-inline-tool__status--${status}`}>
              {status === 'inProgress' ? 'running' : status === 'executing' ? 'executing' : 'done'}
            </span>
            <button
              type="button"
              className="ag-ui-inline-tool__toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        {expanded ? (
          <>
            <pre className="ag-ui-inline-tool__args">
              {JSON.stringify(parameters ?? {}, null, 2)}
            </pre>
            {prettyResult ? (
              <pre className="ag-ui-inline-tool__result-pre">{prettyResult}</pre>
            ) : resultSummary ? (
              <div className="ag-ui-inline-tool__result">{resultSummary}</div>
            ) : null}
          </>
        ) : (
          <div className="ag-ui-inline-tool__collapsed">Tool output hidden</div>
        )}
      </div>
    );
  };

  useDefaultRenderTool({
    render: ({ name, parameters, status, result }) => {
      return <InlineToolCard name={name} parameters={parameters} status={status} result={result} />;
    },
  });
  return null;
};

const AgUiChat: React.FC<{
  sessionId: string;
  projectId: string;
  activeBoardId: string | null;
  activeGroupId: string;
  activeFileId: string;
  activeFileName: string | null;
  selectedWireId: string | null;
  modelName: string;
  messageView: typeof CopilotChatMessageView;
}> = ({
  sessionId,
  projectId,
  activeBoardId,
  activeGroupId,
  activeFileId,
  activeFileName,
  selectedWireId,
  modelName,
  messageView,
}) => {
  useAgentSync(sessionId);

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
    setState(agentState);
  }, [agentState, setState]);

  return (
    <CopilotChat
      className="ag-ui-panel__chat"
      agentId="velxio"
      threadId={sessionId}
      messageView={messageView}
    />
  );
};

type HistoryRow = { id: string; role: 'user' | 'assistant'; text: string };

export const AgUiPanel: React.FC = () => {
  const currentProject = useProjectStore((s) => s.currentProject);
  const {
    defaultModelName,
    setDefaultModelName,
    streamStatus,
    sessions,
    setActiveSessionId,
    tracesBySession,
    lastSeqBySession,
    bufferedTextBySession,
    upsertSession,
  } = useAgentStore();
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
  const [sessionRailOpen, setSessionRailOpen] = useState(true);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === sessionId) ?? null,
    [sessions, sessionId],
  );

  const historyRows = useMemo(() => {
    if (!sessionId) return [] as HistoryRow[];
    const traces = tracesBySession[sessionId] ?? [];
    const rows: HistoryRow[] = [];
    for (const trace of traces) {
      if (trace.eventType === 'run.started') {
        const msg = typeof trace.payload?.message === 'string' ? trace.payload.message : '';
        if (msg) rows.push({ id: trace.id, role: 'user', text: msg });
      }
      if (trace.eventType === 'model.output.final') {
        if (trace.compactText)
          rows.push({ id: trace.id, role: 'assistant', text: trace.compactText });
      }
    }
    const buffered = bufferedTextBySession[sessionId] ?? '';
    if (buffered.trim()) {
      rows.push({ id: `buffered-${sessionId}`, role: 'assistant', text: buffered.trim() });
    }
    return rows;
  }, [sessionId, tracesBySession, bufferedTextBySession]);

  const historySeq = sessionId ? (lastSeqBySession[sessionId] ?? 0) : 0;

  const messageView = useMemo<typeof CopilotChatMessageView>(() => {
    const historyMessages: Message[] = historyRows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.text,
      toolCalls: [],
      contentParts: [],
    }));
    const CombinedMessageView = Object.assign(
      (props: CopilotChatMessageViewProps) => (
        <CopilotChatMessageView
          {...props}
          messages={[...historyMessages, ...(props.messages ?? [])]}
        />
      ),
      CopilotChatMessageView,
    ) as typeof CopilotChatMessageView;
    return CombinedMessageView;
  }, [historyRows, historySeq]);

  const apiBase = import.meta.env.VITE_API_BASE || '/api';
  const selectedModel = (defaultModelName || '').trim();
  const agUiUrl = sessionId
    ? `${apiBase}/agent/ag-ui?sessionId=${encodeURIComponent(sessionId)}${selectedModel ? `&modelName=${encodeURIComponent(selectedModel)}` : ''}`
    : `${apiBase}/agent/ag-ui`;
  const agents = useMemo(() => ({ velxio: new HttpAgent({ url: agUiUrl }) }), [agUiUrl]);

  const refreshSessions = async (projectId: string) => {
    setLoadingSessions(true);
    try {
      const items = await listAgentSessions(projectId);
      const sorted = [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      useAgentStore.getState().setSessions(sorted);
    } finally {
      setLoadingSessions(false);
    }
  };

  const createAndActivateSession = async (projectId: string) => {
    const snapshot = buildSnapshotFromStores();
    const session = await createAgentSession({
      projectId,
      snapshotJson: JSON.stringify(snapshot),
      modelName: defaultModelName,
    });
    setSessionId(session.id);
    setActiveSessionId(session.id);
    upsertSession(session);
    await refreshSessions(projectId);
  };

  useEffect(() => {
    if (!currentProject?.id) {
      setSessionId(null);
      return;
    }
    let cancelled = false;
    setSessionError(null);
    refreshSessions(currentProject.id)
      .then(async () => {
        if (cancelled) return;
        const state = useAgentStore.getState();
        const projectSessions = state.sessions.filter((s) => s.projectId === currentProject.id);
        const existing = projectSessions[0];
        if (existing) {
          setSessionId(existing.id);
          setActiveSessionId(existing.id);
          return;
        }
        await createAndActivateSession(currentProject.id);
      })
      .catch((err) => {
        if (!cancelled) {
          setSessionId(null);
          setSessionError(err instanceof Error ? err.message : 'Failed to start agent session.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentProject?.id, defaultModelName, setActiveSessionId, upsertSession]);

  const handleNewSession = async () => {
    if (!currentProject?.id) return;
    setSessionError(null);
    try {
      await createAndActivateSession(currentProject.id);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Failed to create session.');
    }
  };

  const handleSessionChange = (nextSessionId: string) => {
    setSessionId(nextSessionId);
    setActiveSessionId(nextSessionId);
  };

  const handleDeleteSession = async (id: string) => {
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
  };

  if (!currentProject?.id) {
    return (
      <div className="agent-panel">
        <div className="agent-panel__empty">
          <p>Open a project to start the agent.</p>
        </div>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="agent-panel">
        <div className="agent-panel__empty">
          <p>{sessionError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-panel ag-ui-panel ag-ui-panel--pro dark">
      <div
        className={`ag-ui-panel__shell ${sessionRailOpen ? 'history-open' : 'history-collapsed'}`}
      >
        <aside
          className={`ag-ui-panel__sessions-rail ${sessionRailOpen ? 'is-open' : 'is-collapsed'}`}
        >
          <div className="ag-ui-panel__sessions-header">
            <div className="ag-ui-panel__sessions-title">Sessions</div>
            <button
              type="button"
              className="ag-ui-panel__rail-toggle"
              onClick={() => setSessionRailOpen((v) => !v)}
              title={sessionRailOpen ? 'Collapse sessions' : 'Expand sessions'}
            >
              {sessionRailOpen ? 'Hide' : 'Show'}
            </button>
          </div>
          <button className="ag-ui-panel__new-chat" onClick={handleNewSession}>
            + New chat
          </button>
          <div className="ag-ui-panel__sessions-list" role="list">
            {(sessions ?? []).map((s) => (
              <div key={s.id} className="ag-ui-panel__session-item" role="listitem">
                <button
                  type="button"
                  className={`ag-ui-panel__session-item-button ${s.id === sessionId ? 'is-active' : ''}`}
                  onClick={() => handleSessionChange(s.id)}
                >
                  <span className="ag-ui-panel__session-item-title">
                    {formatSessionLabel(s.updatedAt)}
                  </span>
                  <span className="ag-ui-panel__session-item-meta">{s.modelName || s.status}</span>
                </button>
                <button
                  type="button"
                  className="ag-ui-panel__session-delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDeleteSession(s.id);
                  }}
                  title="Delete session"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </aside>

        <section className="ag-ui-panel__main">
          <div className="ag-ui-panel__topbar">
            <div className="ag-ui-panel__title-wrap">
              <button
                type="button"
                className="ag-ui-panel__rail-toggle ag-ui-panel__rail-toggle--mobile"
                onClick={() => setSessionRailOpen((v) => !v)}
                title="Toggle sessions"
              >
                Sessions
              </button>
              <div className="ag-ui-panel__title">Velxio Agent</div>
              <span
                className={`agent-status-badge ${statusClass(activeSession?.status ?? 'idle')}`}
              >
                {activeSession?.status ?? streamStatus}
              </span>
            </div>
          </div>

          <div className="ag-ui-panel__model-row">
            <ModelSelector
              value={defaultModelName}
              onChange={setDefaultModelName}
              disabled={false}
            />
            <div className="ag-ui-panel__session-row">
              <select
                className="ag-ui-panel__session-select"
                value={sessionId ?? ''}
                onChange={(e) => handleSessionChange(e.target.value)}
                disabled={loadingSessions}
              >
                {(sessions ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {formatSessionLabel(s.updatedAt)} - {s.status}
                  </option>
                ))}
              </select>
              <button className="ag-ui-panel__session-new" onClick={handleNewSession}>
                New
              </button>
            </div>
          </div>

          {!sessionId ? (
            <div className="agent-panel__empty">
              <p>Starting the agent session...</p>
            </div>
          ) : (
            <div className="ag-ui-panel__chat-shell">
              <CopilotKitProvider key={agUiUrl} selfManagedAgents={agents} credentials="include">
                <AgUiToolRendererRegistration />
                <AgUiChat
                  sessionId={sessionId}
                  projectId={currentProject.id}
                  modelName={defaultModelName}
                  activeBoardId={activeBoardId}
                  activeGroupId={activeGroupId}
                  activeFileId={activeFileId}
                  activeFileName={activeFileName}
                  selectedWireId={selectedWireId}
                  messageView={messageView}
                />
              </CopilotKitProvider>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
