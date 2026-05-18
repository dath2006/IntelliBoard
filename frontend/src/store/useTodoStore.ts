import { create } from 'zustand';

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface AgentTodoItem {
  id: string;
  label: string;
  description?: string;
  status: TodoStatus;
}

interface SessionTodos {
  /** The run-id that created these todos — used to detect a new run on same session */
  runId: string | null;
  items: AgentTodoItem[];
}

interface TodoState {
  /** keyed by sessionId */
  todosBySession: Record<string, SessionTodos>;

  /**
   * Called when agent emits todo.created.
   * Replaces any existing todos for this session+run (agent called create_todo again
   * meaning it started a new task within the same run, e.g. after plan was changed).
   */
  setTodos: (sessionId: string, runId: string, items: AgentTodoItem[]) => void;

  /**
   * Called when agent emits todo.updated.
   * No-op if the todo id doesn't exist (handles out-of-order / stale events).
   */
  updateTodo: (sessionId: string, id: string, status: TodoStatus) => void;

  /**
   * Called on run.started — clears todos for this session so a new run starts fresh.
   * Handles: user stops agent mid-run and starts a new task.
   */
  clearTodos: (sessionId: string) => void;

  /**
   * Called on run.completed / run.failed / run.cancelled / run.stopped.
   * Any item still in_progress or pending → skipped.
   * This prevents the spinner being stuck forever if the agent stopped early.
   * Has no effect if all items are already done/skipped.
   */
  freezeTodos: (sessionId: string) => void;

  /** Convenience: get todos for a session or empty array */
  getTodos: (sessionId: string) => AgentTodoItem[];
}

export const useTodoStore = create<TodoState>((set, get) => ({
  todosBySession: {},

  setTodos: (sessionId, runId, items) =>
    set((state) => ({
      todosBySession: {
        ...state.todosBySession,
        [sessionId]: { runId, items },
      },
    })),

  updateTodo: (sessionId, id, status) =>
    set((state) => {
      const session = state.todosBySession[sessionId];
      if (!session) return state;
      const items = session.items.map((t) => (t.id === id ? { ...t, status } : t));
      return {
        todosBySession: {
          ...state.todosBySession,
          [sessionId]: { ...session, items },
        },
      };
    }),

  freezeTodos: (sessionId) =>
    set((state) => {
      const session = state.todosBySession[sessionId];
      if (!session) return state;
      const hasStuck = session.items.some(
        (t) => t.status === 'in_progress' || t.status === 'pending',
      );
      if (!hasStuck) return state;
      const items = session.items.map((t) =>
        t.status === 'in_progress' || t.status === 'pending'
          ? { ...t, status: 'skipped' as TodoStatus }
          : t,
      );
      return {
        todosBySession: {
          ...state.todosBySession,
          [sessionId]: { ...session, items },
        },
      };
    }),

  clearTodos: (sessionId) =>
    set((state) => {
      const current = state.todosBySession[sessionId];
      if (!current) return state;
      return {
        todosBySession: {
          ...state.todosBySession,
          [sessionId]: { runId: null, items: [] },
        },
      };
    }),

  getTodos: (sessionId) => get().todosBySession[sessionId]?.items ?? [],
}));
