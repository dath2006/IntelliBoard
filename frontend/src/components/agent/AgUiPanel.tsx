import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CopilotChat } from '@copilotkit/react-core/v2';
import { useCoAgent } from '@copilotkit/react-core';
import { useProjectStore } from '../../store/useProjectStore';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useAgentStore } from '../../store/useAgentStore';
import { createAgentSession, type ProjectSnapshotV2 } from '../../services/agentSessions';

type AgentUiState = {
  projectId: string | null;
  sessionId: string | null;
  activeBoardId: string | null;
  activeGroupId: string | null;
  activeFileId: string | null;
  activeFileName: string | null;
  selectedWireId: string | null;
};

import { useAgentSync, buildSnapshotFromStores } from './useAgentSync';

/**
 * Sub-component that actually runs the CopilotChat.
 * By mounting this only when sessionId is available, we ensure that
 * useCoAgent's initialState is correct from the start.
 */
const AgUiChat: React.FC<{
  sessionId: string;
  projectId: string;
  activeBoardId: string | null;
  activeGroupId: string;
  activeFileId: string;
  activeFileName: string | null;
  selectedWireId: string | null;
}> = ({
  sessionId,
  projectId,
  activeBoardId,
  activeGroupId,
  activeFileId,
  activeFileName,
  selectedWireId,
}) => {
  // Hook up the custom AgentEventStream syncing and debounced canvas writes
  useAgentSync(sessionId);

  const agentState = useMemo<AgentUiState>(
    () => ({
      projectId,
      sessionId,
      activeBoardId,
      activeGroupId,
      activeFileId,
      activeFileName,
      selectedWireId,
    }),
    [
      projectId,
      sessionId,
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

  return <CopilotChat className="ag-ui-panel__chat" agentId="velxio" />;
};

export const AgUiPanel: React.FC = () => {
  const currentProject = useProjectStore((s) => s.currentProject);
  const defaultModelName = useAgentStore((s) => s.defaultModelName);
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

  useEffect(() => {
    if (!currentProject?.id) {
      setSessionId(null);
      return;
    }
    let cancelled = false;
    setSessionError(null);
    const snapshot = buildSnapshotFromStores();
    createAgentSession({
      projectId: currentProject.id,
      snapshotJson: JSON.stringify(snapshot),
      modelName: defaultModelName,
    })
      .then((session) => {
        if (!cancelled) setSessionId(session.id);
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
  }, [currentProject?.id, defaultModelName]);

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
    <div className="agent-panel ag-ui-panel">
      {!sessionId ? (
        <div className="agent-panel__empty">
          <p>Starting the agent session…</p>
        </div>
      ) : (
        <AgUiChat
          sessionId={sessionId}
          projectId={currentProject.id}
          activeBoardId={activeBoardId}
          activeGroupId={activeGroupId}
          activeFileId={activeFileId}
          activeFileName={activeFileName}
          selectedWireId={selectedWireId}
        />
      )}
    </div>
  );
};
