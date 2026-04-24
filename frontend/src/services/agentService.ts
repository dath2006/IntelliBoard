import axios from "axios";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

const api = axios.create({ baseURL: API_BASE, withCredentials: true });

export type AgentEventType =
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "response_chunk"
  | "response"
  | "done"
  | "error";

export interface AgentArtifacts {
  code_changes?: Array<{ name: string; content: string }>;
  circuit_changes?: Record<string, unknown>;
  compile_result?: Record<string, unknown>;
  simulation_action?: Record<string, unknown>;
  serial_snapshot?: Record<string, unknown>;
}

export interface AgentStreamEvent {
  type: AgentEventType;
  content: unknown;
  tool_call?: Record<string, unknown>;
  tool_result?: Record<string, unknown>;
  artifacts?: AgentArtifacts;
}

export interface AgentChatRequest {
  project_id: string;
  prompt: string;
  session_id?: string | null;
  include_serial_logs?: boolean;
  serial_output?: string;
  api_key?: string;
  /** Current circuit snapshot passed from the canvas (components + wires). */
  current_circuit?: Record<string, unknown>;
  /** Active code files map {filename: content}. */
  active_code?: Record<string, string>;
}

export interface AgentSessionSummary {
  id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  preview_text: string;
}

export interface AgentSessionMessage {
  role: "user" | "assistant" | "system" | "tool" | "error" | string;
  content: string;
  timestamp: string;
  tool_calls?: string[] | null;
  artifacts?: AgentArtifacts | null;
  status?: string;
}

export interface AgentSessionDetail {
  session_id: string;
  project_id: string;
  created_at: string | null;
  conversation_messages: AgentSessionMessage[];
  current_circuit_snapshot: Record<string, unknown>;
  current_code_snapshot: Record<string, unknown>;
  message_count: number;
}

export interface ForkSessionResponse {
  new_session_id: string;
  new_project_id: string;
  forked_circuit: Record<string, unknown>;
  forked_code: Record<string, unknown>;
}

export async function initAgentSession(
  _userId: string | null,
  projectId: string,
): Promise<{ session_id: string | null }> {
  const { data } = await api.get<{ sessions: AgentSessionSummary[] }>(
    "/agent/sessions",
    {
      params: { project_id: projectId },
    },
  );
  const latest = data.sessions?.[0]?.id ?? null;
  return { session_id: latest };
}

export async function listAgentSessions(
  projectId: string,
): Promise<AgentSessionSummary[]> {
  const { data } = await api.get<{
    project_id: string;
    sessions: AgentSessionSummary[];
    total: number;
  }>("/agent/sessions", {
    params: { project_id: projectId },
  });

  return data.sessions ?? [];
}

export async function getAgentSessionHistory(
  sessionId: string,
): Promise<AgentSessionDetail> {
  const { data } = await api.get<AgentSessionDetail>(
    `/agent/sessions/${sessionId}`,
  );
  return data;
}

export async function forkAgentSession(
  sessionId: string,
  newProjectId?: string,
): Promise<ForkSessionResponse> {
  const payload = newProjectId ? { new_project_id: newProjectId } : {};
  const { data } = await api.post<ForkSessionResponse>(
    `/agent/sessions/${sessionId}/fork`,
    payload,
  );
  return data;
}

function parseSSEChunk(chunk: string): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  const blocks = chunk.split("\n\n");

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    if (lines.length === 0) continue;

    const payload = lines.join("\n");
    try {
      const parsed = JSON.parse(payload) as AgentStreamEvent;
      events.push(parsed);
    } catch {
      events.push({
        type: "error",
        content: `Malformed SSE payload: ${payload}`,
      });
    }
  }

  return events;
}

export async function chatWithAgent(
  request: AgentChatRequest,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE}/agent/chat`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    let detail = `Agent chat failed (${response.status})`;
    try {
      const json = (await response.json()) as { detail?: string };
      if (json.detail) detail = json.detail;
    } catch {
      // Keep default message when body isn't JSON.
    }
    throw new Error(detail);
  }

  if (!response.body) {
    throw new Error("Agent stream unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lastBoundary = buffer.lastIndexOf("\n\n");
    if (lastBoundary === -1) continue;

    const completeChunk = buffer.slice(0, lastBoundary + 2);
    buffer = buffer.slice(lastBoundary + 2);

    for (const event of parseSSEChunk(completeChunk)) {
      onEvent(event);
    }
  }

  if (buffer.trim()) {
    for (const event of parseSSEChunk(buffer)) {
      onEvent(event);
    }
  }
}

export async function closeAgentSession(sessionId: string): Promise<void> {
  await api.delete(`/agent/sessions/${sessionId}`, {
    data: { confirm: true },
  });
}
