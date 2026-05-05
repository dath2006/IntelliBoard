import { useCompilationStore } from '../store/useCompilationStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { runCompileAction } from '../utils/compileActions';
import {
  runSimulationAction,
  stopSimulationAction,
  resetSimulationAction,
} from '../utils/simulatorActions';
import type { CompilationLog } from '../utils/compilationLogger';

export interface FrontendActionRequest {
  actionId: string;
  action: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number | null;
}

export interface FrontendActionResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}

const MAX_SERIAL_SNAPSHOT_LINES = 1000;

function serializeLogs(
  logs: CompilationLog[],
): Array<{ timestamp: string; type: string; message: string }> {
  return logs.map((log) => ({
    timestamp: log.timestamp.toISOString(),
    type: log.type,
    message: log.message,
  }));
}

function getBoardIdFromPayload(payload: Record<string, unknown> | undefined): string | null {
  const boardId = payload?.boardId;
  return typeof boardId === 'string' && boardId.trim().length > 0 ? boardId : null;
}

function resolveLineEnding(lineEnding: unknown): string {
  if (lineEnding === 'nl') return '\n';
  if (lineEnding === 'cr') return '\r';
  if (lineEnding === 'both') return '\r\n';
  return '';
}

export async function runFrontendAction(
  request: FrontendActionRequest,
): Promise<FrontendActionResult> {
  const { action, payload } = request;
  const sim = useSimulatorStore.getState();
  const compilation = useCompilationStore.getState();

  try {
    switch (action) {
      case 'serial.monitor.open': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        sim.openSerialMonitor(boardId ?? undefined);
        return { ok: true, payload: { boardId, open: true } };
      }
      case 'serial.monitor.close': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        sim.closeSerialMonitor(boardId ?? undefined);
        return { ok: true, payload: { boardId, open: false } };
      }
      case 'serial.monitor.status': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        const status = sim.getSerialMonitorStatus(boardId ?? undefined);
        return { ok: true, payload: status };
      }
      case 'serial.set_baud_rate': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        const baudRate = typeof payload?.baudRate === 'number' ? payload.baudRate : null;
        if (!baudRate || baudRate <= 0) {
          return { ok: false, error: 'Invalid baudRate' };
        }
        sim.setBoardSerialBaudRate(boardId ?? undefined, baudRate);
        return {
          ok: true,
          payload: {
            boardId,
            baudRate,
            warning: 'Display-only; firmware controls actual serial speed.',
          },
        };
      }
      case 'serial.send': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        const text = typeof payload?.text === 'string' ? payload.text : '';
        const lineEnding = resolveLineEnding(payload?.lineEnding);
        const fullText = text + lineEnding;
        if (boardId) sim.serialWriteToBoard(boardId, fullText);
        else sim.serialWrite(fullText);
        return { ok: true, payload: { boardId, bytes: fullText.length } };
      }
      case 'serial.clear': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        if (boardId) sim.clearBoardSerialOutput(boardId);
        else sim.clearSerialOutput();
        return { ok: true, payload: { boardId } };
      }
      case 'serial.capture': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        let maxLines = typeof payload?.maxLines === 'number' ? payload.maxLines : 200;
        if (!Number.isFinite(maxLines) || maxLines <= 0) maxLines = 200;
        maxLines = Math.min(maxLines, MAX_SERIAL_SNAPSHOT_LINES);
        const snapshot = sim.captureSerialSnapshot(boardId ?? undefined, maxLines);
        return { ok: true, payload: snapshot };
      }
      case 'compile': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        compilation.setConsoleOpen(true);
        const outcome = await runCompileAction({
          boardId,
          onLog: (log) => compilation.appendLog(log),
        });
        return {
          ok: outcome.ok,
          payload: {
            boardId: outcome.boardId,
            boardKind: outcome.boardKind,
            message: outcome.message,
            missingLibHint: outcome.missingLibHint,
            logs: serializeLogs(outcome.logs),
            result: outcome.result,
          },
          error: outcome.ok ? undefined : outcome.message?.text,
        };
      }
      case 'sim.run': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        const outcome = await runSimulationAction({
          boardId,
          onLog: (log) => compilation.appendLog(log),
          onCompilingChange: (compiling) => {
            if (compiling) compilation.setConsoleOpen(true);
          },
        });
        return {
          ok: outcome.ok,
          payload: { boardId: outcome.boardId, ran: outcome.ran, compiled: outcome.compiled },
          error: outcome.error,
        };
      }
      case 'sim.pause': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        stopSimulationAction(boardId);
        return { ok: true, payload: { boardId, running: false } };
      }
      case 'sim.reset': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        resetSimulationAction(boardId);
        return { ok: true, payload: { boardId } };
      }
      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Action failed' };
  }
}
