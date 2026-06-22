import { useCompilationStore } from '../store/useCompilationStore';
import { useSimulatorStore, getBoardBridge } from '../store/useSimulatorStore';
import { useVfsStore } from '../store/useVfsStore';
import { usePlanApprovalStore } from '../store/usePlanApprovalStore';
import type { PlanStep } from '../store/usePlanApprovalStore';
import { runCompileAction } from '../utils/compileActions';
import {
  runSimulationAction,
  stopSimulationAction,
  resetSimulationAction,
} from '../utils/simulatorActions';
import type { CompilationLog } from '../utils/compilationLogger';
import {
  suggestPlacements,
  autoRouteWires,
  getCanvasSpatialContext,
} from '../utils/canvasLayoutEngine';
import type {
  PlacementRequest,
  WireInfo,
  BoardInfo,
  ComponentInfo,
} from '../utils/canvasLayoutEngine';

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

const MAX_SERIAL_SNAPSHOT_LINES = 500;
const MAX_COMPILE_LOG_LINES = 200;

function serializeLogs(
  logs: CompilationLog[],
  maxLines: number | null = null,
): Array<{ timestamp: string; type: string; message: string }> {
  const slice = maxLines ? logs.slice(-maxLines) : logs;
  return slice.map((log) => ({
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
        const totalLogs = outcome.logs.length;
        
        // If compilation is successful, we don't need compilation logs in the prompt context.
        // If it failed, limit the logs to the last 40 lines to prevent token bloat.
        const maxLines = outcome.ok ? 0 : 40;
        const logs = serializeLogs(outcome.logs, maxLines);
        
        let messageText = outcome.message?.text ?? '';
        if (messageText.length > 1500) {
          messageText = messageText.slice(0, 1500) + '\n... [truncated for token safety]';
        }
        
        return {
          ok: outcome.ok,
          payload: {
            boardId: outcome.boardId,
            boardKind: outcome.boardKind,
            message: outcome.message ? { ...outcome.message, text: messageText } : null,
            missingLibHint: outcome.missingLibHint,
            logs,
            totalLogs,
            logsTruncated: totalLogs > maxLines,
            maxLogs: maxLines,
          },
          error: outcome.ok ? undefined : messageText,
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
        let lastMessage = lastOutcome?.message ?? null;
        if (lastMessage && lastMessage.text.length > 1500) {
          lastMessage = {
            ...lastMessage,
            text: lastMessage.text.slice(0, 1500) + '\n... [truncated for token safety]',
          };
        }
        return {
          ok: true,
          payload: {
            hasResult: logs.length > 0,
            logs: serializeLogs(logs.slice(-50)),
            lastMessage,
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
      case 'plan.approval': {
        const title = typeof payload?.title === 'string' ? payload.title : 'Execution plan';
        const description = typeof payload?.description === 'string' ? payload.description : '';
        const rawSteps = Array.isArray(payload?.steps) ? payload.steps : [];
        const steps: PlanStep[] = rawSteps.map((s: unknown) => ({
          label:
            typeof (s as Record<string, unknown>)?.label === 'string'
              ? ((s as Record<string, unknown>).label as string)
              : '',
          description:
            typeof (s as Record<string, unknown>)?.description === 'string'
              ? ((s as Record<string, unknown>).description as string)
              : '',
        }));
        return new Promise<FrontendActionResult>((resolve) => {
          usePlanApprovalStore.getState().setPending({
            actionId: request.actionId,
            sessionId: '',
            title,
            description,
            steps,
            resolve,
          });
        });
      }
      case 'suggest_placement': {
        const rawRequests = Array.isArray(payload?.requests) ? payload.requests : [];
        if (rawRequests.length === 0) {
          return { ok: false, error: 'requests array is required and must not be empty' };
        }
        const requests: PlacementRequest[] = rawRequests.map((r: unknown) => {
          const req = r as Record<string, unknown>;
          return {
            id: typeof req.id === 'string' ? req.id : '',
            metadataId: typeof req.metadataId === 'string' ? req.metadataId : '',
            connectsToBoardPin:
              typeof req.connectsToBoardPin === 'string' ? req.connectsToBoardPin : undefined,
            preferSide:
              typeof req.preferSide === 'string'
                ? (req.preferSide as PlacementRequest['preferSide'])
                : undefined,
          };
        });
        const boards: BoardInfo[] = sim.boards.map((b) => ({
          id: b.id,
          boardKind: b.boardKind,
          x: b.x,
          y: b.y,
        }));
        const components: ComponentInfo[] = sim.components.map((c) => ({
          id: c.id,
          metadataId: c.metadataId,
          x: c.x,
          y: c.y,
        }));
        const placements = suggestPlacements(requests, boards, components);
        return { ok: true, payload: { placements } };
      }
      case 'auto_route_wires': {
        const rawWireIds = Array.isArray(payload?.wireIds) ? (payload.wireIds as string[]) : null;
        const allWires: WireInfo[] = sim.wires.map((w) => ({
          id: w.id,
          start: {
            componentId: w.start.componentId,
            pinName: w.start.pinName,
            x: w.start.x,
            y: w.start.y,
          },
          end: { componentId: w.end.componentId, pinName: w.end.pinName, x: w.end.x, y: w.end.y },
          waypoints: (w.waypoints ?? []).map((wp: { x: number; y: number }) => ({
            x: wp.x,
            y: wp.y,
          })),
        }));
        const wiresToRoute = rawWireIds
          ? allWires.filter((w) => rawWireIds.includes(w.id))
          : allWires;
        if (wiresToRoute.length === 0) {
          return { ok: true, payload: { routes: [], message: 'No wires to route' } };
        }
        const boards: BoardInfo[] = sim.boards.map((b) => ({
          id: b.id,
          boardKind: b.boardKind,
          x: b.x,
          y: b.y,
        }));
        const components: ComponentInfo[] = sim.components.map((c) => ({
          id: c.id,
          metadataId: c.metadataId,
          x: c.x,
          y: c.y,
        }));
        const routes = autoRouteWires(wiresToRoute, components, boards);
        return { ok: true, payload: { routes } };
      }
      case 'get_canvas_spatial_context': {
        const boards: BoardInfo[] = sim.boards.map((b) => ({
          id: b.id,
          boardKind: b.boardKind,
          x: b.x,
          y: b.y,
        }));
        const components: ComponentInfo[] = sim.components.map((c) => ({
          id: c.id,
          metadataId: c.metadataId,
          x: c.x,
          y: c.y,
        }));
        const context = getCanvasSpatialContext(components, boards);
        return { ok: true, payload: context };
      }
      // ── Raspberry Pi VFS / serial actions ─────────────────────────────────
      case 'pi_write_file': {
        // Write (or create) a file in the Pi VFS.
        // payload: { boardId, filePath, content }
        // filePath is an absolute Unix path, e.g. '/home/pi/main.py'
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        const filePath = typeof payload?.filePath === 'string' ? payload.filePath : null;
        const content = typeof payload?.content === 'string' ? payload.content : '';
        if (!boardId) return { ok: false, error: 'boardId is required' };
        if (!filePath) return { ok: false, error: 'filePath is required' };

        const vfs = useVfsStore.getState();
        vfs.initBoardVfs(boardId);

        // Resolve file path: split into directory segments + filename
        const parts = filePath.replace(/^\/+/, '').split('/');
        const fileName = parts.pop() ?? '';
        if (!fileName) return { ok: false, error: 'filePath must end with a filename' };

        // Walk (or create) directory nodes
        let currentId = vfs.getRootId(boardId);
        if (!currentId) return { ok: false, error: 'VFS not initialized for board' };

        for (const seg of parts) {
          if (!seg) continue;
          const tree = vfs.getTree(boardId);
          const parentNode = tree[currentId];
          const existingChild = (parentNode?.children ?? []).find(
            (cid) => tree[cid]?.name === seg && tree[cid]?.type === 'directory',
          );
          if (existingChild) {
            currentId = existingChild;
          } else {
            const newDirId = vfs.createNode(boardId, currentId, seg, 'directory');
            if (!newDirId) return { ok: false, error: `Could not create directory: ${seg}` };
            currentId = newDirId;
          }
        }

        // Create or update the file
        const tree = vfs.getTree(boardId);
        const parentNode = tree[currentId];
        const existingFile = (parentNode?.children ?? []).find(
          (cid) => tree[cid]?.name === fileName && tree[cid]?.type === 'file',
        );
        if (existingFile) {
          vfs.setContent(boardId, existingFile, content);
          return { ok: true, payload: { boardId, filePath, nodeId: existingFile, created: false } };
        } else {
          const newFileId = vfs.createNode(boardId, currentId, fileName, 'file');
          if (!newFileId) return { ok: false, error: `Could not create file: ${fileName}` };
          vfs.setContent(boardId, newFileId, content);
          return { ok: true, payload: { boardId, filePath, nodeId: newFileId, created: true } };
        }
      }

      case 'pi_upload_files': {
        // Upload all VFS files to the running Pi via serial heredoc protocol.
        // payload: { boardId }
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        if (!boardId) return { ok: false, error: 'boardId is required' };

        const bridge = getBoardBridge(boardId);
        if (!bridge || !(bridge as any).connected) {
          return { ok: false, error: 'Pi is not connected. Start the simulation and wait for boot first.' };
        }

        const vfs = useVfsStore.getState();
        const files = vfs.serializeForUpload(boardId);
        if (files.length === 0) {
          return { ok: true, payload: { boardId, filesUploaded: 0 } };
        }

        const enc = new TextEncoder();
        const send = (text: string) =>
          (bridge as any).sendSerialBytes(Array.from(enc.encode(text)));

        // Ensure shell has a clean prompt and rootfs is writable
        send('\n');
        await new Promise((r) => setTimeout(r, 200));
        send('mount -o remount,rw / 2>/dev/null; true\n');
        await new Promise((r) => setTimeout(r, 400));

        for (const { path, content } of files) {
          const dir = path.substring(0, path.lastIndexOf('/'));
          if (dir) {
            send(`mkdir -p ${dir}\n`);
            await new Promise((r) => setTimeout(r, 150));
          }
          const delim = `VIST_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
          const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          send(`cat > ${path} << '${delim}'\n${normalized}\n${delim}\n`);
          await new Promise((r) => setTimeout(r, 400));
          if (path.endsWith('.py') || path.endsWith('.sh')) {
            send(`chmod +x ${path}\n`);
            await new Promise((r) => setTimeout(r, 100));
          }
        }

        return { ok: true, payload: { boardId, filesUploaded: files.length } };
      }

      case 'pi_run_command': {
        // Send a shell command to the Pi's serial terminal (ttyAMA0).
        // payload: { boardId, command }
        const boardId = getBoardIdFromPayload(payload) ?? sim.activeBoardId;
        const command = typeof payload?.command === 'string' ? payload.command : null;
        if (!boardId) return { ok: false, error: 'boardId is required' };
        if (!command) return { ok: false, error: 'command is required' };

        const bridge = getBoardBridge(boardId);
        if (!bridge || !(bridge as any).connected) {
          return { ok: false, error: 'Pi is not connected. Start the simulation and wait for boot first.' };
        }

        const enc = new TextEncoder();
        const bytes = Array.from(enc.encode(command.endsWith('\n') ? command : command + '\n'));
        (bridge as any).sendSerialBytes(bytes);
        return { ok: true, payload: { boardId, command, bytesSent: bytes.length } };
      }

      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Action failed' };
  }
}
