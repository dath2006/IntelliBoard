import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatWithAgent,
  closeAgentSession,
  forkAgentSession,
  getAgentSessionHistory,
  initAgentSession,
  listAgentSessions,
  type AgentSessionMessage,
  type AgentSessionSummary,
} from "../services/agentService";
import {
  createInitialStreamRuntime,
  reduceAgentStreamEvent,
  type AgentMessage,
  type AgentMessageRole,
  type AgentStreamRuntimeState,
  type AgentStreamSideEffects,
} from "./agentStreamReducer";

export interface AgentChatMessage extends AgentMessage {}

interface SendPromptOptions {
  serialOutput?: string;
}

interface UseAgentSessionOptions {
  projectId: string | null;
  includeSerialLogs: boolean;
  defaultSerialOutput?: string;
  onCircuitUpdate?: (circuit: {
    components?: Array<{
      id: string;
      type: string;
      left: number;
      top: number;
      rotate?: number;
      attrs?: Record<string, unknown>;
    }>;
    wires?: Array<Record<string, unknown>>;
  }) => void;
  onCodeUpdate?: (files: Array<{ name: string; content: string }>) => void;
  onCompileResult?: (result: Record<string, unknown>) => void;
  onSimulationAction?: (action: Record<string, unknown>) => void;
  getCurrentCircuit?: () => Record<string, unknown>;
  getCurrentCode?: () => Record<string, string>;
}

interface UseAgentSessionResult {
  sessionId: string | null;
  sessionHistory: AgentSessionSummary[];
  messages: AgentChatMessage[];
  isLoading: boolean;
  error: string | null;
  loadSession: (targetSessionId: string) => Promise<void>;
  refreshSessionHistory: () => Promise<void>;
  forkCurrentSession: (newProjectId?: string) => Promise<string | null>;
  deleteSession: (targetSessionId: string) => Promise<void>;
  sendPrompt: (prompt: string, options?: SendPromptOptions) => Promise<void>;
  clearError: () => void;
}

function messageId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function toAgentMessageRole(role: string): AgentMessageRole {
  return role === "user" ||
    role === "assistant" ||
    role === "system" ||
    role === "tool" ||
    role === "error"
    ? role
    : "system";
}

function mapHistoryMessages(
  conversationMessages: AgentSessionMessage[],
): AgentChatMessage[] {
  return conversationMessages.map((msg) => ({
    id: messageId("history"),
    role: toAgentMessageRole(msg.role),
    content: msg.content,
    timestamp: msg.timestamp,
    traceType: "history",
    toolCalls: msg.tool_calls ?? null,
    artifacts: msg.artifacts ?? null,
    status: msg.status,
  }));
}

