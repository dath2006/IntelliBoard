import { create } from 'zustand';
import type { CompilationLog } from '../utils/compilationLogger';

interface CompilationState {
  consoleOpen: boolean;
  logs: CompilationLog[];
  setConsoleOpen: (open: boolean) => void;
  setLogs: (logs: CompilationLog[]) => void;
  appendLog: (log: CompilationLog) => void;
  appendLogs: (logs: CompilationLog[]) => void;
  clearLogs: () => void;
}

export const useCompilationStore = create<CompilationState>((set) => ({
  consoleOpen: false,
  logs: [],
  setConsoleOpen: (consoleOpen) => set({ consoleOpen }),
  setLogs: (logs) => set({ logs }),
  appendLog: (log) => set((state) => ({ logs: [...state.logs, log] })),
  appendLogs: (logs) =>
    set((state) => ({ logs: logs.length > 0 ? [...state.logs, ...logs] : state.logs })),
  clearLogs: () => set({ logs: [] }),
}));
