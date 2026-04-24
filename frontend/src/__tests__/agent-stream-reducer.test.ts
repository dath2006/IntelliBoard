import { describe, expect, it } from "vitest";

import type { AgentStreamEvent } from "../services/agentService";
import {
  createInitialStreamRuntime,
  reduceAgentStreamEvent,
  type AgentMessage,
  type AgentStreamRuntimeState,
} from "../hooks/agentStreamReducer";

function reduceEvent(
  messages: AgentMessage[],
  runtime: AgentStreamRuntimeState,
  event: AgentStreamEvent,
) {
  return reduceAgentStreamEvent({
    messages,
    runtime,
    event,
    nowIso: "2026-04-22T12:00:00.000Z",
    nextMessageId: (prefix) => `${prefix}-id`,
  });
}

describe("agentStreamReducer", () => {
  it("coalesces response chunks into one assistant draft message", () => {
    const initialRuntime = createInitialStreamRuntime();

    const first = reduceEvent([], initialRuntime, {
      type: "response_chunk",
      content: "Hello",
    });

    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({
      role: "assistant",
      content: "Hello",
    });

    const second = reduceEvent(first.messages, first.runtime, {
      type: "response_chunk",
      content: " world",
    });

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({
      role: "assistant",
      content: "Hello world",
    });
  });

  it("updates tool lifecycle in a single tool message", () => {
    const first = reduceEvent([], createInitialStreamRuntime(), {
      type: "tool_call",
      content: "create_circuit starting",
      tool_call: {
        tool_name: "create_circuit",
        tool_call_id: "tc-1",
      },
    });

    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].role).toBe("tool");

    const second = reduceEvent(first.messages, first.runtime, {
      type: "tool_result",
      content: "create_circuit completed",
      tool_result: {
        tool_name: "create_circuit",
        tool_call_id: "tc-1",
      },
    });

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({
      role: "tool",
      content: "create_circuit completed",
    });
  });

  it("stores streamed tool metadata and final response artifacts", () => {
    const toolCall = reduceEvent([], createInitialStreamRuntime(), {
      type: "tool_call",
      content: "Calling create_circuit...",
      tool_call: {
        tool_name: "create_circuit",
        tool_call_id: "tc-2",
        args: { board_fqbn: "arduino:avr:uno" },
      },
    });

    expect(toolCall.messages[0]).toMatchObject({
      traceType: "tool_call",
      toolName: "create_circuit",
      toolCallId: "tc-2",
      status: "running",
    });

    const finalResponse = reduceEvent([], createInitialStreamRuntime(), {
      type: "response",
      content: "Created the circuit and sketch.",
      artifacts: {
        circuit_changes: { board_fqbn: "arduino:avr:uno" },
        code_changes: [{ name: "sketch.ino", content: "void setup() {}" }],
      },
    });

    expect(finalResponse.messages[0]).toMatchObject({
      role: "assistant",
      traceType: "response",
      status: "received",
      artifacts: {
        circuit_changes: { board_fqbn: "arduino:avr:uno" },
        code_changes: [{ name: "sketch.ino", content: "void setup() {}" }],
      },
    });
  });

  it("replaces draft content with final response payload", () => {
    const draft = reduceEvent([], createInitialStreamRuntime(), {
      type: "response_chunk",
      content: "Partial text",
    });

    const finalResponse = reduceEvent(draft.messages, draft.runtime, {
      type: "response",
      content: "Canonical final response",
    });

    expect(finalResponse.messages).toHaveLength(1);
    expect(finalResponse.messages[0]).toMatchObject({
      role: "assistant",
      content: "Canonical final response",
    });
    expect(finalResponse.runtime.assistantDraftId).toBeNull();
  });

  it("keeps only one thinking message and updates its content", () => {
    const first = reduceEvent([], createInitialStreamRuntime(), {
      type: "thinking",
      content: "Planning...",
    });

    const second = reduceEvent(first.messages, first.runtime, {
      type: "thinking",
      content: "Selecting tools...",
    });

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({
      role: "system",
      content: "Selecting tools...",
    });
  });

  it("returns done side effect with session id", () => {
    const doneResult = reduceEvent([], createInitialStreamRuntime(), {
      type: "done",
      content: { session_id: "session-123" },
    });

    expect(doneResult.effects.doneSessionId).toBe("session-123");
  });
});