export function useAgentSession(
  options: UseAgentSessionOptions,
): UseAgentSessionResult {
  const {
    projectId,
    includeSerialLogs,
    defaultSerialOutput,
    onCircuitUpdate,
    onCodeUpdate,
    onCompileResult,
    onSimulationAction,
    getCurrentCircuit,
    getCurrentCode,
  } = options;

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionHistory, setSessionHistory] = useState<AgentSessionSummary[]>(
    [],
  );
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const streamRuntimeRef = useRef<AgentStreamRuntimeState>(
    createInitialStreamRuntime(),
  );

  const resetStreamRuntime = useCallback(() => {
    streamRuntimeRef.current = createInitialStreamRuntime();
  }, []);

  const refreshSessionHistory = useCallback(async () => {
    if (!projectId) {
      setSessionHistory([]);
      return;
    }

    const sessions = await listAgentSessions(projectId);
    setSessionHistory(sessions);
  }, [projectId]);

  const loadSession = useCallback(
    async (targetSessionId: string) => {
      if (!targetSessionId) return;

      const detail = await getAgentSessionHistory(targetSessionId);
      setSessionId(detail.session_id);
      setMessages(mapHistoryMessages(detail.conversation_messages));
      resetStreamRuntime();
    },
    [resetStreamRuntime],
  );

  const forkCurrentSession = useCallback(
    async (newProjectId?: string): Promise<string | null> => {
      if (!sessionId) return null;

      const forked = await forkAgentSession(sessionId, newProjectId);

      if (!newProjectId || newProjectId === projectId) {
        await refreshSessionHistory();
        await loadSession(forked.new_session_id);
      }

      return forked.new_session_id;
    },
    [loadSession, projectId, refreshSessionHistory, sessionId],
  );

  const deleteSession = useCallback(
    async (targetSessionId: string): Promise<void> => {
      await closeAgentSession(targetSessionId);

      if (!projectId) {
        if (sessionId === targetSessionId) {
          setSessionId(null);
          setMessages([]);
          resetStreamRuntime();
        }
        return;
      }

      const sessions = await listAgentSessions(projectId);
      setSessionHistory(sessions);

      if (sessionId === targetSessionId) {
        const nextSession = sessions[0]?.id ?? null;
        setSessionId(nextSession);
        if (nextSession) {
          const detail = await getAgentSessionHistory(nextSession);
          setMessages(mapHistoryMessages(detail.conversation_messages));
          resetStreamRuntime();
        } else {
          setMessages([]);
          resetStreamRuntime();
        }
      }
    },
    [projectId, resetStreamRuntime, sessionId],
  );

  useEffect(() => {
    let mounted = true;

    setMessages([]);
    setError(null);
    setSessionId(null);
    setSessionHistory([]);
    resetStreamRuntime();

    if (!projectId) return () => undefined;

    void initAgentSession(null, projectId)
      .then(async (result) => {
        if (!mounted) return;

        await refreshSessionHistory();
        setSessionId(result.session_id);

        if (result.session_id) {
          await loadSession(result.session_id);
        }
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg =
          err instanceof Error
            ? err.message
            : "Failed to initialize agent session";
        setError(msg);
      });

    return () => {
      mounted = false;
    };
  }, [loadSession, projectId, refreshSessionHistory, resetStreamRuntime]);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const pushMessage = useCallback((message: AgentChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const sendPrompt = useCallback(
    async (prompt: string, sendOptions?: SendPromptOptions) => {
      if (!projectId) {
        setError("Save the project first to start an agent session.");
        return;
      }

      const trimmed = prompt.trim();
      if (!trimmed) return;
      if (isLoading) return;

      const requestSerialOutput =
        sendOptions?.serialOutput ?? defaultSerialOutput;

      setError(null);
      setIsLoading(true);
      resetStreamRuntime();

      pushMessage({
        id: messageId("user"),
        role: "user",
        content: trimmed,
        timestamp: new Date().toISOString(),
      });

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        await chatWithAgent(
          {
            project_id: projectId,
            prompt: trimmed,
            session_id: sessionId,
            include_serial_logs: includeSerialLogs,
            serial_output: includeSerialLogs ? requestSerialOutput : undefined,
            current_circuit: getCurrentCircuit?.(),
            active_code: getCurrentCode?.(),
          },
          (event) => {
            if (event.artifacts?.circuit_changes) {
              onCircuitUpdate?.(event.artifacts.circuit_changes);
            }
            if (event.artifacts?.code_changes) {
              onCodeUpdate?.(event.artifacts.code_changes);
            }
            if (event.artifacts?.compile_result) {
              onCompileResult?.(event.artifacts.compile_result);
            }
            if (event.artifacts?.simulation_action) {
              onSimulationAction?.(event.artifacts.simulation_action);
            }

            let effects: AgentStreamSideEffects = {};
            const nowIso = new Date().toISOString();

            setMessages((prev) => {
              const reduced = reduceAgentStreamEvent({
                messages: prev,
                runtime: streamRuntimeRef.current,
                event,
                nowIso,
                nextMessageId: messageId,
              });

              streamRuntimeRef.current = reduced.runtime;
              effects = reduced.effects;
              return reduced.messages;
            });

            if (effects.errorText) {
              setError(effects.errorText);
            }

            if (effects.doneSessionId) {
              setSessionId(effects.doneSessionId);
              void refreshSessionHistory();
            }
          },
          controller.signal,
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : "Agent request failed";
        setError(msg);
        resetStreamRuntime();
        pushMessage({
          id: messageId("error"),
          role: "error",
          content: msg,
          timestamp: new Date().toISOString(),
        });
      } finally {
        setIsLoading(false);
        controllerRef.current = null;
      }
    },
    [
      defaultSerialOutput,
      includeSerialLogs,
      isLoading,
      onCircuitUpdate,
      onCodeUpdate,
      onCompileResult,
      onSimulationAction,
      projectId,
      pushMessage,
      refreshSessionHistory,
      resetStreamRuntime,
      sessionId,
    ],
  );

  return {
    sessionId,
    sessionHistory,
    messages,
    isLoading,
    error,
    loadSession,
    refreshSessionHistory,
    forkCurrentSession,
    deleteSession,
    sendPrompt,
    clearError,
  };
}
