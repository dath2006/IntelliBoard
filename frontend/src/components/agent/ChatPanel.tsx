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
  usePromptInputAttachments,
  PromptInputButton,
} from '../ai-elements/prompt-input';
import { CompactModelSelector } from './ModelSelector';
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '../ai-elements/tool';
import {
  Plan,
  PlanHeader,
  PlanTitle,
  PlanDescription,
  PlanTrigger,
  PlanContent,
} from '../ai-elements/plan';
import {
  ChainOfThought,
  ChainOfThoughtHeader,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
} from '../ai-elements/chain-of-thought';
import { CheckCircle2Icon, LucideTerminal, CheckIcon, XIcon, RefreshCwIcon, Loader2, Paperclip, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { McqCard } from './McqCard';
import { useAgentSync, buildSnapshotFromStores } from './useAgentSync';
import { TooltipProvider } from '@/components/ui/tooltip';
import { nanoid } from 'nanoid';
import { usePlanApprovalStore } from '../../store/usePlanApprovalStore';
import { AgentTodoPanel } from './AgentTodoPanel';
import { Button } from '@/components/ui/button';
import { Shimmer } from '../ai-elements/shimmer';

/** Floating approval card — shown while agent is waiting for plan approval */
function PlanApprovalCard({
  sessionId,
  onRegenerate,
}: {
  sessionId: string;
  onRegenerate: (feedback: string) => void;
}) {
  const pending = usePlanApprovalStore((s) => s.pending);
  const approve = usePlanApprovalStore((s) => s.approve);
  const cancel = usePlanApprovalStore((s) => s.cancel);
  const [showFeedback, setShowFeedback] = React.useState(false);
  const [feedback, setFeedback] = React.useState('');
  const feedbackRef = React.useRef<HTMLTextAreaElement>(null);

  if (
    !pending ||
    pending.actionId === '' ||
    (pending.sessionId !== '' && pending.sessionId !== sessionId)
  )
    return null;

  const handleShowFeedback = () => {
    setShowFeedback(true);
    setTimeout(() => feedbackRef.current?.focus(), 50);
  };

  const handleRegenerate = () => {
    const text = feedback.trim();
    if (!text) return;
    cancel();
    onRegenerate(text);
    setFeedback('');
    setShowFeedback(false);
  };

  const handleCancel = () => {
    cancel();
    setShowFeedback(false);
    setFeedback('');
  };

  return (
    <div className="mx-4 mb-3 rounded-xl border border-border bg-card shadow-sm text-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-2">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-foreground leading-tight">{pending.title}</p>
          {pending.description && (
            <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
              {pending.description}
            </p>
          )}
        </div>
        <span className="shrink-0 mt-0.5 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
          Awaiting approval
        </span>
      </div>

      {/* Steps */}
      <div className="px-4 pb-3 space-y-0 border-t border-border/50 pt-3">
        {pending.steps.map((step, si) => (
          <div key={si} className="flex items-start gap-2.5 py-1.5">
            <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
              {si + 1}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground leading-snug">{step.label}</p>
              {step.description && (
                <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                  {step.description}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Feedback input — shown when user clicks "Change plan" */}
      {showFeedback && (
        <div className="px-4 pb-3 border-t border-border/50 pt-3 space-y-2">
          <p className="text-[11px] text-muted-foreground">
            Describe what you'd like to change and the agent will generate a new plan.
          </p>
          <textarea
            ref={feedbackRef}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            rows={3}
            placeholder="e.g. Use SSD1306 OLED instead of LCD, and add a temperature sensor…"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRegenerate();
            }}
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between gap-2 border-t border-border/50 px-4 py-2.5 bg-muted/30">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={
              showFeedback
                ? () => {
                    setShowFeedback(false);
                    setFeedback('');
                  }
                : handleShowFeedback
            }
          >
            <RefreshCwIcon className="size-3" />
            {showFeedback ? 'Cancel change' : 'Change plan'}
          </Button>
          {showFeedback && (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 gap-1.5 text-xs"
              disabled={!feedback.trim()}
              onClick={handleRegenerate}
            >
              <RefreshCwIcon className="size-3" />
              Regenerate
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={handleCancel}
          >
            <XIcon className="size-3" />
            Cancel
          </Button>
          <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => approve()}>
            <CheckIcon className="size-3" />
            Approve & run
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ChatPanelProps {
  sessionId: string;
  defaultModelName: string;
  onModelChange: (model: string) => void;
}

interface ParsedMcq {
  textBefore: string;
  mcqData: any | null;
  textAfter: string;
  hasMcq: boolean;
}

function parseMcqText(text: string): ParsedMcq {
  const match = text.match(/(?:__mcq__|mcq):\s*(\{.*)/si);
  if (!match) {
    return { textBefore: text, mcqData: null, textAfter: '', hasMcq: false };
  }

  const index = match.index ?? 0;
  const textBefore = text.slice(0, index).trim();
  const jsonCandidate = match[1];

  let braceCount = 0;
  let endOfJsonIndex = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < jsonCandidate.length; i++) {
    const char = jsonCandidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          endOfJsonIndex = i + 1;
          break;
        }
      }
    }
  }

  if (endOfJsonIndex !== -1) {
    const jsonStr = jsonCandidate.slice(0, endOfJsonIndex);
    const textAfter = jsonCandidate.slice(endOfJsonIndex).trim();
    try {
      const mcqData = JSON.parse(jsonStr);
      return { textBefore, mcqData, textAfter, hasMcq: true };
    } catch {
      return { textBefore, mcqData: null, textAfter: '', hasMcq: true };
    }
  } else {
    return { textBefore, mcqData: null, textAfter: '', hasMcq: true };
  }
}

interface ChatMessageProps {
  message: UIMessage;
  isBusy: boolean;
  onMcqSubmit: (text: string) => void;
}

/** Memoized message component to prevent re-renders of stable messages during streaming */
const ChatMessage = React.memo(function ChatMessage({ message, isBusy, onMcqSubmit }: ChatMessageProps) {
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
            if (part.text.startsWith('__plan__:')) {
              let planData: {
                title: string;
                description: string;
                steps: { label: string; description: string }[];
                approved: boolean | null;
              } | null = null;
              try {
                planData = JSON.parse(part.text.slice('__plan__:'.length));
              } catch {
                /* ignore */
              }
              if (planData) {
                const isApproved = planData.approved === true;
                const isCancelled = planData.approved === false;
                return (
                  <div key={`${message.id}-plan-${pi}`} className={cn('w-full', pi > 0 && 'mt-3')}>
                    <Plan className="border-border/50 bg-muted/20 text-xs">
                      <PlanHeader>
                        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <PlanTitle>{planData.title}</PlanTitle>
                            {isApproved && (
                              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                Approved
                              </span>
                            )}
                            {isCancelled && (
                              <span className="rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                                Cancelled
                              </span>
                            )}
                          </div>
                          {planData.description && (
                            <PlanDescription>{planData.description}</PlanDescription>
                          )}
                        </div>
                        <PlanTrigger />
                      </PlanHeader>
                      <PlanContent className="pt-0 pb-3 px-4">
                        <ChainOfThought defaultOpen>
                          <ChainOfThoughtHeader>Steps</ChainOfThoughtHeader>
                          <ChainOfThoughtContent>
                            {planData.steps.map((step, si) => (
                              <ChainOfThoughtStep
                                key={si}
                                icon={CheckCircle2Icon}
                                label={step.label}
                                description={step.description}
                                status="complete"
                              />
                            ))}
                          </ChainOfThoughtContent>
                        </ChainOfThought>
                      </PlanContent>
                    </Plan>
                  </div>
                );
              }
            }
            if (part.text.includes('__mcq__:') || part.text.match(/(?:__mcq__|mcq):\s*\{/i)) {
              const parsed = parseMcqText(part.text);
              if (parsed.hasMcq) {
                return (
                  <div key={`${message.id}-mcq-container-${pi}`} className="space-y-3.5 w-full">
                    {parsed.textBefore && (
                      <div className="max-w-none">
                        <MessageResponse>{parsed.textBefore}</MessageResponse>
                      </div>
                    )}

                    {parsed.mcqData ? (
                      <McqCard
                        messageId={message.id}
                        mcqData={parsed.mcqData}
                        onSubmit={onMcqSubmit}
                      />
                    ) : (
                      <div className="w-full p-4 border border-dashed rounded-xl bg-muted/20 animate-pulse text-xs text-muted-foreground flex items-center gap-2">
                        <Loader2 className="size-3.5 animate-spin" />
                        Generating question clarification...
                      </div>
                    )}

                    {parsed.textAfter && (
                      <div className="max-w-none">
                        <MessageResponse>{parsed.textAfter}</MessageResponse>
                      </div>
                    )}
                  </div>
                );
              }
            }

            return (
              <MessageResponse key={`${message.id}-t-${pi}`}>
                {part.text}
              </MessageResponse>
            );
          }
          if (part.type === 'file') {
            const isImage = part.mediaType.startsWith('image/');
            if (isImage) {
              return (
                <div key={`${message.id}-f-${pi}`} className="mt-2 shrink-0">
                  <img
                    src={part.url}
                    alt={part.filename}
                    className="max-w-xs max-h-48 rounded-lg border border-border/50 object-contain shadow-sm bg-background"
                  />
                </div>
              );
            }
            return (
              <div key={`${message.id}-f-${pi}`} className="mt-2 flex items-center gap-2.5 p-2 rounded-lg bg-card/50 border border-border/50 max-w-sm shrink-0">
                <div className="p-1.5 rounded bg-muted text-muted-foreground">
                  <FileText className="size-4" />
                </div>
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-xs font-medium text-foreground truncate">{part.filename}</p>
                  <p className="text-[10px] text-muted-foreground uppercase">{part.mediaType.split('/')[1] || 'file'}</p>
                </div>
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

const ComposerAttachments = () => {
  const { files, remove } = usePromptInputAttachments();
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3 pb-1 border-b border-border/30 bg-muted/10 shrink-0">
      {files.map((file) => {
        const isImage = file.mediaType.startsWith('image/');
        return (
          <div
            key={file.id}
            className="group relative flex items-center gap-2 p-1.5 pr-8 rounded-lg bg-card border border-border/80 text-xs max-w-[200px]"
          >
            {isImage ? (
              <img
                src={file.url}
                alt={file.filename}
                className="size-8 rounded object-cover border border-border/50"
              />
            ) : (
              <div className="p-1 rounded bg-muted text-muted-foreground shrink-0">
                <FileText className="size-4" />
              </div>
            )}
            <span className="truncate font-medium text-foreground">{file.filename}</span>
            <button
              type="button"
              onClick={() => remove(file.id)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};

const AttachmentButton = ({ disabled }: { disabled?: boolean }) => {
  const { openFileDialog } = usePromptInputAttachments();
  return (
    <PromptInputButton
      tooltip="Attach images or documents"
      onClick={openFileDialog}
      size="icon-sm"
      disabled={disabled}
    >
      <Paperclip className="size-4" />
    </PromptInputButton>
  );
};

const ComposerSubmitButton = ({
  isBusy,
  status,
  onStop,
  textInput,
}: {
  isBusy: boolean;
  status: any;
  onStop: () => void;
  textInput: string;
}) => {
  const { files } = usePromptInputAttachments();
  const hasContent = textInput.trim().length > 0 || files.length > 0;
  return (
    <PromptInputSubmit
      status={isBusy ? status : undefined}
      onStop={onStop}
      disabled={!hasContent && !isBusy}
    />
  );
};

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

        {/* Live todo progress — pinned at top, always visible while active */}
        <AgentTodoPanel sessionId={sessionId} />

        <Conversation
          className={cn('flex-1 min-h-0 chat-panel-scroll', !isBusy && 'chat-panel-scroll--smooth')}
          initial="instant"
          resize="instant"
        >
          <ConversationContent className="pb-4 pt-4 px-4 gap-6">
            {messages.length === 0 && (
              <ConversationEmptyState
                className="min-h-[200px]"
                title="IntelliBoard agent"
                description="Describe schematic or sketch changes — canvas and files sync automatically when you edit."
              />
            )}

            {memoizedMessages.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                isBusy={isBusy}
                onMcqSubmit={(text) => sendMessage({ text })}
              />
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

        {/* Plan approval card — shown while agent awaits plan approval */}
        <PlanApprovalCard
          sessionId={sessionId}
          onRegenerate={(feedback) => {
            sendMessage({ text: feedback });
            setInputUi('');
          }}
        />

        {/* Composer */}
        <div className="shrink-0 p-4 border-t border-border bg-background">
          <div className="max-w-3xl mx-auto">
            <PromptInput
              className="bg-background border border-border shadow-sm rounded-xl"
              accept="image/*,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"
              multiple={true}
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
              <ComposerAttachments />
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
                  <div className="flex items-center gap-1.5 min-w-0 text-[10px] text-muted-foreground font-mono mr-1">
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

                  <AttachmentButton disabled={isBusy} />
                </PromptInputTools>

                <div className="flex items-center shrink-0">
                  <ComposerSubmitButton
                    isBusy={isBusy}
                    status={status}
                    onStop={() => stop()}
                    textInput={inputUi}
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
