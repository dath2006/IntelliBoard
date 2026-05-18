import type { DynamicToolUIPart, UIMessage } from 'ai';
import type { AgentTraceItem } from '../../store/useAgentStore';

/** Sanitize tool names to comply with OpenAI API pattern ^[a-zA-Z0-9_-]+$. */
function sanitizeToolName(name: string | undefined | null): string {
  if (!name) return 'tool';
  // Replace dots and other invalid characters with underscores
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Extract plain text segments from hydrated UI messages (trace replay). */
export function flattenMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function makeDynamicToolPart(
  toolCallId: string,
  toolName: string,
  input: unknown,
  output?: unknown,
  failed?: boolean,
  error?: string,
): DynamicToolUIPart {
  const sanitizedToolName = sanitizeToolName(toolName);
  if (failed) {
    return {
      type: 'dynamic-tool',
      toolName: sanitizedToolName,
      toolCallId,
      state: 'output-error',
      input,
      errorText: error ?? 'Tool failed.',
    };
  }
  if (output !== undefined) {
    return {
      type: 'dynamic-tool',
      toolName: sanitizedToolName,
      toolCallId,
      state: 'output-available',
      input,
      output,
    };
  }
  return {
    type: 'dynamic-tool',
    toolName: sanitizedToolName,
    toolCallId,
    state: 'input-available',
    input,
  };
}

/**
 * Builds AI SDK UI messages from persisted agent trace rows (SSE / replay).
 */
export function convertTraceToMessages(traces: AgentTraceItem[]): UIMessage[] {
  if (!Array.isArray(traces) || traces.length === 0) return [];

  const messages: UIMessage[] = [];
  const sorted = [...traces].sort((a, b) => a.seq - b.seq);

  const resultByCallId = new Map<string, AgentTraceItem>();
  const resultByActionId = new Map<string, AgentTraceItem>();
  for (const t of sorted) {
    if (t.eventType === 'tool.call.result') {
      const cid = typeof t.payload?.toolCallId === 'string' ? t.payload.toolCallId : null;
      if (cid) resultByCallId.set(cid, t);
    } else if (t.eventType === 'frontend.action.result') {
      const aid = typeof t.payload?.actionId === 'string' ? t.payload.actionId : null;
      if (aid) resultByActionId.set(aid, t);
    }
  }

  const consumedResults = new Set<string>();

  for (const trace of sorted) {
    if (trace.eventType === 'run.started') {
      const msg = typeof trace.payload?.message === 'string' ? trace.payload.message.trim() : '';
      if (msg) {
        messages.push({
          id: trace.id,
          role: 'user',
          parts: [{ type: 'text', text: msg }],
        });
      }
      continue;
    }

    if (trace.eventType === 'model.output.final') {
      const text = typeof trace.compactText === 'string' ? trace.compactText.trim() : '';
      if (text) {
        messages.push({
          id: trace.id,
          role: 'assistant',
          parts: [{ type: 'text', text }],
        });
      }
      continue;
    }

    if (trace.eventType === 'tool.call.started') {
      const toolCallId =
        (typeof trace.payload?.toolCallId === 'string' && trace.payload.toolCallId) ||
        `tool-${trace.id}`;
      const toolName = typeof trace.payload?.tool === 'string' ? trace.payload.tool : 'tool';
      const input = trace.payload?.input ?? null;
      const resultRow = resultByCallId.get(toolCallId);

      let last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') {
        last = { id: `assistant-${toolCallId}`, role: 'assistant', parts: [] };
        messages.push(last);
      }

      if (resultRow) {
        consumedResults.add(`tc:${toolCallId}`);
        const out = resultRow.payload?.output ?? resultRow.payload?.result ?? null;
        const bad =
          typeof out === 'object' && out !== null && (out as Record<string, unknown>).ok === false;
        last.parts.push(
          makeDynamicToolPart(
            toolCallId,
            toolName,
            input,
            out,
            bad,
            bad ? String((out as { error?: string }).error ?? '') : undefined,
          ),
        );
      } else {
        last.parts.push(makeDynamicToolPart(toolCallId, toolName, input));
      }
      continue;
    }

    if (trace.eventType === 'tool.call.result') {
      const toolCallId =
        typeof trace.payload?.toolCallId === 'string' ? trace.payload.toolCallId : '';
      if (toolCallId && consumedResults.has(`tc:${toolCallId}`)) continue;

      const toolName = typeof trace.payload?.tool === 'string' ? trace.payload.tool : 'tool';
      const out = trace.payload?.output ?? trace.payload?.result ?? null;
      const bad =
        typeof out === 'object' && out !== null && (out as Record<string, unknown>).ok === false;

      let last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') {
        last = { id: `assistant-${trace.id}`, role: 'assistant', parts: [] };
        messages.push(last);
      }
      last.parts.push(
        makeDynamicToolPart(
          toolCallId || `tool-${trace.id}`,
          toolName,
          null,
          out,
          bad,
          bad ? String((out as { error?: string }).error ?? '') : undefined,
        ),
      );
      continue;
    }

    if (trace.eventType === 'tool.call.failed') {
      const toolName = typeof trace.payload?.tool === 'string' ? trace.payload.tool : 'tool';
      const err = typeof trace.payload?.error === 'string' ? trace.payload.error : 'Tool failed.';
      let last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') {
        last = { id: `assistant-${trace.id}`, role: 'assistant', parts: [] };
        messages.push(last);
      }
      last.parts.push(
        makeDynamicToolPart(
          `tool-${trace.id}`,
          toolName,
          trace.payload?.input ?? null,
          undefined,
          true,
          err,
        ),
      );
      continue;
    }

    if (trace.eventType === 'frontend.action.request') {
      const actionId =
        (typeof trace.payload?.actionId === 'string' && trace.payload.actionId) || `fa-${trace.id}`;
      const actionName =
        typeof trace.payload?.action === 'string' ? trace.payload.action : 'frontend_action';
      const input = trace.payload?.payload ?? trace.payload ?? null;
      const resultRow = resultByActionId.get(actionId);

      let last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') {
        last = { id: `assistant-fa-${actionId}`, role: 'assistant', parts: [] };
        messages.push(last);
      }

      if (resultRow) {
        consumedResults.add(`fa:${actionId}`);
        const merged = resultRow.payload ?? null;
        const bad =
          typeof merged === 'object' &&
          merged !== null &&
          (merged as Record<string, unknown>).ok === false;
        last.parts.push(
          makeDynamicToolPart(
            actionId,
            actionName,
            input,
            merged,
            bad,
            bad ? String((merged as { error?: string }).error ?? '') : undefined,
          ),
        );
      } else {
        last.parts.push(makeDynamicToolPart(actionId, actionName, input));
      }
      continue;
    }

    if (trace.eventType === 'frontend.action.result') {
      const actionId = typeof trace.payload?.actionId === 'string' ? trace.payload.actionId : '';
      if (actionId && consumedResults.has(`fa:${actionId}`)) continue;

      const actionName =
        typeof trace.payload?.action === 'string' ? trace.payload.action : 'frontend.action';
      let last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') {
        last = { id: `assistant-${trace.id}`, role: 'assistant', parts: [] };
        messages.push(last);
      }
      const merged = trace.payload ?? null;
      const bad =
        typeof merged === 'object' &&
        merged !== null &&
        (merged as Record<string, unknown>).ok === false;
      last.parts.push(
        makeDynamicToolPart(
          actionId || `fa-${trace.id}`,
          actionName,
          null,
          merged,
          bad,
          bad ? String((merged as { error?: string }).error ?? '') : undefined,
        ),
      );
      continue;
    }

    if (trace.eventType === 'plan.announced') {
      const steps = Array.isArray(trace.payload?.steps) ? trace.payload.steps : [];
      const approved = trace.payload?.approved as boolean | undefined;
      messages.push({
        id: trace.id,
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: `__plan__:${JSON.stringify({
              title: trace.payload?.title ?? 'Execution plan',
              description: trace.payload?.description ?? '',
              steps,
              approved: approved ?? null,
            })}`,
          },
        ],
      });
      continue;
    }

    // run.completed with output-only rows are represented via model.output.final already in traces.
  }

  return messages;
}
