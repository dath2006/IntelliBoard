import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useProjectStore } from '../store/useProjectStore';
import { compileCode, type CompileResult } from '../services/compilation';
import { parseCompileResult, type CompilationLog } from './compilationLogger';
import { BOARD_KIND_FQBN, BOARD_KIND_LABELS } from '../types/board';
import { trackCompileCode } from './analytics';

export type CompileMessage = { type: 'success' | 'error'; text: string };

export interface CompileActionOptions {
  boardId?: string | null;
  onLog?: (log: CompilationLog) => void;
}

export interface CompileActionOutcome {
  ok: boolean;
  result: CompileResult | null;
  logs: CompilationLog[];
  message: CompileMessage | null;
  missingLibHint: boolean;
  boardId: string | null;
  boardKind: string | null;
}

function appendLogs(logs: CompilationLog[], onLog?: (log: CompilationLog) => void) {
  if (!onLog) return;
  for (const log of logs) onLog(log);
}

export async function runCompileAction(
  options: CompileActionOptions = {},
): Promise<CompileActionOutcome> {
  const { boardId: requestedBoardId, onLog } = options;
  const editorState = useEditorStore.getState();
  const simState = useSimulatorStore.getState();
  const project = useProjectStore.getState().currentProject;

  const boardId = requestedBoardId ?? simState.activeBoardId ?? null;
  const board = boardId ? simState.boards.find((b) => b.id === boardId) : null;
  const logs: CompilationLog[] = [];

  if (!boardId || !board) {
    const msg = 'No board selected';
    const log: CompilationLog = { timestamp: new Date(), type: 'error', message: msg };
    logs.push(log);
    appendLogs([log], onLog);
    return {
      ok: false,
      result: null,
      logs,
      message: { type: 'error', text: msg },
      missingLibHint: false,
      boardId: boardId,
      boardKind: null,
    };
  }

  trackCompileCode();

  if (board.boardKind === 'raspberry-pi-3') {
    const msg = 'Raspberry Pi 3B: no compilation needed — run Python scripts directly.';
    const log: CompilationLog = { timestamp: new Date(), type: 'info', message: msg };
    logs.push(log);
    appendLogs([log], onLog);
    return {
      ok: true,
      result: null,
      logs,
      message: { type: 'success', text: 'Ready (no compilation needed)' },
      missingLibHint: false,
      boardId,
      boardKind: board.boardKind,
    };
  }

  if (board.languageMode === 'micropython') {
    const startLog: CompilationLog = {
      timestamp: new Date(),
      type: 'info',
      message: 'MicroPython: loading firmware and user files...',
    };
    logs.push(startLog);
    appendLogs([startLog], onLog);
    try {
      const groupFiles = editorState.getGroupFiles(board.activeFileGroupId);
      const pyFiles = groupFiles.map((f) => ({ name: f.name, content: f.content }));
      await simState.loadMicroPythonProgram(boardId, pyFiles);
      const okLog: CompilationLog = {
        timestamp: new Date(),
        type: 'success',
        message: 'MicroPython firmware loaded successfully',
      };
      logs.push(okLog);
      appendLogs([okLog], onLog);
      return {
        ok: true,
        result: null,
        logs,
        message: { type: 'success', text: 'MicroPython ready' },
        missingLibHint: false,
        boardId,
        boardKind: board.boardKind,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to load MicroPython';
      const errLog: CompilationLog = { timestamp: new Date(), type: 'error', message: errMsg };
      logs.push(errLog);
      appendLogs([errLog], onLog);
      return {
        ok: false,
        result: null,
        logs,
        message: { type: 'error', text: errMsg },
        missingLibHint: false,
        boardId,
        boardKind: board.boardKind,
      };
    }
  }

  const fqbn = BOARD_KIND_FQBN[board.boardKind];
  const boardLabel = BOARD_KIND_LABELS[board.boardKind] ?? board.boardKind;
  if (!fqbn) {
    const msg = `No FQBN for board kind: ${board.boardKind}`;
    const log: CompilationLog = { timestamp: new Date(), type: 'error', message: msg };
    logs.push(log);
    appendLogs([log], onLog);
    return {
      ok: false,
      result: null,
      logs,
      message: { type: 'error', text: 'Unknown board' },
      missingLibHint: false,
      boardId,
      boardKind: board.boardKind,
    };
  }

  const startLog: CompilationLog = {
    timestamp: new Date(),
    type: 'info',
    message: `Starting compilation for ${boardLabel} (${fqbn})...`,
  };
  logs.push(startLog);
  appendLogs([startLog], onLog);

  try {
    const groupFiles = board.activeFileGroupId
      ? editorState.getGroupFiles(board.activeFileGroupId)
      : editorState.files;
    const sketchFiles = (groupFiles.length > 0 ? groupFiles : editorState.files).map((f) => ({
      name: f.name,
      content: f.content,
    }));
    const result = await compileCode(sketchFiles, fqbn, project?.id ?? null);
    const parsed = parseCompileResult(result, boardLabel);
    logs.push(...parsed);
    appendLogs(parsed, onLog);

    if (result.success) {
      const program = result.hex_content ?? result.binary_content ?? null;
      if (program) {
        simState.compileBoardProgram(boardId, program);
        if (result.has_wifi !== undefined) {
          simState.updateBoard(boardId, { hasWifi: result.has_wifi });
        }
      }
      editorState.markCompiled();
      return {
        ok: true,
        result,
        logs,
        message: { type: 'success', text: 'Compiled successfully' },
        missingLibHint: false,
        boardId,
        boardKind: board.boardKind,
      };
    }

    const errText = result.error || result.stderr || 'Compile failed';
    const missingLibHint = /No such file or directory|fatal error:.*\.h|library not found/i.test(
      errText,
    );
    return {
      ok: false,
      result,
      logs,
      message: { type: 'error', text: errText },
      missingLibHint,
      boardId,
      boardKind: board.boardKind,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Compile failed';
    const errLog: CompilationLog = { timestamp: new Date(), type: 'error', message: errMsg };
    logs.push(errLog);
    appendLogs([errLog], onLog);
    return {
      ok: false,
      result: null,
      logs,
      message: { type: 'error', text: errMsg },
      missingLibHint: false,
      boardId,
      boardKind: board.boardKind,
    };
  }
}
