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

export async function createAgentSession(payload: CreateAgentSessionRequest): Promise<AgentSession> {
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
  const { data } = await api.post<AgentSession>(`/agent/sessions/${sessionId}/messages`, { message });
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

export async function getAgentSessionSnapshot(sessionId: string): Promise<ProjectSnapshotV2> {
  const { data } = await api.get<ProjectSnapshotV2>(`/agent/sessions/${sessionId}/snapshot`);
  return data;
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
