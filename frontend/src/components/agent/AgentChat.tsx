import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { CodeBlock } from "../layout/CodeBlock";
import {
  useAgentSession,
  type AgentChatMessage,
} from "../../hooks/useAgentSession";
import { useSimulatorStore, BOARD_FQBN } from "../../store/useSimulatorStore";
import { useEditorStore } from "../../store/useEditorStore";
import { updateProject } from "../../services/projectService";
import { compileCode } from "../../services/compilation";
import { BOARD_KIND_FQBN } from "../../types/board";
import "./AgentPanel.css";

interface AgentChatProps {
  projectId: string | null;
}

interface ContentPart {
  type: "text" | "code";
  text: string;
  language?: string;
}

interface StructuredContent {
  text: string;
  language: string;
}

function splitMessageContent(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  const codeRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let lastIndex = 0;

  for (const match of content.matchAll(codeRegex)) {
    const fullMatch = match[0];
    const language = match[1] ?? "text";
    const code = match[2] ?? "";
    const idx = match.index ?? 0;

    if (idx > lastIndex) {
      const text = content.slice(lastIndex, idx).trim();
      if (text) parts.push({ type: "text", text });
    }

    parts.push({ type: "code", text: code, language });
    lastIndex = idx + fullMatch.length;
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) parts.push({ type: "text", text });
  }

  if (parts.length === 0) {
    parts.push({ type: "text", text: content });
  }

  return parts;
}

