import type {
  AgentArtifacts,
  AgentEventType,
  AgentStreamEvent,
} from "../services/agentService";

export type AgentMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "error";

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  timestamp: string;
  traceType?: AgentEventType | "history";
  toolName?: string | null;
  toolCallId?: string | null;
  payload?: unknown;
  toolCalls?: string[] | null;
  artifacts?: AgentArtifacts | null;
  status?: string;
}

export interface AgentStreamRuntimeState {
  assistantDraftId: string | null;
  thinkingMessageId: string | null;
  toolMessageByCallId: Record<string, string>;
}

export interface AgentStreamSideEffects {
  errorText?: string;
  doneSessionId?: string;
}

export interface ReduceAgentStreamEventInput {
  messages: AgentMessage[];
  runtime: AgentStreamRuntimeState;
  event: AgentStreamEvent;
  nowIso: string;
  nextMessageId: (prefix: string) => string;
}

export interface ReduceAgentStreamEventOutput {
  messages: AgentMessage[];
  runtime: AgentStreamRuntimeState;
  effects: AgentStreamSideEffects;
}

export const INITIAL_AGENT_STREAM_RUNTIME: AgentStreamRuntimeState = {
  assistantDraftId: null,
  thinkingMessageId: null,
  toolMessageByCallId: {},
};

export function createInitialStreamRuntime(): AgentStreamRuntimeState {
  return {
    assistantDraftId: null,
    thinkingMessageId: null,
    toolMessageByCallId: {},
  };
}

function cloneRuntime(
  runtime: AgentStreamRuntimeState,
): AgentStreamRuntimeState {
  return {
    assistantDraftId: runtime.assistantDraftId,
    thinkingMessageId: runtime.thinkingMessageId,
    toolMessageByCallId: { ...runtime.toolMessageByCallId },
  };
}

function updateMessageById(
  messages: AgentMessage[],
  id: string,
  updater: (message: AgentMessage) => AgentMessage,
): AgentMessage[] {
  let found = false;
  const updated = messages.map((message) => {
    if (message.id !== id) return message;
    found = true;
    return updater(message);
  });

  return found ? updated : messages;
}

function readToolCallId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;

  const raw = (value as { tool_call_id?: unknown }).tool_call_id;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readToolName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;

  const raw = (value as { tool_name?: unknown }).tool_name;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function formatStreamEventContent(event: AgentStreamEvent): string {
  if (typeof event.content === "string") return event.content;

  if (event.type === "tool_call" && event.tool_call) {
    return JSON.stringify(event.tool_call, null, 2);
  }

  if (event.type === "tool_result" && event.tool_result) {
    return JSON.stringify(event.tool_result, null, 2);
  }

  if (event.content && typeof event.content === "object") {
    return JSON.stringify(event.content, null, 2);
  }

  return "";
}

