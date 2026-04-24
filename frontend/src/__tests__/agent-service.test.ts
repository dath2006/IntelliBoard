import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet, mockPost, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => ({
      get: mockGet,
      post: mockPost,
      delete: mockDelete,
    })),
  },
}));

import {
  closeAgentSession,
  forkAgentSession,
  getAgentSessionHistory,
  initAgentSession,
  listAgentSessions,
} from "../services/agentService";

describe("agentService session APIs", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
  });

  it("returns latest session id from initAgentSession", async () => {
    mockGet.mockResolvedValue({
      data: {
        sessions: [
          {
            id: "session-new",
            project_id: "proj-1",
            created_at: "2026-04-22T00:00:00Z",
            updated_at: "2026-04-22T01:00:00Z",
            message_count: 8,
            preview_text: "latest",
          },
          {
            id: "session-old",
            project_id: "proj-1",
            created_at: "2026-04-21T00:00:00Z",
            updated_at: "2026-04-21T01:00:00Z",
            message_count: 3,
            preview_text: "older",
          },
        ],
      },
    });

    const result = await initAgentSession(null, "proj-1");

    expect(result).toEqual({ session_id: "session-new" });
    expect(mockGet).toHaveBeenCalledWith("/agent/sessions", {
      params: { project_id: "proj-1" },
    });
  });

  it("lists sessions for a project", async () => {
    const sessions = [
      {
        id: "session-a",
        project_id: "proj-1",
        created_at: "2026-04-22T00:00:00Z",
        updated_at: "2026-04-22T01:00:00Z",
        message_count: 4,
        preview_text: "hello",
      },
    ];

    mockGet.mockResolvedValue({
      data: {
        project_id: "proj-1",
        sessions,
        total: 1,
      },
    });

    const result = await listAgentSessions("proj-1");

    expect(result).toEqual(sessions);
    expect(mockGet).toHaveBeenCalledWith("/agent/sessions", {
      params: { project_id: "proj-1" },
    });
  });

  it("loads session history", async () => {
    const detail = {
      session_id: "session-a",
      project_id: "proj-1",
      created_at: "2026-04-22T00:00:00Z",
      conversation_messages: [
        {
          role: "user",
          content: "Build LED",
          timestamp: "2026-04-22T00:00:01Z",
          tool_calls: null,
          artifacts: null,
          status: "sent",
        },
      ],
      current_circuit_snapshot: {},
      current_code_snapshot: {},
      message_count: 1,
    };

    mockGet.mockResolvedValue({ data: detail });

    const result = await getAgentSessionHistory("session-a");

    expect(result).toEqual(detail);
    expect(mockGet).toHaveBeenCalledWith("/agent/sessions/session-a");
  });

  it("forks a session", async () => {
    const forked = {
      new_session_id: "session-fork",
      new_project_id: "proj-1",
      forked_circuit: {},
      forked_code: {},
    };

    mockPost.mockResolvedValue({ data: forked });

    const result = await forkAgentSession("session-a");

    expect(result).toEqual(forked);
    expect(mockPost).toHaveBeenCalledWith("/agent/sessions/session-a/fork", {});
  });

  it("deletes a session with confirmation payload", async () => {
    mockDelete.mockResolvedValue({ data: { status: "deleted" } });

    await closeAgentSession("session-a");

    expect(mockDelete).toHaveBeenCalledWith("/agent/sessions/session-a", {
      data: { confirm: true },
    });
  });
});
