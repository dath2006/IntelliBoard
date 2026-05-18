import React from 'react';
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionTrigger,
} from '../ai-elements/queue';
import { useTodoStore } from '../../store/useTodoStore';
import type { AgentTodoItem, TodoStatus } from '../../store/useTodoStore';
import { cn } from '@/lib/utils';
import { Loader2Icon } from 'lucide-react';

interface AgentTodoPanelProps {
  sessionId: string;
}

function statusLabel(status: TodoStatus): string {
  switch (status) {
    case 'in_progress':
      return 'In progress';
    case 'done':
      return 'Done';
    case 'skipped':
      return 'Skipped';
    default:
      return 'Pending';
  }
}

function TodoRow({ item }: { item: AgentTodoItem }) {
  const isDone = item.status === 'done';
  const isSkipped = item.status === 'skipped';
  const isInProgress = item.status === 'in_progress';
  const isCompleted = isDone || isSkipped;

  return (
    <QueueItem className="py-0.5 px-3">
      <div className="flex items-center gap-1.5 min-w-0">
        {isInProgress ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin text-primary" />
        ) : (
          <QueueItemIndicator completed={isCompleted} className="size-3" />
        )}
        <QueueItemContent
          completed={isCompleted}
          className={cn(
            'text-[11px] truncate flex-1 min-w-0',
            isSkipped && 'opacity-40',
            isInProgress && 'font-medium text-foreground',
          )}
        >
          {item.label}
        </QueueItemContent>
        <span
          className={cn(
            'ml-1 shrink-0 text-[10px]',
            isInProgress && 'text-primary font-medium',
            isSkipped && 'text-muted-foreground/50',
            isDone && 'text-muted-foreground/50',
            !isCompleted && !isInProgress && 'text-muted-foreground/40',
          )}
        >
          {statusLabel(item.status)}
        </span>
      </div>
    </QueueItem>
  );
}

const EMPTY_ITEMS: AgentTodoItem[] = [];

export function AgentTodoPanel({ sessionId }: AgentTodoPanelProps) {
  const items = useTodoStore((s) => s.todosBySession[sessionId]?.items ?? EMPTY_ITEMS);

  if (items.length === 0) return null;

  const doneCount = items.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  const total = items.length;
  const allDone = doneCount === total;
  const activeItem =
    items.find((t) => t.status === 'in_progress') ?? items.find((t) => t.status === 'pending');

  return (
    <div className="mx-4 mt-2 mb-0.5">
      <Queue className="rounded-lg border border-border bg-card shadow-sm overflow-hidden">
        <QueueSection defaultOpen={false}>
          <QueueSectionTrigger className="px-3 py-1.5 hover:bg-muted/40 transition-colors">
            <div className="flex items-center gap-2 min-w-0 w-full">
              {allDone ? (
                <span className="shrink-0 size-1.5 rounded-full bg-emerald-500" />
              ) : (
                <span className="shrink-0 size-1.5 rounded-full bg-amber-400 animate-pulse" />
              )}
              <span className="text-[11px] text-muted-foreground shrink-0 font-medium tabular-nums">
                {doneCount}/{total}
              </span>
              {activeItem && !allDone ? (
                <span className="text-[11px] text-foreground truncate min-w-0 flex-1">
                  {activeItem.label}
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground truncate min-w-0 flex-1">
                  {allDone ? 'All tasks complete' : 'Tasks'}
                </span>
              )}
              {activeItem && !allDone && (
                <span className="shrink-0 text-[10px] text-primary font-medium">
                  {statusLabel(activeItem.status)}
                </span>
              )}
            </div>
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList className="max-h-40">
              {items.map((item) => (
                <TodoRow key={item.id} item={item} />
              ))}
            </QueueList>
          </QueueSectionContent>
        </QueueSection>
      </Queue>
    </div>
  );
}
