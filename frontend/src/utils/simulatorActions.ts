import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useProjectStore } from '../store/useProjectStore';
import { reportRunEvent } from '../services/metricsService';
import { BOARD_KIND_FQBN } from '../types/board';
import { isEsp32BoardKind } from './boardResolver';
import { trackResetSimulation, trackRunSimulation, trackStopSimulation } from './analytics';
import { runCompileAction, type CompileActionOutcome } from './compileActions';
import type { CompilationLog } from './compilationLogger';

export interface RunSimulationOptions {
  boardId?: string | null;
  onLog?: (log: CompilationLog) => void;
  onCompilingChange?: (compiling: boolean) => void;
}

export interface RunSimulationOutcome {
  ok: boolean;
  boardId: string | null;
  compiled: boolean;
  ran: boolean;
  compileOutcome?: CompileActionOutcome | null;
  error?: string;
}

async function reportRun(boardKind: string | undefined): Promise<void> {
  const project = useProjectStore.getState().currentProject;
  const fqbn = boardKind ? BOARD_KIND_FQBN[boardKind] : null;
  await reportRunEvent({
    project_id: project?.id ?? null,
    board_fqbn: fqbn ?? null,
  });
}

export async function runSimulationAction(
  options: RunSimulationOptions = {},
): Promise<RunSimulationOutcome> {
  const { boardId: requestedBoardId, onLog, onCompilingChange } = options;
  const sim = useSimulatorStore.getState();
  const editor = useEditorStore.getState();
  const boardId = requestedBoardId ?? sim.activeBoardId ?? null;
  const board = boardId ? sim.boards.find((b) => b.id === boardId) : null;

  if (!boardId || !board) {
    return { ok: false, boardId, compiled: false, ran: false, error: 'No board selected' };
  }

  // MicroPython mode: reload firmware + start
  if (board.languageMode === 'micropython') {
    trackRunSimulation(board.boardKind);
    await reportRun(board.boardKind);

    if (board.running) {
      sim.stopBoard(boardId);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    onCompilingChange?.(true);
    const compileOutcome = await runCompileAction({ boardId, onLog });
    onCompilingChange?.(false);

    if (!compileOutcome.ok) {
      return {
        ok: false,
        boardId,
        compiled: false,
        ran: false,
        compileOutcome,
        error: compileOutcome.message?.text ?? 'MicroPython load failed',
      };
    }

    sim.startBoard(boardId);
    return { ok: true, boardId, compiled: true, ran: true, compileOutcome };
  }

  const isQemuBoard =
    board.boardKind === 'raspberry-pi-3' ||
    (board.boardKind ? isEsp32BoardKind(board.boardKind) : false);
  const needsCompile = !board.compiledProgram || editor.codeChangedSinceLastCompile;
  let compiled = false;

  if (needsCompile) {
    onCompilingChange?.(true);
    const compileOutcome = await runCompileAction({ boardId, onLog });
    onCompilingChange?.(false);
    compiled = compileOutcome.ok;

    const updatedBoard = useSimulatorStore.getState().boards.find((b) => b.id === boardId);
    const hasProgram = Boolean(updatedBoard?.compiledProgram) || isQemuBoard;
    if (!compileOutcome.ok || !hasProgram) {
      return {
        ok: false,
        boardId,
        compiled: compileOutcome.ok,
        ran: false,
        compileOutcome,
        error: compileOutcome.message?.text ?? 'Compilation failed',
      };
    }
  }

  trackRunSimulation(board.boardKind);
  await reportRun(board.boardKind);
  sim.startBoard(boardId);
  return { ok: true, boardId, compiled: compiled || !needsCompile, ran: true };
}

export function stopSimulationAction(boardId?: string | null): void {
  trackStopSimulation();
  const sim = useSimulatorStore.getState();
  const targetId = boardId ?? sim.activeBoardId ?? null;
  if (targetId) sim.stopBoard(targetId);
  else sim.stopSimulation();
}

export function resetSimulationAction(boardId?: string | null): void {
  trackResetSimulation();
  const sim = useSimulatorStore.getState();
  const targetId = boardId ?? sim.activeBoardId ?? null;
  if (targetId) sim.resetBoard(targetId);
  else sim.resetSimulation();
}
