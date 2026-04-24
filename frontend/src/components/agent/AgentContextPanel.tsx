import React, { useCallback, useEffect, useMemo } from "react";
import { useEditorStore } from "../../store/useEditorStore";
import { useSimulatorStore } from "../../store/useSimulatorStore";
import type { CompilationLog } from "../../utils/compilationLogger";
import "./AgentPanel.css";

interface AgentContextPanelProps {
  compileLogs: CompilationLog[];
}

export const AgentContextPanel: React.FC<AgentContextPanelProps> = ({
  compileLogs,
}) => {
  const components = useSimulatorStore((s) => s.components);
  const wires = useSimulatorStore((s) => s.wires);
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const serialOutput = useSimulatorStore((s) => s.serialOutput);
  const agentContextWindow = useSimulatorStore((s) => s.agentContextWindow);
  const setAgentContextWindow = useSimulatorStore(
    (s) => s.setAgentContextWindow,
  );

  const activeFileId = useEditorStore((s) => s.activeFileId);
  const files = useEditorStore((s) => s.files);

  const activeBoard = useMemo(
    () => boards.find((b) => b.id === activeBoardId) ?? null,
    [activeBoardId, boards],
  );

  const activeFile = useMemo(
    () => files.find((f) => f.id === activeFileId) ?? null,
    [activeFileId, files],
  );

  const lastCompilation = useMemo(
    () => compileLogs.at(-1) ?? null,
    [compileLogs],
  );

  const lastCompilationError = useMemo(() => {
    const reversed = [...compileLogs].reverse();
    return reversed.find((log) => log.type === "error") ?? null;
  }, [compileLogs]);

  const refreshContext = useCallback(() => {
    setAgentContextWindow({
      serialOutputTail: serialOutput.slice(-100),
      compilationError: lastCompilationError?.message ?? null,
    });
  }, [lastCompilationError?.message, serialOutput, setAgentContextWindow]);

  useEffect(() => {
    refreshContext();
  }, [refreshContext]);

  return (
    <aside className="agent-context-panel">
      <div className="agent-context-header">
        <h3>Agent Context</h3>
        <button
          type="button"
          className="agent-context-refresh"
          onClick={refreshContext}
        >
          Refresh
        </button>
      </div>

      <section className="agent-context-section">
        <h4>Circuit</h4>
        <p>Board: {activeBoard ? activeBoard.boardKind : "None selected"}</p>
        <p>Components: {components.length}</p>
        <p>Wires: {wires.length}</p>
      </section>

      <section className="agent-context-section">
        <h4>Code</h4>
        <p>Active file: {activeFile?.name ?? "No file"}</p>
        <pre className="agent-context-code-preview">
          {(activeFile?.content ?? "").split("\n").slice(0, 20).join("\n") ||
            "// No code loaded"}
        </pre>
      </section>

      <section className="agent-context-section">
        <h4>Compilation</h4>
        <p>
          Status:{" "}
          {lastCompilation
            ? lastCompilation.type === "error"
              ? "Error"
              : "Success / Info"
            : "No runs yet"}
        </p>
        {lastCompilationError ? (
          <pre className="agent-context-error-preview">
            {lastCompilationError.message}
          </pre>
        ) : (
          <p className="agent-context-muted">No compilation errors captured.</p>
        )}
      </section>

      <section className="agent-context-section">
        <h4>Serial Tail</h4>
        <pre className="agent-context-serial-preview">
          {agentContextWindow.serialOutputTail || "// Serial output is empty"}
        </pre>
      </section>

      <section className="agent-context-section">
        <h4>Attach To Next Prompt</h4>
        <label className="agent-context-check">
          <input
            type="checkbox"
            checked={agentContextWindow.includeSerialLogs}
            onChange={(e) =>
              setAgentContextWindow({ includeSerialLogs: e.target.checked })
            }
          />
          Attach serial logs
        </label>
        <label className="agent-context-check">
          <input
            type="checkbox"
            checked={agentContextWindow.includeCompilationError}
            onChange={(e) =>
              setAgentContextWindow({
                includeCompilationError: e.target.checked,
              })
            }
          />
          Attach latest compilation error
        </label>
      </section>
    </aside>
  );
};
