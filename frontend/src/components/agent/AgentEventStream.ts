import type { AgentSessionEvent } from '../../services/agentSessions';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

type EventHandlers = {
  onEvent: (event: AgentSessionEvent) => void;
  onStatus: (status: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
  onError: (message: string) => void;
  onGap: (expectedNextSeq: number, actualSeq: number) => void;
};

const AGENT_SSE_EVENT_TYPES = [
  'session.created',
  'message.received',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'tool.call.started',
  'tool.call.result',
  'tool.call.failed',
  'frontend.action.request',
  'frontend.action.result',
  'model.output.delta',
  'model.output.final',
  'snapshot.updated',
  'session.applied',
  'session.discarded',
  'session.stopped',
] as const;

export class AgentEventStream {
  private readonly sessionId: string;
  private readonly handlers: EventHandlers;
  private source: EventSource | null = null;
  private lastSeq: number;
  private reconnectTimer: number | null = null;
  private closed = false;
  private reconnectAttempt = 0;

  constructor(sessionId: string, lastSeq: number, handlers: EventHandlers) {
    this.sessionId = sessionId;
    this.lastSeq = lastSeq;
    this.handlers = handlers;
  }

  start(): void {
    this.closed = false;
    this.reconnectAttempt = 0;
    this.connect();
  }

  reconnectNow(): void {
    if (this.closed) return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    this.handlers.onStatus('closed');
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  private connect(): void {
    this.handlers.onStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    const url = `${API_BASE}/agent/sessions/${encodeURIComponent(this.sessionId)}/events?stream=true&after=${this.lastSeq}`;
    const source = new EventSource(url, { withCredentials: true });
    this.source = source;

    source.onopen = () => {
      this.reconnectAttempt = 0;
      this.handlers.onStatus('open');
    };

    // Handle default unnamed events (event: message)
    source.onmessage = (ev) => {
      this.consumeRawMessage(ev.data);
    };

    // Backend emits named SSE events (event: run.completed, etc.), so we must
    // subscribe explicitly; onmessage alone won't receive those.
    for (const eventType of AGENT_SSE_EVENT_TYPES) {
      source.addEventListener(eventType, (ev: MessageEvent) => {
        this.consumeRawMessage(ev.data);
      });
    }

    source.onerror = () => {
      source.close();
      this.source = null;
      if (this.closed) return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    const delayMs = Math.min(15000, 500 * 2 ** Math.min(5, this.reconnectAttempt));
    this.handlers.onStatus('reconnecting');
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.connect();
    }, delayMs);
  }

  private consumeRawMessage(data: string): void {
    try {
      const parsed = JSON.parse(data) as AgentSessionEvent;
      if (typeof parsed.seq !== 'number' || parsed.seq <= this.lastSeq) return;
      if (parsed.seq > this.lastSeq + 1) {
        this.handlers.onGap(this.lastSeq + 1, parsed.seq);
      }
      this.lastSeq = parsed.seq;
      this.handlers.onEvent(parsed);
    } catch (err: unknown) {
      this.handlers.onError(err instanceof Error ? err.message : 'Failed to parse stream event');
    }
  }
}
