import React, { useEffect, useMemo, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  isTextUIPart,
  isToolUIPart,
  isReasoningUIPart,
  type DynamicToolUIPart,
  type UIMessage,
} from 'ai';
import { useAgentStore } from '../../store/useAgentStore';
import { convertTraceToMessages } from './convertTraceToMessages';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '../ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '../ai-elements/message';
import { Reasoning, ReasoningTrigger, ReasoningContent } from '../ai-elements/reasoning';
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputFooter,
  PromptInputTools,
} from '../ai-elements/prompt-input';
import { CompactModelSelector } from './ModelSelector';
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '../ai-elements/tool';
import { cn } from '@/lib/utils';
import { useAgentSync, buildSnapshotFromStores } from './useAgentSync';
import { TooltipProvider } from '@/components/ui/tooltip';
import { LucideTerminal } from 'lucide-react';
import { nanoid } from 'nanoid';
import { Shimmer } from '../ai-elements/shimmer';

interface ChatPanelProps {
  sessionId: string;
  defaultModelName: string;
  onModelChange: (model: string) => void;
}

interface ChatMessageProps {
  message: UIMessage;
  isBusy: boolean;
}

/** Memoized message component to prevent re-renders of stable messages during streaming */
const ChatMessage = React.memo(function ChatMessage({ message, isBusy }: ChatMessageProps) {
  const isUser = message.role === 'user';

  return (
    <Message from={message.role as UIMessage['role']} className={cn(!isUser && 'max-w-none')}>
      <MessageContent
        className={cn(
          'group relative max-w-[min(100%,52rem)] rounded-xl border px-4 py-3',
          isUser && 'border-transparent bg-primary text-primary-foreground',
          !isUser && 'bg-muted/50 text-foreground border-border/50',
        )}
      >
        {message.parts.map((part, pi) => {
          if (isReasoningUIPart(part)) {
            return (
              <Reasoning
                key={`${message.id}-r-${pi}`}
                isStreaming={isBusy && pi === message.parts.length - 1}
              >
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );
          }
          if (isTextUIPart(part)) {
            return (
              <div key={`${message.id}-t-${pi}`} className={cn('max-w-none', pi > 0 && 'mt-3')}>
                <MessageResponse>{part.text}</MessageResponse>
              </div>
            );
          }
          if (isToolUIPart(part)) {
            const shouldDefaultOpen =
              part.state === 'output-available' || part.state === 'output-error';
            const isDynamicTool = part.type === 'dynamic-tool';
            const toolName = isDynamicTool ? (part as DynamicToolUIPart).toolName : undefined;

            return (
              <div key={part.toolCallId} className={cn('not-prose', pi > 0 && 'mt-2')}>
                <Tool defaultOpen={shouldDefaultOpen} className="mb-2 text-xs">
                  {isDynamicTool ? (
                    <ToolHeader
                      type="dynamic-tool"
                      state={part.state}
                      toolName={toolName!}
                      className="py-2 px-2.5"
                    />
                  ) : (
                    <ToolHeader
                      type={part.type as `tool-${string}`}
                      state={part.state}
                      className="py-2 px-2.5"
                    />
                  )}
                  <ToolContent className="p-2.5 space-y-2">
                    {(part.state === 'input-available' ||
                      part.state === 'output-available' ||
                      part.state === 'output-error') && (
                      <ToolInput input={part.input} className="space-y-1.5" />
                    )}
                    {(part.state === 'output-available' || part.state === 'output-error') && (
                      <ToolOutput
                        output={part.output}
                        errorText={part.errorText}
                        className="space-y-1.5"
                      />
                    )}
                  </ToolContent>
                </Tool>
              </div>
            );
          }
          return null;
        })}
      </MessageContent>
    </Message>
  );
});