export function reduceAgentStreamEvent(
  input: ReduceAgentStreamEventInput,
): ReduceAgentStreamEventOutput {
  const { messages, event, nowIso, nextMessageId } = input;
  const runtime = cloneRuntime(input.runtime);
  const effects: AgentStreamSideEffects = {};
  const content = formatStreamEventContent(event);

  switch (event.type) {
    case "done": {
      runtime.assistantDraftId = null;
      runtime.thinkingMessageId = null;

      if (event.content && typeof event.content === "object") {
        const sessionId = (event.content as { session_id?: unknown })
          .session_id;
        if (typeof sessionId === "string" && sessionId.length > 0) {
          effects.doneSessionId = sessionId;
        }
      }

      return { messages, runtime, effects };
    }

    case "error": {
      const errorText = content || "Agent request failed";
      runtime.assistantDraftId = null;
      runtime.thinkingMessageId = null;
      effects.errorText = errorText;

      return {
        messages: [
          ...messages,
          {
            id: nextMessageId("error"),
            role: "error",
            content: errorText,
            timestamp: nowIso,
            traceType: "error",
            status: "error",
          },
        ],
        runtime,
        effects,
      };
    }

    case "thinking": {
      if (!content) {
        return { messages, runtime, effects };
      }

      if (runtime.thinkingMessageId) {
        return {
          messages: updateMessageById(
            messages,
            runtime.thinkingMessageId,
            (msg) => ({
              ...msg,
              role: "system",
              content,
              timestamp: nowIso,
              traceType: "thinking",
              status: "running",
            }),
          ),
          runtime,
          effects,
        };
      }

      const messageId = nextMessageId("thinking");
      runtime.thinkingMessageId = messageId;

      return {
        messages: [
          ...messages,
          {
            id: messageId,
            role: "system",
            content,
            timestamp: nowIso,
            traceType: "thinking",
            status: "running",
          },
        ],
        runtime,
        effects,
      };
    }

    case "tool_call": {
      const toolCallId = readToolCallId(event.tool_call);
      const toolName = readToolName(event.tool_call);
      const existingMessageId = toolCallId
        ? runtime.toolMessageByCallId[toolCallId]
        : undefined;
      const toolText = content || "Tool call started";

      if (existingMessageId) {
        return {
          messages: updateMessageById(messages, existingMessageId, (msg) => ({
            ...msg,
            role: "tool",
            content: toolText,
            timestamp: nowIso,
            traceType: "tool_call",
            toolName,
            toolCallId,
            payload: event.tool_call ?? null,
            status: "running",
          })),
          runtime,
          effects,
        };
      }

      const messageId = nextMessageId("tool");
      if (toolCallId) {
        runtime.toolMessageByCallId[toolCallId] = messageId;
      }

      return {
        messages: [
          ...messages,
          {
            id: messageId,
            role: "tool",
            content: toolText,
            timestamp: nowIso,
            traceType: "tool_call",
            toolName,
            toolCallId,
            payload: event.tool_call ?? null,
            status: "running",
          },
        ],
        runtime,
        effects,
      };
    }

    case "tool_result": {
      const toolCallId = readToolCallId(event.tool_result);
      const toolName = readToolName(event.tool_result);
      const existingMessageId = toolCallId
        ? runtime.toolMessageByCallId[toolCallId]
        : undefined;
      const toolText = content || "Tool call completed";

      if (existingMessageId) {
        return {
          messages: updateMessageById(messages, existingMessageId, (msg) => ({
            ...msg,
            role: "tool",
            content: toolText,
            timestamp: nowIso,
            traceType: "tool_result",
            toolName,
            toolCallId,
            payload: event.tool_result ?? null,
            status: "completed",
          })),
          runtime,
          effects,
        };
      }

      const messageId = nextMessageId("tool");
      if (toolCallId) {
        runtime.toolMessageByCallId[toolCallId] = messageId;
      }

      return {
        messages: [
          ...messages,
          {
            id: messageId,
            role: "tool",
            content: toolText,
            timestamp: nowIso,
            traceType: "tool_result",
            toolName,
            toolCallId,
            payload: event.tool_result ?? null,
            status: "completed",
          },
        ],
        runtime,
        effects,
      };
    }

    case "response_chunk": {
      if (!content) {
        return { messages, runtime, effects };
      }

      runtime.thinkingMessageId = null;

      if (runtime.assistantDraftId) {
        return {
          messages: updateMessageById(
            messages,
            runtime.assistantDraftId,
            (msg) => ({
              ...msg,
              role: "assistant",
              content: `${msg.content}${content}`,
              timestamp: nowIso,
              traceType: "response_chunk",
              status: "streaming",
            }),
          ),
          runtime,
          effects,
        };
      }

      const draftId = nextMessageId("assistant");
      runtime.assistantDraftId = draftId;

      return {
        messages: [
          ...messages,
          {
            id: draftId,
            role: "assistant",
            content,
            timestamp: nowIso,
            traceType: "response_chunk",
            status: "streaming",
          },
        ],
        runtime,
        effects,
      };
    }

    case "response": {
      runtime.thinkingMessageId = null;

      if (runtime.assistantDraftId) {
        const draftId = runtime.assistantDraftId;
        runtime.assistantDraftId = null;

        if (!content) {
          return { messages, runtime, effects };
        }

        return {
          messages: updateMessageById(messages, draftId, (msg) => ({
            ...msg,
            role: "assistant",
            content,
            timestamp: nowIso,
            traceType: "response",
            artifacts: event.artifacts ?? msg.artifacts ?? null,
            status: "received",
          })),
          runtime,
          effects,
        };
      }

      if (!content) {
        return { messages, runtime, effects };
      }

      return {
        messages: [
          ...messages,
          {
            id: nextMessageId("assistant"),
            role: "assistant",
            content,
            timestamp: nowIso,
            traceType: "response",
            artifacts: event.artifacts ?? null,
            status: "received",
          },
        ],
        runtime,
        effects,
      };
    }

    default: {
      if (!content) {
        return { messages, runtime, effects };
      }

      return {
        messages: [
          ...messages,
          {
            id: nextMessageId("system"),
            role: "system",
            content,
            timestamp: nowIso,
            traceType: event.type,
          },
        ],
        runtime,
        effects,
      };
    }
  }
}
