import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Trash2,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Cpu,
  StopCircle,
  History,
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { useEditorStore } from '../../store/useEditorStore';
import { useAgentStore } from '../../store/useAgentStore';
import {
  createAgentSession,
  deleteAgentSession,
  listAgentSessions,
  type AgentSession,
} from '../../services/agentSessions';
import { buildSnapshotFromStores } from './useAgentSync';
import { CompactModelSelector } from './ModelSelector';
import { ChatPanel } from './ChatPanel';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

// ── Session status ───────────────────────────────────────────────────────────

function sessionStatusTone(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'running':
    case 'queued':
      return 'secondary';
    case 'failed':
      return 'destructive';
    case 'stopped':
      return 'outline';
    default:
      return 'default';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'queued':
      return 'Queued';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
    default:
      return 'Idle';
  }
}

function statusIcon(status: string): React.ReactNode {
  switch (status) {
    case 'running':
    case 'queued':
      return <Loader2 size={11} className="animate-spin" aria-hidden />;
    case 'completed':
      return <CheckCircle2 size={11} className="text-emerald-500" aria-hidden />;
    case 'failed':
      return <XCircle size={11} className="text-destructive" aria-hidden />;
    case 'stopped':
      return <StopCircle size={11} className="text-muted-foreground" aria-hidden />;
    default:
      return <Clock size={11} className="text-muted-foreground" aria-hidden />;
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

// ── Sessions column (docks left; width 0 when History is closed) ─────────────

const SessionsSidebar: React.FC<{
  open: boolean;
  sessions: AgentSession[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  loading: boolean;
}> = ({ open, sessions, activeSessionId, onSelect, onNew, onDelete, loading }) => {
  const railWidthClass = 'w-[min(280px,42vw)]';

  return (
    <aside
      id="agent-sessions-sidebar"
      className={cn(
        'flex shrink-0 flex-col overflow-hidden border-border transition-[width] duration-200 ease-out',
        open ? cn('w-[min(280px,42vw)] border-r') : 'w-0 border-transparent',
      )}
      aria-hidden={!open}
    >
      <div className={cn('flex h-full min-h-0 flex-col', railWidthClass)}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <History className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-xs font-medium tracking-tight truncate">Sessions</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={onNew}
            title="New session"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="p-2 space-y-0.5">
            {loading && (
              <div className="flex justify-center py-8 text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            )}
            {!loading && sessions.length === 0 && (
              <p className="text-xs text-muted-foreground px-2 py-6 text-center">No sessions yet</p>
            )}
            {!loading &&
              sessions.map((s) => {
                const isActive = s.id === activeSessionId;
                return (
                  <div
                    key={s.id}
                    className={cn(
                      'group flex items-stretch gap-0.5 rounded-md border transition-colors',
                      isActive ? 'bg-muted border-border' : 'border-transparent hover:bg-muted/50',
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left"
                      onClick={() => onSelect(s.id)}
                    >
                      <span className="shrink-0 text-muted-foreground">{statusIcon(s.status)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-medium text-foreground truncate">
                          {formatSessionLabel(s.updatedAt)}
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate">
                          {s.modelName?.split(':').pop() ?? s.status}
                        </div>
                      </div>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="h-auto w-8 shrink-0 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
                      title="Delete session"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(s.id);
                      }}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                );
              })}
          </div>
        </ScrollArea>
      </div>
    </aside>
  );
};

// ── Main panel ───────────────────────────────────────────────────────────────

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

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [railOpen, setRailOpen] = useState(false);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === sessionId) ?? null,
    [sessions, sessionId],
  );

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

  useEffect(() => {
    if (!currentProject?.id) {
      setSessionId(null);
      return;
    }
    let cancelled = false;
    setSessionError(null);

    const waitForStoresReady = async () => {
      const maxAttempts = 20;
      const pollInterval = 100;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const editor = useEditorStore.getState();
        const hasFileGroups = Object.keys(editor.fileGroups).length > 0;
        const hasFiles = Object.values(editor.fileGroups).some((files) => files.length > 0);
        if (hasFileGroups && hasFiles) return true;
        if (cancelled) return false;
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
      console.warn('[AgUiPanel] Store initialization timeout — proceeding with current state');
      return true;
    };

    const initSession = async () => {
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

  const displayStatus = activeSession?.status ?? (streamStatus === 'open' ? 'running' : 'idle');
  const statusVariant = sessionStatusTone(displayStatus);

  if (!currentProject?.id) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-background px-4 text-center">
        <Cpu className="size-8 text-muted-foreground/40" aria-hidden />
        <p className="text-sm text-muted-foreground">Open a project to use the agent</p>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-background px-4 text-center">
        <XCircle className="size-7 text-destructive" aria-hidden />
        <p className="text-sm text-muted-foreground max-w-xs">{sessionError}</p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => currentProject?.id && createAndActivate(currentProject.id)}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-row bg-background text-foreground">
      <SessionsSidebar
        open={railOpen}
        sessions={sessions}
        activeSessionId={sessionId}
        onSelect={handleSelectSession}
        onNew={handleNewSession}
        onDelete={handleDeleteSession}
        loading={loadingSessions}
      />

      <div className="flex min-w-0 flex-1 flex-col min-h-0">
        {/* Top bar */}
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setRailOpen((v) => !v)}
              title={railOpen ? 'Hide session list' : 'Show session list'}
              aria-expanded={railOpen}
              aria-controls="agent-sessions-sidebar"
            >
              <History className="size-3.5" />
            </Button>
            <span className="text-xs font-medium truncate">
              Agent{' '}
              <span className="text-muted-foreground font-normal">
                · {currentProject.ownerUsername}/{currentProject.slug}
              </span>
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                statusVariant === 'destructive' &&
                  'border-destructive/40 bg-destructive/10 text-destructive',
                statusVariant === 'secondary' && 'border-primary/40 bg-primary/10 text-primary',
                statusVariant === 'outline' && 'border-border text-muted-foreground',
                statusVariant === 'default' && 'border-border bg-muted/50 text-muted-foreground',
              )}
            >
              {statusIcon(displayStatus)}
              {statusLabel(displayStatus)}
            </span>
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-7 gap-1 text-xs px-3"
              onClick={handleNewSession}
            >
              <Plus className="size-3.5" />
              New
            </Button>
          </div>
        </header>

        {/* Chat */}
        <div className="relative min-h-0 flex-1 flex flex-col">
          {!sessionId ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
              <p className="text-sm">Starting session…</p>
            </div>
          ) : (
            <ChatPanel
              key={sessionId}
              sessionId={sessionId}
              defaultModelName={defaultModelName}
              onModelChange={setDefaultModelName}
            />
          )}
        </div>
      </div>
    </div>
  );
};
