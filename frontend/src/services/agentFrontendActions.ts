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
      case 'serial_monitor_open': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        sim.openSerialMonitor(boardId ?? undefined);
        return { ok: true, payload: { boardId, open: true } };
      }
      case 'serial_monitor_close': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        sim.closeSerialMonitor(boardId ?? undefined);
        return { ok: true, payload: { boardId, open: false } };
      }
      case 'serial_monitor_status': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        const status = sim.getSerialMonitorStatus(boardId ?? undefined);
        return { ok: true, payload: status };
      }
      case 'serial_set_baud_rate': {
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
      case 'serial_send': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        const text = typeof payload?.text === 'string' ? payload.text : '';
        const lineEnding = resolveLineEnding(payload?.lineEnding);
        const fullText = text + lineEnding;
        if (boardId) sim.serialWriteToBoard(boardId, fullText);
        else sim.serialWrite(fullText);
        return { ok: true, payload: { boardId, bytes: fullText.length } };
      }
      case 'serial_clear': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        if (boardId) sim.clearBoardSerialOutput(boardId);
        else sim.clearSerialOutput();
        return { ok: true, payload: { boardId } };
      }
      case 'serial_capture': {
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
      case 'sim_run': {
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
      case 'sim_pause': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        stopSimulationAction(boardId);
        return { ok: true, payload: { boardId, running: false } };
      }
      case 'sim_reset': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        resetSimulationAction(boardId);
        return { ok: true, payload: { boardId } };
      }
      case 'sim_status': {
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        const board = sim.boards.find((b) => b.id === boardId);
        return {
          ok: true,
          payload: {
            boardId,
            running: board?.running ?? false,
            compiledProgram: board?.compiledProgram ? true : false,
            serialMonitorOpen: board?.serialMonitorOpen ?? false,
          },
        };
      }
      case 'compile_last_result': {
        const logs = compilation.logs;
        const lastOutcome = logs.length > 0 ? logs[logs.length - 1] : null;
        return {
          ok: true,
          payload: {
            hasResult: logs.length > 0,
            logs: serializeLogs(logs.slice(-50)),
            lastMessage: lastOutcome?.message ?? null,
            lastType: lastOutcome?.type ?? null,
          },
        };
      }
      case 'get_component_bounds': {
        const componentId = typeof payload?.componentId === 'string' ? payload.componentId : null;
        if (!componentId) {
          return { ok: false, error: 'componentId is required' };
        }
        const el = document.querySelector(
          `[data-component-id="${componentId}"]`,
        ) as HTMLElement | null;
        if (!el) {
          // Fallback: try to find component in store and return position-based estimate
          const comp = sim.components.find((c) => c.id === componentId);
          if (comp) {
            return {
              ok: true,
              payload: {
                componentId,
                x: comp.x,
                y: comp.y,
                width: 60,
                height: 60,
                estimated: true,
                pinPositions: [],
              },
            };
          }
          return { ok: false, error: `Component not found on canvas: ${componentId}` };
        }
        const rect = el.getBoundingClientRect();
        // Attempt to read pin positions from the wokwi element inside
        const pinPositions: Array<{ name: string; x: number; y: number; side: string }> = [];
        const wokwiEl = el.querySelector('[pininfo]') ?? el.shadowRoot?.querySelector('[pininfo]');
        if (wokwiEl && 'pinInfo' in wokwiEl) {
          const pinInfo = (wokwiEl as any).pinInfo;
          if (Array.isArray(pinInfo)) {
            for (const pin of pinInfo) {
              const side =
                pin.x < rect.width * 0.25
                  ? 'left'
                  : pin.x > rect.width * 0.75
                    ? 'right'
                    : pin.y < rect.height * 0.25
                      ? 'top'
                      : 'bottom';
              pinPositions.push({ name: pin.name, x: pin.x, y: pin.y, side });
            }
          }
        }
        return {
          ok: true,
          payload: {
            componentId,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            estimated: false,
            pinPositions,
          },
        };
      }
      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Action failed' };
  }
}
