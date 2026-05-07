import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

const api = axios.create({ baseURL: API_BASE, withCredentials: true });

export interface AgentSession {
  id: string;
  projectId: string | null;
  status: string;
  modelName: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSessionEvent {
  id: string;
  sessionId: string;
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface FrontendActionResultRequest {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
  action?: string;
}

export interface SnapshotFile {
  name: string;
  content: string;
}

export interface SnapshotBoard {
  id: string;
  boardKind: string;
  x: number;
  y: number;
  languageMode: 'arduino' | 'micropython';
  activeFileGroupId: string;
}

export interface SnapshotComponent {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, unknown>;
}

export interface SnapshotWire {
  id: string;
  start: { componentId: string; pinName: string; x: number; y: number };
  end: { componentId: string; pinName: string; x: number; y: number };
  waypoints?: Array<{ x: number; y: number }>;
  color?: string;
  signalType?: string | null;
}

export interface ProjectSnapshotV2 {
  version: 2;
  boards: SnapshotBoard[];
  activeBoardId: string | null;
  components: SnapshotComponent[];
  wires: SnapshotWire[];
  fileGroups: Record<string, SnapshotFile[]>;
  activeGroupId: string | null;
}

export interface CreateAgentSessionRequest {
  projectId?: string;
  snapshotJson?: string;
  modelName?: string;
}

export async function createAgentSession(
  payload: CreateAgentSessionRequest,
): Promise<AgentSession> {
  const { data } = await api.post<AgentSession>('/agent/sessions', payload);
  return data;
}

export async function listAgentSessions(projectId?: string): Promise<AgentSession[]> {
  const { data } = await api.get<AgentSession[]>('/agent/sessions', {
    params: projectId ? { project_id: projectId } : undefined,
  });
  return data;
}

export async function sendAgentMessage(sessionId: string, message: string): Promise<AgentSession> {
  const { data } = await api.post<AgentSession>(`/agent/sessions/${sessionId}/messages`, {
    message,
  });
  return data;
}

export async function applyAgentSession(sessionId: string): Promise<AgentSession> {
  const { data } = await api.post<AgentSession>(`/agent/sessions/${sessionId}/apply`);
  return data;
}

export async function discardAgentSession(sessionId: string): Promise<AgentSession> {
  const { data } = await api.post<AgentSession>(`/agent/sessions/${sessionId}/discard`);
  return data;
}

export async function stopAgentSession(sessionId: string): Promise<AgentSession> {
  const { data } = await api.post<AgentSession>(`/agent/sessions/${sessionId}/stop`);
  return data;
}

export async function deleteAgentSession(sessionId: string): Promise<void> {
  await api.delete(`/agent/sessions/${sessionId}`);
}

export async function postFrontendActionResult(
  sessionId: string,
  actionId: string,
  result: FrontendActionResultRequest,
): Promise<void> {
  await api.post(`/agent/sessions/${sessionId}/actions/${actionId}`, result);
}

export async function getAgentSessionSnapshot(sessionId: string): Promise<ProjectSnapshotV2> {
  const { data } = await api.get<ProjectSnapshotV2>(`/agent/sessions/${sessionId}/snapshot`);
  return data;
}

export interface PinObservationPayload {
  metadataId: string;
  tagName?: string | null;
  pinNames: string[];
  propertySignature?: string | null;
}

/**
 * Send live runtime pin observations to the backend.
 * The backend stores these in an in-memory catalog so the agent gets
 * accurate pin names from the actual wokwi element instead of the
 * potentially stale components-metadata.json.
 *
 * Fire-and-forget — failures are silently ignored to never block the UI.
 */
export async function reportPinObservation(payload: PinObservationPayload): Promise<void> {
  await api.post('/agent/pin-observations', {
    metadataId: payload.metadataId,
    tagName: payload.tagName ?? null,
    pinNames: payload.pinNames,
    propertySignature: payload.propertySignature ?? null,
  });
}

export async function listAgentSessionEvents(
  sessionId: string,
  after: number = 0,
): Promise<AgentSessionEvent[]> {
  const { data } = await api.get<AgentSessionEvent[]>(`/agent/sessions/${sessionId}/events`, {
    params: { after, stream: false },
  });
  return data;
}

/**
 * Sync the user's current canvas snapshot into the agent session so the agent
 * always works from the latest canvas state rather than the stale snapshot
 * captured at session-creation time.
 */
export async function syncCanvasToSession(
  sessionId: string,
  snapshot: ProjectSnapshotV2,
): Promise<AgentSession> {
  const { data } = await api.patch<AgentSession>(`/agent/sessions/${sessionId}/canvas`, snapshot);
  return data;
}