/** Readable copy for Vercel / Pydantic validation payloads returned as JSON in error text. */
function ChatRequestError({ message }: { message: string }) {
  const trimmed = message.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const first = rows[0] as Record<string, unknown> | undefined;
      const msg = typeof first?.msg === 'string' ? first.msg : null;
      const loc = Array.isArray(first?.loc) ? (first.loc as unknown[]).join(' · ') : null;
      if (msg) {
        return (
          <>
            <p className="font-medium text-destructive">{msg}</p>
            {loc ? (
              <p className="text-[11px] text-destructive/90 font-mono break-all">{loc}</p>
            ) : null}
          </>
        );
      }
    } catch {
      /* fall through */
    }
  }
  return <p className="whitespace-pre-wrap break-words">{message}</p>;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  sessionId,
  defaultModelName,
  onModelChange,
}) => {
  const tracesForSession = useAgentStore((s) => s.tracesBySession[sessionId] ?? []);
  const { streamStatus } = useAgentStore();

  useAgentSync(sessionId);

  const initialMessagesFromTrace = useMemo(
    () => convertTraceToMessages(tracesForSession),
    [tracesForSession],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/agent/chat-stream',
        credentials: 'include',
        fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
        prepareSendMessagesRequest: ({ id: chatId, messages, body, trigger, messageId }) => {
          const lastUser = [...messages].reverse().find((m) => m.role === 'user');
          const submitId =
            typeof messageId === 'string' && messageId.length > 0
              ? messageId
              : typeof lastUser?.id === 'string' && lastUser.id.length > 0
                ? lastUser.id
                : nanoid();
          const base =
            body !== null && body !== undefined && typeof body === 'object' && !Array.isArray(body)
              ? { ...(body as Record<string, unknown>) }
              : {};
          return {
            body: {
              ...base,
              id: submitId,
              sessionId: chatId,
              messages,
              modelName: useAgentStore.getState().defaultModelName,
              state: buildSnapshotFromStores(),
              trigger,
              messageId,
            },
          };
        },
      }),
    [],
  );

  const {
    messages,
    sendMessage,
    status,
    stop,
    regenerate,
    setMessages,
    error: chatTransportError,
    clearError,
  } = useChat({
    id: sessionId,
    messages: initialMessagesFromTrace,
    transport,
    onFinish: () => {},
    onError: (err: Error) => {
      console.error('Chat transport error:', err);
    },
  });

  const isBusy = status === 'streaming' || status === 'submitted';

  // Memoize the message list to prevent re-renders of unchanged messages
  const memoizedMessages = useMemo(() => messages, [messages]);

  /** Only hydrate from SSE traces when the thread is still empty — never replace after stream. */
  const didInitialTraceHydrateRef = useRef(false);

  useEffect(() => {
    didInitialTraceHydrateRef.current = false;
  }, [sessionId]);

  // Use a ref to track if we've hydrated to avoid effect re-runs
  const hasHydratedRef = useRef(false);

  useEffect(() => {
    if (status === 'streaming' || status === 'submitted') {
      hasHydratedRef.current = false;
      return;
    }
    // Only hydrate once when not streaming and messages are empty
    if (messages.length === 0 && !hasHydratedRef.current && tracesForSession.length > 0) {
      const fromTrace = convertTraceToMessages(tracesForSession);
      if (fromTrace.length > 0) {
        hasHydratedRef.current = true;
        didInitialTraceHydrateRef.current = true;
        setMessages(fromTrace);
      }
    }
  }, [tracesForSession, status]); // Removed setMessages and messages from deps

  const [inputUi, setInputUi] = React.useState('');
  const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false);

  const handleClear = () => {
    setMessages([]);
    didInitialTraceHydrateRef.current = true;
    clearError();
  };

  return (
    <TooltipProvider>
      <div className="flex flex-col h-full bg-background relative overflow-hidden">
        {/* Thread toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <div
            className={cn(
              'size-2 rounded-full shrink-0',
              isBusy ? 'bg-primary animate-pulse' : 'bg-muted-foreground/40',
            )}
          />
          <span className="text-[11px] font-medium text-muted-foreground truncate">
            {isBusy ? 'Responding…' : 'Ready'}
          </span>
        </div>

        {chatTransportError && (
          <div className="mx-3 mt-3 text-xs rounded-lg border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2.5 shrink-0 space-y-1">
            <ChatRequestError message={chatTransportError.message} />
          </div>
        )}

        <Conversation
          className="flex-1 min-h-0 chat-panel-scroll"
          initial={isBusy ? 'instant' : 'smooth'}
          resize={isBusy ? 'instant' : 'smooth'}
        >
          <ConversationContent className="pb-4 pt-4 px-4 gap-6">
            {messages.length === 0 && (
              <ConversationEmptyState
                className="min-h-[200px]"
                title="Velxio agent"
                description="Describe schematic or sketch changes — canvas and files sync automatically when you edit."
              />
            )}

            {memoizedMessages.map((message) => (
              <ChatMessage key={message.id} message={message} isBusy={isBusy} />
            ))}

            {isBusy && messages[messages.length - 1]?.role === 'user' && (
              <Message from="assistant" className="opacity-70">
                <MessageContent className="border border-dashed border-border/60 rounded-xl px-3 py-2.5 bg-muted/30">
                  <Shimmer className="text-xs">Thinking…</Shimmer>
                </MessageContent>
              </Message>
            )}
          </ConversationContent>
          <ConversationScrollButton className="mb-4" />
        </Conversation>

        {/* Composer */}
        <div className="shrink-0 p-4 border-t border-border bg-background">
          <div className="max-w-3xl mx-auto">
            <PromptInput
              className="bg-background border border-border shadow-sm rounded-xl"
              onSubmit={async (msg, ev) => {
                if (ev) ev.preventDefault();
                const raw = typeof msg?.text === 'string' ? msg.text : '';
                const text = raw.trim();
                if (!text && !(msg.files && msg.files.length > 0)) return;

                if (chatTransportError) clearError();

                if (msg.files && msg.files.length > 0) {
                  await sendMessage({ text, files: msg.files });
                } else {
                  await sendMessage({ text });
                }
                setInputUi('');
              }}
            >
              <PromptInputTextarea
                placeholder="Describe the circuit or code change…"
                value={inputUi}
                onChange={(ev) => setInputUi(ev.target.value)}
                className={cn(
                  'py-3 px-4 text-sm placeholder:text-muted-foreground',
                  'focus-visible:ring-0 focus-visible:ring-offset-0',
                  'resize-none min-h-[44px]',
                )}
              />
              <PromptInputFooter className="px-3 pb-2.5 pt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/50">
                <PromptInputTools className="flex items-center gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0 text-[10px] text-muted-foreground font-mono">
                    <LucideTerminal size={11} aria-hidden />
                    <span className="truncate capitalize">
                      {streamStatus === 'open' ? 'live sync' : streamStatus}
                    </span>
                  </div>

                  <CompactModelSelector
                    value={defaultModelName}
                    onChange={onModelChange}
                    open={modelSelectorOpen}
                    onOpenChange={setModelSelectorOpen}
                  />
                </PromptInputTools>

                <div className="flex items-center shrink-0">
                  <PromptInputSubmit
                    status={isBusy ? status : undefined}
                    onStop={() => stop()}
                    disabled={!inputUi.trim() && !isBusy}
                  />
                </div>
              </PromptInputFooter>
            </PromptInput>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};