function looksLikeDiff(text: string): boolean {
  return /(^|\n)[+-][^\n]+/m.test(text) || text.includes("@@");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tryParseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function normalizeStructuredContent(value: unknown): StructuredContent | null {
  if (value == null) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const parsed = tryParseJson(trimmed);
    if (parsed.ok) {
      return {
        text: JSON.stringify(parsed.value, null, 2),
        language: "json",
      };
    }

    return {
      text: trimmed,
      language: looksLikeDiff(trimmed) ? "diff" : "text",
    };
  }

  return {
    text: JSON.stringify(value, null, 2),
    language: "json",
  };
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatMessageTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getMessageLabel(message: AgentChatMessage): string {
  if (message.traceType === "thinking") return "Thinking";
  if (message.role === "error") return "Error";
  if (message.role === "tool") return "Tool";
  return humanizeIdentifier(message.role);
}

function getTraceChip(message: AgentChatMessage): string | null {
  switch (message.traceType) {
    case "tool_call":
      return "Call";
    case "tool_result":
      return "Result";
    case "response_chunk":
      return "Draft";
    case "history":
      return message.role === "assistant" &&
        ((message.toolCalls?.length ?? 0) > 0 || Boolean(message.artifacts))
        ? "Saved"
        : null;
    default:
      return null;
  }
}

function getStatusChip(message: AgentChatMessage): string | null {
  if (message.traceType === "thinking") return "Running";
  if (message.traceType === "response_chunk") return "Streaming";
  if (message.traceType === "tool_call") return "Running";
  if (message.traceType === "tool_result") return "Completed";
  if (message.role === "error") return "Failed";
  return null;
}

function getCodeBlockLanguage(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();

  switch (ext) {
    case "ino":
    case "c":
    case "cpp":
    case "h":
    case "hpp":
      return "cpp";
    case "ts":
    case "tsx":
      return ext;
    case "js":
    case "jsx":
      return ext;
    case "json":
      return "json";
    case "py":
      return "python";
    case "css":
      return "css";
    case "html":
      return "html";
    case "md":
      return "markdown";
    case "sh":
      return "bash";
    default:
      return "text";
  }
}

function getCircuitArtifact(
  message: AgentChatMessage,
): Record<string, unknown> | null {
  const circuitChanges = message.artifacts?.circuit_changes;
  return isRecord(circuitChanges) ? circuitChanges : null;
}

function getCodeArtifacts(
  message: AgentChatMessage,
): Array<{ name: string; content: string }> {
  const files = message.artifacts?.code_changes;
  if (!Array.isArray(files)) return [];

  return files.filter(
    (file): file is { name: string; content: string } =>
      isRecord(file) &&
      typeof file.name === "string" &&
      typeof file.content === "string",
  );
}

function writeToClipboard(text: string): void {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  void navigator.clipboard.writeText(text);
}

const StructuredDetails: React.FC<{
  title: string;
  value: unknown;
  defaultOpen?: boolean;
}> = ({ title, value, defaultOpen = false }) => {
  const normalized = normalizeStructuredContent(value);
  if (!normalized) return null;

  return (
    <details className="agent-msg-details" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="agent-msg-details-body">
        <div className="agent-msg-code-block">
          <button
            type="button"
            className="agent-copy-btn"
            onClick={() => writeToClipboard(normalized.text)}
          >
            Copy
          </button>
          <CodeBlock language={normalized.language}>
            {normalized.text}
          </CodeBlock>
        </div>
      </div>
    </details>
  );
};

const FileArtifactsDetails: React.FC<{
  files: Array<{ name: string; content: string }>;
}> = ({ files }) => {
  if (files.length === 0) return null;

  return (
    <details className="agent-msg-details">
      <summary>
        Generated Files ({files.length} file{files.length === 1 ? "" : "s"})
      </summary>
      <div className="agent-msg-details-body agent-msg-files">
        {files.map((file, idx) => (
          <section key={`${file.name}-${idx}`} className="agent-msg-file">
            <div className="agent-msg-file-meta">
              <span className="agent-msg-file-name">{file.name}</span>
              <button
                type="button"
                className="agent-copy-btn agent-copy-btn--inline"
                onClick={() => writeToClipboard(file.content)}
              >
                Copy
              </button>
            </div>
            <div className="agent-msg-code-block agent-msg-code-block--file">
              <CodeBlock language={getCodeBlockLanguage(file.name)}>
                {file.content}
              </CodeBlock>
            </div>
          </section>
        ))}
      </div>
    </details>
  );
};

export const AgentChat: React.FC<AgentChatProps> = ({ projectId }) => {
  const [prompt, setPrompt] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agentContextWindow = useSimulatorStore((s) => s.agentContextWindow);
  const setAgentContextWindow = useSimulatorStore(
    (s) => s.setAgentContextWindow,
  );
  const setAgentSessionId = useSimulatorStore((s) => s.setAgentSessionId);
  const setLastAgentAction = useSimulatorStore((s) => s.setLastAgentAction);
  const applyAgentCircuitUpdate = useSimulatorStore(
    (s) => s.applyAgentCircuitUpdate,
  );
  const applyAgentCodeUpdate = useSimulatorStore((s) => s.applyAgentCodeUpdate);

  const triggerAutoSave = useCallback(() => {
    if (!projectId) return;
    // Wait a tick for Zustand stores to finish updating
    setTimeout(async () => {
      try {
        const simStore = useSimulatorStore.getState();
        const activeBoard =
          simStore.boards.find((b) => b.id === simStore.activeBoardId) ??
          simStore.boards[0];
        const activeFiles =
          useEditorStore.getState().fileGroups[
            activeBoard?.activeFileGroupId ?? ""
          ] || useEditorStore.getState().files;

        const code =
          activeFiles.find((f) => f.name.endsWith(".ino"))?.content ??
          activeFiles[0]?.content ??
          "";

        const payload = {
          board_type: activeBoard?.boardKind ?? "arduino-uno",
          files: activeFiles.map((f) => ({ name: f.name, content: f.content })),
          code,
          components_json: JSON.stringify(simStore.components),
          wires_json: JSON.stringify(simStore.wires),
        };

        await updateProject(projectId, payload);
        console.log("Agent autosaved project successfully");
      } catch (err) {
        console.error("Agent autosave failed:", err);
      }
    }, 100);
  }, [projectId]);

  const getCurrentCircuit = useCallback(() => {
    const s = useSimulatorStore.getState();
    const activeBoard = s.boards.find((b) => b.id === s.activeBoardId);
    const boardKind = activeBoard?.boardKind as keyof typeof BOARD_FQBN;

    const normalizeType = (metadataId: string) =>
      metadataId.startsWith("wokwi-") ? metadataId : `wokwi-${metadataId}`;

    return {
      board_fqbn: activeBoard
        ? BOARD_FQBN[boardKind] || activeBoard.boardKind
        : "arduino:avr:uno",
      components: s.components.map((c) => ({
        id: c.id,
        type: normalizeType(c.metadataId),
        left: c.x,
        top: c.y,
        rotate: (c.properties?.rotate as number) || 0,
        attrs: c.properties || {},
      })),
      connections: s.wires.map((w) => ({
        from_part: w.start.componentId,
        from_pin: w.start.pinName,
        to_part: w.end.componentId,
        to_pin: w.end.pinName,
        color: w.color,
      })),
    };
  }, []);

  const getCurrentCode = useCallback(() => {
    const s = useEditorStore.getState();
    const activeGroupId = s.activeGroupId;
    const files = s.fileGroups[activeGroupId] || [];
    const activeCode: Record<string, string> = {};
    files.forEach((f) => {
      activeCode[f.name] = f.content;
    });
    return activeCode;
  }, []);

  const executeSimulationAction = useCallback(
    async (actionPayload: Record<string, unknown>) => {
      const action = String(actionPayload.action || "")
        .trim()
        .toLowerCase();
      if (!action) return;

      const sim = useSimulatorStore.getState();
      const editor = useEditorStore.getState();
      const boardId =
        (typeof actionPayload.board_id === "string" &&
          actionPayload.board_id) ||
        sim.activeBoardId ||
        sim.boards[0]?.id;
      if (!boardId) return;

      const board = sim.boards.find((b) => b.id === boardId) || sim.boards[0];
      if (!board) return;

      const runCompile = async (): Promise<boolean> => {
        const groupFiles =
          editor.fileGroups[board.activeFileGroupId] ||
          editor.fileGroups[editor.activeGroupId] ||
          editor.files ||
          [];
        const sketchFiles = groupFiles.map((f) => ({
          name: f.name,
          content: f.content,
        }));
        if (sketchFiles.length === 0) {
          setLastAgentAction({
            type: "artifact_compile_result",
            payload: {
              success: false,
              error: "No files available to compile.",
            },
            timestamp: new Date().toISOString(),
          });
          return false;
        }

        const requestedFqbn =
          typeof actionPayload.board_fqbn === "string"
            ? actionPayload.board_fqbn
            : null;
        const fqbn =
          requestedFqbn ||
          BOARD_KIND_FQBN[board.boardKind] ||
          BOARD_FQBN["arduino-uno"];
        if (!fqbn) {
          setLastAgentAction({
            type: "artifact_compile_result",
            payload: {
              success: false,
              error: `No FQBN available for board ${board.boardKind}`,
            },
            timestamp: new Date().toISOString(),
          });
          return false;
        }

        try {
          const result = await compileCode(sketchFiles, fqbn);
          if (result.success) {
            const program = result.hex_content ?? result.binary_content ?? null;
            if (program) {
              useSimulatorStore
                .getState()
                .compileBoardProgram(board.id, program);
            }
          }
          setLastAgentAction({
            type: "artifact_compile_result",
            payload: result,
            timestamp: new Date().toISOString(),
          });
          return Boolean(result.success);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Compile failed";
          setLastAgentAction({
            type: "artifact_compile_result",
            payload: { success: false, error: message },
            timestamp: new Date().toISOString(),
          });
          return false;
        }
      };

      if (action === "compile") {
        await runCompile();
        return;
      }

      if (action === "start") {
        if (Boolean(actionPayload.ensure_compiled)) {
          const ok = await runCompile();
          if (!ok) return;
        }
        useSimulatorStore.getState().startBoard(board.id);
        setLastAgentAction({
          type: "artifact_simulation_action",
          payload: actionPayload,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (action === "stop") {
        useSimulatorStore.getState().stopBoard(board.id);
      } else if (action === "reset") {
        useSimulatorStore.getState().resetBoard(board.id);
      } else if (action === "toggle_serial_monitor") {
        useSimulatorStore.getState().toggleSerialMonitor();
      } else if (action === "set_serial_monitor") {
        const open = Boolean(actionPayload.open_serial_monitor);
        const isOpen = useSimulatorStore.getState().serialMonitorOpen;
        if (open !== isOpen) {
          useSimulatorStore.getState().toggleSerialMonitor();
        }
      } else if (action === "send_serial_input") {
        const text = String(actionPayload.serial_input || "");
        if (text.trim()) {
          useSimulatorStore.getState().serialWriteToBoard(board.id, text);
        }
      } else if (action === "read_serial_monitor") {
        const output = useSimulatorStore.getState().serialOutput;
        setLastAgentAction({
          type: "artifact_serial_snapshot",
          payload: {
            serial_output: output.slice(-2000),
            chars: output.length,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      setLastAgentAction({
        type: "artifact_simulation_action",
        payload: actionPayload,
        timestamp: new Date().toISOString(),
      });
    },
    [setLastAgentAction],
  );

  const {
    sessionId,
    sessionHistory,
    messages,
    isLoading,
    error,
    clearError,
    loadSession,
    refreshSessionHistory,
    forkCurrentSession,
    deleteSession,
    sendPrompt,
  } = useAgentSession({
    projectId,
    includeSerialLogs: agentContextWindow.includeSerialLogs,
    defaultSerialOutput: agentContextWindow.serialOutputTail,
    onCircuitUpdate: (circuit: any) => {
      applyAgentCircuitUpdate(circuit);
      setLastAgentAction({
        type: "artifact_circuit_update",
        payload: circuit,
        timestamp: new Date().toISOString(),
      });
      triggerAutoSave();
    },
    onCodeUpdate: (files) => {
      applyAgentCodeUpdate(files);
      setLastAgentAction({
        type: "artifact_code_update",
        payload: files,
        timestamp: new Date().toISOString(),
      });
      triggerAutoSave();
    },
    onCompileResult: (result) => {
      const success = Boolean(result.success);
      const error = typeof result.error === "string" ? result.error : null;
      if (!success && error) {
        setAgentContextWindow({ compilationError: error });
      }
      setLastAgentAction({
        type: "artifact_compile_result",
        payload: result,
        timestamp: new Date().toISOString(),
      });
    },
    onSimulationAction: (action) => {
      void executeSimulationAction(action);
    },
    getCurrentCircuit,
    getCurrentCode,
  });

  useEffect(() => {
    setAgentSessionId(sessionId);
  }, [sessionId, setAgentSessionId]);

  useEffect(() => {
    setSelectedSessionId(sessionId ?? sessionHistory[0]?.id ?? "");
  }, [sessionHistory, sessionId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isLoading]);

  // Synchronous height adjustment — avoids the React state round-trip lag.
  const adjustTextareaHeight = useCallback((ta: HTMLTextAreaElement) => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, []);

  const canSend = useMemo(
    () => Boolean(projectId) && prompt.trim().length > 0 && !isLoading,
    [isLoading, projectId, prompt],
  );

  const handleSend = async () => {
    const base = prompt.trim();
    if (!base) return;

    let finalPrompt = base;
    if (
      agentContextWindow.includeCompilationError &&
      agentContextWindow.compilationError
    ) {
      finalPrompt = `${finalPrompt}\n\nCompilation error context:\n${agentContextWindow.compilationError}`;
    }

    await sendPrompt(finalPrompt, {
      serialOutput: agentContextWindow.includeSerialLogs
        ? agentContextWindow.serialOutputTail
        : undefined,
    });
    setPrompt("");
    // Reset height synchronously after clearing the prompt.
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleLoadSession = async () => {
    if (!selectedSessionId || isLoading) return;
    await loadSession(selectedSessionId);
  };

  const handleForkSession = async () => {
    if (!sessionId || isLoading) return;
    await forkCurrentSession();
    await refreshSessionHistory();
  };

  const handleDeleteSession = async () => {
    if (!selectedSessionId || isLoading) return;
    await deleteSession(selectedSessionId);
  };

  const shortSessionId = sessionId ? `${sessionId.slice(0, 8)}...` : null;

  return (
    <div className="agent-chat-panel">
      <header className="agent-chat-header">
        <div className="agent-chat-header-left">
          <h3>Agent Chat</h3>
          <p className="agent-chat-subtitle">
            {projectId
              ? "Context-aware assistant for circuit and code"
              : "Save this project to start an agent session"}
          </p>
        </div>
        <div className="agent-chat-session-badge">
          {sessionId && <span className="agent-chat-session-badge-dot" />}
          {shortSessionId ?? "No active session"}
        </div>
      </header>

      <div className="agent-session-controls">
        <label htmlFor="agent-session-select">Session</label>
        <select
          id="agent-session-select"
          className="agent-session-select"
          value={selectedSessionId}
          onChange={(e) => setSelectedSessionId(e.target.value)}
          disabled={!projectId || isLoading || sessionHistory.length === 0}
        >
          {sessionHistory.length === 0 && (
            <option value="">No saved sessions</option>
          )}
          {sessionHistory.map((session) => (
            <option key={session.id} value={session.id}>
              {new Date(session.updated_at).toLocaleString()} (
              {session.message_count} msgs)
            </option>
          ))}
        </select>

        <button
          type="button"
          className="agent-session-btn"
          onClick={() => void handleLoadSession()}
          disabled={!selectedSessionId || isLoading}
        >
          Load
        </button>
        <button
          type="button"
          className="agent-session-btn"
          onClick={() => void handleForkSession()}
          disabled={!sessionId || isLoading}
        >
          Fork
        </button>
        <button
          type="button"
          className="agent-session-btn agent-session-btn--danger"
          onClick={() => void handleDeleteSession()}
          disabled={!selectedSessionId || isLoading}
        >
          Delete
        </button>
      </div>

      <div className="agent-chat-messages" ref={scrollRef}>
        {messages.length === 0 && !isLoading && (
          <div className="agent-chat-empty">
            <span className="agent-chat-empty-icon">AI</span>
            <span>
              Ask the agent to create, modify, or debug your circuit and code.
              <br />
              <em>e.g. "Add a blinking LED on pin 13"</em>
            </span>
          </div>
        )}

        {messages.map((message) => {
          const parts = splitMessageContent(message.content);
          const traceChip = getTraceChip(message);
          const statusChip = getStatusChip(message);
          const toolName = message.toolName
            ? humanizeIdentifier(message.toolName)
            : null;
          const toolArguments = readField(message.payload, "args");
          const toolResult = readField(message.payload, "content");
          const circuitArtifact = getCircuitArtifact(message);
          const codeArtifacts = getCodeArtifacts(message);
          const artifactCount =
            (circuitArtifact ? 1 : 0) + (codeArtifacts.length > 0 ? 1 : 0);

          return (
            <div
              key={message.id}
              className={`agent-msg-row agent-msg-row--${message.role}`}
            >
              <article className={`agent-msg agent-msg--${message.role}`}>
                <div className="agent-msg-meta">
                  <div className="agent-msg-badges">
                    <span className="agent-msg-role">
                      {getMessageLabel(message)}
                    </span>
                    {traceChip && (
                      <span className="agent-msg-chip">{traceChip}</span>
                    )}
                    {toolName && (
                      <span className="agent-msg-chip agent-msg-chip--tool">
                        {toolName}
                      </span>
                    )}
                    {statusChip && (
                      <span className="agent-msg-chip agent-msg-chip--status">
                        {statusChip}
                      </span>
                    )}
                  </div>
                  <time
                    className="agent-msg-time"
                    dateTime={message.timestamp}
                    title={new Date(message.timestamp).toLocaleString()}
                  >
                    {formatMessageTime(message.timestamp)}
                  </time>
                </div>

                <div className="agent-msg-body">
                  {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="agent-msg-inline-list">
                      <span className="agent-msg-inline-label">Tools used</span>
                      <div className="agent-msg-chip-list">
                        {message.toolCalls.map((tool, idx) => (
                          <span
                            key={`${message.id}-${tool}-${idx}`}
                            className="agent-msg-chip"
                          >
                            {humanizeIdentifier(tool)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {artifactCount > 0 && (
                    <div className="agent-msg-inline-list">
                      <span className="agent-msg-inline-label">Artifacts</span>
                      <div className="agent-msg-chip-list">
                        {circuitArtifact && (
                          <span className="agent-msg-chip">
                            Circuit snapshot
                          </span>
                        )}
                        {codeArtifacts.length > 0 && (
                          <span className="agent-msg-chip">
                            {codeArtifacts.length} code file
                            {codeArtifacts.length === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {message.content.trim() && (
                    <div className="agent-msg-content">
                      {parts.map((part, idx) => {
                        if (part.type === "code") {
                          const isDiff =
                            looksLikeDiff(part.text) ||
                            part.language === "diff";

                          if (isDiff) {
                            return (
                              <details
                                key={`${message.id}-diff-${idx}`}
                                className="agent-msg-details"
                              >
                                <summary>Code Diff Preview</summary>
                                <div className="agent-msg-details-body">
                                  <div className="agent-msg-code-block">
                                    <button
                                      type="button"
                                      className="agent-copy-btn"
                                      onClick={() =>
                                        writeToClipboard(part.text)
                                      }
                                    >
                                      Copy
                                    </button>
                                    <CodeBlock language="diff">
                                      {part.text}
                                    </CodeBlock>
                                  </div>
                                </div>
                              </details>
                            );
                          }

                          return (
                            <div
                              key={`${message.id}-code-${idx}`}
                              className="agent-msg-code-block"
                            >
                              <button
                                type="button"
                                className="agent-copy-btn"
                                onClick={() => writeToClipboard(part.text)}
                              >
                                Copy
                              </button>
                              <CodeBlock language={part.language}>
                                {part.text}
                              </CodeBlock>
                            </div>
                          );
                        }

                        return (
                          <p
                            key={`${message.id}-text-${idx}`}
                            className={`agent-msg-text ${
                              message.role === "tool" ||
                              message.role === "system"
                                ? "agent-msg-text--trace"
                                : ""
                            }`}
                          >
                            {part.text}
                          </p>
                        );
                      })}
                    </div>
                  )}

                  {message.traceType === "tool_call" && (
                    <StructuredDetails
                      title="Tool Input"
                      value={toolArguments}
                    />
                  )}
                  {message.traceType === "tool_result" && (
                    <StructuredDetails title="Tool Output" value={toolResult} />
                  )}
                  {circuitArtifact && (
                    <StructuredDetails
                      title="Circuit Update"
                      value={circuitArtifact}
                    />
                  )}
                  <FileArtifactsDetails files={codeArtifacts} />
                </div>
              </article>
            </div>
          );
        })}

        {isLoading && (
          <div className="agent-msg-row agent-msg-row--system">
            <article className="agent-msg agent-msg--system">
              <div className="agent-msg-meta">
                <div className="agent-msg-badges">
                  <span className="agent-msg-role">System</span>
                  <span className="agent-msg-chip agent-msg-chip--status">
                    Working
                  </span>
                </div>
              </div>
              <div className="agent-msg-body">
                <div className="agent-msg-loading">
                  <span className="agent-spinner" />
                  <span>Working on your request...</span>
                </div>
              </div>
            </article>
          </div>
        )}
      </div>

      {error && (
        <div className="agent-chat-error">
          <span>{error}</span>
          <button type="button" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}

      <div className="agent-chat-input-row">
        <textarea
          ref={textareaRef}
          className="agent-chat-input"
          placeholder={
            projectId
              ? "Describe the circuit/code change you want... (Enter to send, Shift+Enter for newline)"
              : "Save the project first to chat with the agent"
          }
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onInput={(e) => adjustTextareaHeight(e.currentTarget)}
          onKeyDown={handleKeyDown}
          rows={2}
          disabled={!projectId || isLoading}
        />
        <button
          type="button"
          className="agent-chat-send"
          disabled={!canSend}
          onClick={() => void handleSend()}
        >
          Send
        </button>
      </div>
    </div>
  );
};
