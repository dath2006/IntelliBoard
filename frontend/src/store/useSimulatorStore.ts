import { create } from 'zustand';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { RP2040Simulator } from '../simulation/RP2040Simulator';
import { PinManager } from '../simulation/PinManager';
import { VirtualDS1307, VirtualTempSensor, I2CMemoryDevice } from '../simulation/I2CBusManager';
import type { RP2040I2CDevice } from '../simulation/RP2040Simulator';
import type { Wire, WireInProgress, WireEndpoint } from '../types/wire';
import type { BoardKind, BoardInstance } from '../types/board';
import { calculatePinPosition } from '../utils/pinPositionCalculator';
import { useOscilloscopeStore } from './useOscilloscopeStore';
import { RaspberryPi3Bridge } from '../simulation/RaspberryPi3Bridge';

// ── Legacy type aliases (keep external consumers working) ──────────────────
export type BoardType = 'arduino-uno' | 'arduino-nano' | 'arduino-mega' | 'raspberry-pi-pico';

export const BOARD_FQBN: Record<BoardType, string> = {
  'arduino-uno': 'arduino:avr:uno',
  'arduino-nano': 'arduino:avr:nano:cpu=atmega328',
  'arduino-mega': 'arduino:avr:mega',
  'raspberry-pi-pico': 'rp2040:rp2040:rpipico',
};

export const BOARD_LABELS: Record<BoardType, string> = {
  'arduino-uno': 'Arduino Uno',
  'arduino-nano': 'Arduino Nano',
  'arduino-mega': 'Arduino Mega 2560',
  'raspberry-pi-pico': 'Raspberry Pi Pico',
};

export const DEFAULT_BOARD_POSITION = { x: 50, y: 50 };
export const ARDUINO_POSITION = DEFAULT_BOARD_POSITION;

// ── Runtime Maps (outside Zustand — not serialisable) ─────────────────────
const simulatorMap = new Map<string, AVRSimulator | RP2040Simulator>();
const pinManagerMap = new Map<string, PinManager>();
const bridgeMap = new Map<string, RaspberryPi3Bridge>();

export const getBoardSimulator = (id: string) => simulatorMap.get(id);
export const getBoardPinManager = (id: string) => pinManagerMap.get(id);
export const getBoardBridge = (id: string) => bridgeMap.get(id);

// ── Component type ────────────────────────────────────────────────────────
interface Component {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, unknown>;
}

// ── Store interface ───────────────────────────────────────────────────────
interface SimulatorState {
  // ── Multi-board state ───────────────────────────────────────────────────
  boards: BoardInstance[];
  activeBoardId: string | null;

  addBoard: (boardKind: BoardKind, x: number, y: number) => string;
  removeBoard: (boardId: string) => void;
  updateBoard: (boardId: string, updates: Partial<BoardInstance>) => void;
  setBoardPosition: (pos: { x: number; y: number }, boardId?: string) => void;
  setActiveBoardId: (boardId: string) => void;
  compileBoardProgram: (boardId: string, program: string) => void;
  startBoard: (boardId: string) => void;
  stopBoard: (boardId: string) => void;
  resetBoard: (boardId: string) => void;

  // ── Legacy single-board API (reads/writes activeBoardId board) ───────────
  /** @deprecated use boards[]/activeBoardId directly */
  boardType: BoardType;
  /** @deprecated use boards[x].x/y */
  boardPosition: { x: number; y: number };
  /** @deprecated use getBoardSimulator(activeBoardId) */
  simulator: AVRSimulator | RP2040Simulator | null;
  /** @deprecated use getBoardPinManager(activeBoardId) */
  pinManager: PinManager;
  running: boolean;
  compiledHex: string | null;
  hexEpoch: number;
  serialOutput: string;
  serialBaudRate: number;
  serialMonitorOpen: boolean;
  /** @deprecated use getBoardBridge(activeBoardId) */
  remoteConnected: boolean;
  remoteSocket: WebSocket | null;

  setBoardType: (type: BoardType) => void;
  initSimulator: () => void;
  loadHex: (hex: string) => void;
  loadBinary: (base64: string) => void;
  startSimulation: () => void;
  stopSimulation: () => void;
  resetSimulation: () => void;
  setCompiledHex: (hex: string) => void;
  setCompiledBinary: (base64: string) => void;
  setRunning: (running: boolean) => void;
  connectRemoteSimulator: (clientId: string) => void;
  disconnectRemoteSimulator: () => void;
  sendRemotePinEvent: (pin: string, state: number) => void;

  // ── Components ──────────────────────────────────────────────────────────
  components: Component[];
  addComponent: (component: Component) => void;
  removeComponent: (id: string) => void;
  updateComponent: (id: string, updates: Partial<Component>) => void;
  updateComponentState: (id: string, state: boolean) => void;
  handleComponentEvent: (componentId: string, eventName: string, data?: unknown) => void;
  setComponents: (components: Component[]) => void;

  // ── Wires ───────────────────────────────────────────────────────────────
  wires: Wire[];
  selectedWireId: string | null;
  wireInProgress: WireInProgress | null;
  addWire: (wire: Wire) => void;
  removeWire: (wireId: string) => void;
  updateWire: (wireId: string, updates: Partial<Wire>) => void;
  setSelectedWire: (wireId: string | null) => void;
  setWires: (wires: Wire[]) => void;
  startWireCreation: (endpoint: WireEndpoint) => void;
  updateWireInProgress: (x: number, y: number) => void;
  finishWireCreation: (endpoint: WireEndpoint) => void;
  cancelWireCreation: () => void;
  updateWirePositions: (componentId: string) => void;
  recalculateAllWirePositions: () => void;

  // ── Serial monitor ──────────────────────────────────────────────────────
  toggleSerialMonitor: () => void;
  serialWrite: (text: string) => void;
  clearSerialOutput: () => void;
}

// ── Helper: create a simulator for a given board kind ─────────────────────
function createSimulator(
  boardKind: BoardKind,
  pm: PinManager,
  onSerial: (ch: string) => void,
  onBaud: (baud: number) => void,
  onPinTime: (pin: number, state: boolean, t: number) => void,
): AVRSimulator | RP2040Simulator {
  let sim: AVRSimulator | RP2040Simulator;
  if (boardKind === 'arduino-mega') {
    sim = new AVRSimulator(pm, 'mega');
  } else if (boardKind === 'raspberry-pi-pico') {
    sim = new RP2040Simulator(pm);
  } else {
    // arduino-uno, arduino-nano
    sim = new AVRSimulator(pm, 'uno');
  }
  sim.onSerialData = onSerial;
  if (sim instanceof AVRSimulator) sim.onBaudRateChange = onBaud;
  sim.onPinChangeWithTime = onPinTime;
  return sim;
}

// ── Default initial board (Arduino Uno — same as old behaviour) ───────────
const INITIAL_BOARD_ID = 'arduino-uno';
const INITIAL_BOARD: BoardInstance = {
  id: INITIAL_BOARD_ID,
  boardKind: 'arduino-uno',
  x: DEFAULT_BOARD_POSITION.x,
  y: DEFAULT_BOARD_POSITION.y,
  running: false,
  compiledProgram: null,
  serialOutput: '',
  serialBaudRate: 0,
  serialMonitorOpen: false,
  activeFileGroupId: `group-${INITIAL_BOARD_ID}`,
};

// ── Store ─────────────────────────────────────────────────────────────────
export const useSimulatorStore = create<SimulatorState>((set, get) => {
  // Initialise runtime objects for the default board
  const initialPm = new PinManager();
  pinManagerMap.set(INITIAL_BOARD_ID, initialPm);

  function getOscilloscopeCallback() {
    return (pin: number, state: boolean, timeMs: number) => {
      const { channels, pushSample } = useOscilloscopeStore.getState();
      for (const ch of channels) {
        if (ch.pin === pin) pushSample(ch.id, timeMs, state);
      }
    };
  }

  const initialSim = createSimulator(
    'arduino-uno',
    initialPm,
    (ch) => {
      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === INITIAL_BOARD_ID ? { ...b, serialOutput: b.serialOutput + ch } : b
        );
        const isActive = s.activeBoardId === INITIAL_BOARD_ID;
        return { boards, ...(isActive ? { serialOutput: s.serialOutput + ch } : {}) };
      });
    },
    (baud) => {
      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === INITIAL_BOARD_ID ? { ...b, serialBaudRate: baud } : b
        );
        const isActive = s.activeBoardId === INITIAL_BOARD_ID;
        return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
      });
    },
    getOscilloscopeCallback(),
  );
  simulatorMap.set(INITIAL_BOARD_ID, initialSim);

  // ── Legacy single-board PinManager (references initial board's pm) ───────
  const legacyPinManager = initialPm;

  return {
    // ── Multi-board state ─────────────────────────────────────────────────
    boards: [INITIAL_BOARD],
    activeBoardId: INITIAL_BOARD_ID,

    addBoard: (boardKind: BoardKind, x: number, y: number) => {
      const existing = get().boards.filter((b) => b.boardKind === boardKind);
      const id = existing.length === 0
        ? boardKind
        : `${boardKind}-${existing.length + 1}`;

      const pm = new PinManager();
      pinManagerMap.set(id, pm);

      if (boardKind !== 'raspberry-pi-3') {
        const sim = createSimulator(
          boardKind,
          pm,
          (ch) => {
            set((s) => {
              const boards = s.boards.map((b) =>
                b.id === id ? { ...b, serialOutput: b.serialOutput + ch } : b
              );
              const isActive = s.activeBoardId === id;
              return { boards, ...(isActive ? { serialOutput: s.serialOutput + ch } : {}) };
            });
          },
          (baud) => {
            set((s) => {
              const boards = s.boards.map((b) =>
                b.id === id ? { ...b, serialBaudRate: baud } : b
              );
              const isActive = s.activeBoardId === id;
              return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
            });
          },
          getOscilloscopeCallback(),
        );
        simulatorMap.set(id, sim);
      } else {
        const bridge = new RaspberryPi3Bridge(id);
        bridge.onSerialData = (ch) => {
          set((s) => {
            const boards = s.boards.map((b) =>
              b.id === id ? { ...b, serialOutput: b.serialOutput + ch } : b
            );
            const isActive = s.activeBoardId === id;
            return { boards, ...(isActive ? { serialOutput: s.serialOutput + ch } : {}) };
          });
        };
        bridge.onPinChange = (_gpioPin, _state) => {
          // Cross-board routing handled in SimulatorCanvas
        };
        bridgeMap.set(id, bridge);
      }

      const newBoard: BoardInstance = {
        id, boardKind, x, y,
        running: false, compiledProgram: null,
        serialOutput: '', serialBaudRate: 0,
        serialMonitorOpen: false,
        activeFileGroupId: `group-${id}`,
      };

      set((s) => ({ boards: [...s.boards, newBoard] }));
      return id;
    },

    removeBoard: (boardId: string) => {
      getBoardSimulator(boardId)?.stop();
      simulatorMap.delete(boardId);
      pinManagerMap.delete(boardId);
      const bridge = getBoardBridge(boardId);
      if (bridge) { bridge.disconnect(); bridgeMap.delete(boardId); }
      set((s) => {
        const boards = s.boards.filter((b) => b.id !== boardId);
        const activeBoardId = s.activeBoardId === boardId
          ? (boards[0]?.id ?? null)
          : s.activeBoardId;
        return { boards, activeBoardId };
      });
    },

    updateBoard: (boardId: string, updates: Partial<BoardInstance>) => {
      set((s) => ({
        boards: s.boards.map((b) => b.id === boardId ? { ...b, ...updates } : b),
      }));
    },

    setBoardPosition: (pos: { x: number; y: number }, boardId?: string) => {
      const id = boardId ?? get().activeBoardId ?? INITIAL_BOARD_ID;
      set((s) => ({
        boardPosition: s.activeBoardId === id ? pos : s.boardPosition,
        boards: s.boards.map((b) => b.id === id ? { ...b, x: pos.x, y: pos.y } : b),
      }));
    },

    setActiveBoardId: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;
      set({
        activeBoardId: boardId,
        // Sync legacy flat fields to this board's values
        boardType: (board.boardKind === 'raspberry-pi-3' ? 'arduino-uno' : board.boardKind) as BoardType,
        boardPosition: { x: board.x, y: board.y },
        simulator: simulatorMap.get(boardId) ?? null,
        pinManager: pinManagerMap.get(boardId) ?? legacyPinManager,
        running: board.running,
        compiledHex: board.compiledProgram,
        serialOutput: board.serialOutput,
        serialBaudRate: board.serialBaudRate,
        serialMonitorOpen: board.serialMonitorOpen,
        remoteConnected: bridgeMap.get(boardId)?.connected ?? false,
        remoteSocket: null,
      });
    },

    compileBoardProgram: (boardId: string, program: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      const sim = getBoardSimulator(boardId);
      if (sim && board.boardKind !== 'raspberry-pi-3') {
        try {
          if (sim instanceof AVRSimulator) {
            sim.loadHex(program);
            sim.addI2CDevice(new VirtualDS1307());
            sim.addI2CDevice(new VirtualTempSensor());
            sim.addI2CDevice(new I2CMemoryDevice(0x50));
          } else if (sim instanceof RP2040Simulator) {
            sim.loadBinary(program);
            sim.addI2CDevice(new VirtualDS1307() as RP2040I2CDevice);
            sim.addI2CDevice(new VirtualTempSensor() as RP2040I2CDevice);
            sim.addI2CDevice(new I2CMemoryDevice(0x50) as RP2040I2CDevice);
          }
        } catch (err) {
          console.error(`compileBoardProgram(${boardId}):`, err);
          return;
        }
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, compiledProgram: program } : b
        );
        const isActive = s.activeBoardId === boardId;
        return {
          boards,
          ...(isActive ? { compiledHex: program, hexEpoch: s.hexEpoch + 1 } : {}),
        };
      });
    },

    startBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (board.boardKind === 'raspberry-pi-3') {
        const bridge = getBoardBridge(boardId);
        if (bridge) bridge.connect();
      } else {
        const sim = getBoardSimulator(boardId);
        if (sim) sim.start();
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, running: true, serialMonitorOpen: true } : b
        );
        const isActive = s.activeBoardId === boardId;
        return { boards, ...(isActive ? { running: true, serialMonitorOpen: true } : {}) };
      });
    },

    stopBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (board.boardKind === 'raspberry-pi-3') {
        getBoardBridge(boardId)?.disconnect();
      } else {
        getBoardSimulator(boardId)?.stop();
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, running: false } : b
        );
        const isActive = s.activeBoardId === boardId;
        return { boards, ...(isActive ? { running: false } : {}) };
      });
    },

    resetBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (board.boardKind !== 'raspberry-pi-3') {
        const sim = getBoardSimulator(boardId);
        if (sim) {
          sim.reset();
          // Re-wire serial callback after reset
          sim.onSerialData = (ch) => {
            set((s) => {
              const boards = s.boards.map((b) =>
                b.id === boardId ? { ...b, serialOutput: b.serialOutput + ch } : b
              );
              const isActive = s.activeBoardId === boardId;
              return { boards, ...(isActive ? { serialOutput: s.serialOutput + ch } : {}) };
            });
          };
          if (sim instanceof AVRSimulator) {
            sim.onBaudRateChange = (baud) => {
              set((s) => {
                const boards = s.boards.map((b) =>
                  b.id === boardId ? { ...b, serialBaudRate: baud } : b
                );
                const isActive = s.activeBoardId === boardId;
                return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
              });
            };
          }
        }
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, running: false, serialOutput: '', serialBaudRate: 0 } : b
        );
        const isActive = s.activeBoardId === boardId;
        return { boards, ...(isActive ? { running: false, serialOutput: '', serialBaudRate: 0 } : {}) };
      });
    },

    // ── Legacy single-board API ───────────────────────────────────────────
    boardType: 'arduino-uno',
    boardPosition: { ...DEFAULT_BOARD_POSITION },
    simulator: initialSim,
    pinManager: legacyPinManager,
    running: false,
    compiledHex: null,
    hexEpoch: 0,
    serialOutput: '',
    serialBaudRate: 0,
    serialMonitorOpen: false,
    remoteConnected: false,
    remoteSocket: null,

    setBoardType: (type: BoardType) => {
      const { activeBoardId, running, stopSimulation } = get();
      if (running) stopSimulation();

      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const pm = getBoardPinManager(boardId) ?? legacyPinManager;

      // Stop and remove old simulator
      getBoardSimulator(boardId)?.stop();
      simulatorMap.delete(boardId);

      const sim = createSimulator(
        type as BoardKind,
        pm,
        (ch) => set((s) => {
          const boards = s.boards.map((b) =>
            b.id === boardId ? { ...b, serialOutput: b.serialOutput + ch } : b
          );
          return { boards, serialOutput: s.serialOutput + ch };
        }),
        (baud) => set((s) => {
          const boards = s.boards.map((b) =>
            b.id === boardId ? { ...b, serialBaudRate: baud } : b
          );
          return { boards, serialBaudRate: baud };
        }),
        getOscilloscopeCallback(),
      );
      simulatorMap.set(boardId, sim);

      set((s) => ({
        boardType: type,
        simulator: sim,
        compiledHex: null,
        serialOutput: '',
        serialBaudRate: 0,
        boards: s.boards.map((b) =>
          b.id === boardId
            ? { ...b, boardKind: type as BoardKind, compiledProgram: null, serialOutput: '', serialBaudRate: 0 }
            : b
        ),
      }));
      console.log(`Board switched to: ${type}`);
    },

    initSimulator: () => {
      const { boardType, activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const pm = getBoardPinManager(boardId) ?? legacyPinManager;

      getBoardSimulator(boardId)?.stop();
      simulatorMap.delete(boardId);

      const sim = createSimulator(
        boardType as BoardKind,
        pm,
        (ch) => set((s) => {
          const boards = s.boards.map((b) =>
            b.id === boardId ? { ...b, serialOutput: b.serialOutput + ch } : b
          );
          return { boards, serialOutput: s.serialOutput + ch };
        }),
        (baud) => set((s) => {
          const boards = s.boards.map((b) =>
            b.id === boardId ? { ...b, serialBaudRate: baud } : b
          );
          return { boards, serialBaudRate: baud };
        }),
        getOscilloscopeCallback(),
      );
      simulatorMap.set(boardId, sim);
      set({ simulator: sim, serialOutput: '', serialBaudRate: 0 });
      console.log(`Simulator initialized: ${boardType}`);
    },

    loadHex: (hex: string) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const sim = getBoardSimulator(boardId);
      if (sim && sim instanceof AVRSimulator) {
        try {
          sim.loadHex(hex);
          sim.addI2CDevice(new VirtualDS1307());
          sim.addI2CDevice(new VirtualTempSensor());
          sim.addI2CDevice(new I2CMemoryDevice(0x50));
          set((s) => ({ compiledHex: hex, hexEpoch: s.hexEpoch + 1 }));
          console.log('HEX file loaded successfully');
        } catch (error) {
          console.error('Failed to load HEX:', error);
        }
      } else {
        console.warn('loadHex: simulator not initialized or wrong board type');
      }
    },

    loadBinary: (base64: string) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const sim = getBoardSimulator(boardId);
      if (sim && sim instanceof RP2040Simulator) {
        try {
          sim.loadBinary(base64);
          sim.addI2CDevice(new VirtualDS1307() as RP2040I2CDevice);
          sim.addI2CDevice(new VirtualTempSensor() as RP2040I2CDevice);
          sim.addI2CDevice(new I2CMemoryDevice(0x50) as RP2040I2CDevice);
          set((s) => ({ compiledHex: base64, hexEpoch: s.hexEpoch + 1 }));
          console.log('Binary loaded into RP2040 successfully');
        } catch (error) {
          console.error('Failed to load binary:', error);
        }
      } else {
        console.warn('loadBinary: simulator not initialized or wrong board type');
      }
    },

    startSimulation: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      get().startBoard(boardId);
    },

    stopSimulation: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      get().stopBoard(boardId);
    },

    resetSimulation: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      get().resetBoard(boardId);
    },

    setCompiledHex: (hex: string) => {
      set({ compiledHex: hex });
      get().loadHex(hex);
    },

    setCompiledBinary: (base64: string) => {
      set({ compiledHex: base64 });
      get().loadBinary(base64);
    },

    setRunning: (running: boolean) => set({ running }),

    connectRemoteSimulator: (clientId: string) => {
      // Legacy: connect a Pi bridge for the given clientId
      const boardId = clientId;
      let bridge = getBoardBridge(boardId);
      if (!bridge) {
        bridge = new RaspberryPi3Bridge(boardId);
        bridge.onSerialData = (ch) => {
          set((s) => {
            const boards = s.boards.map((b) =>
              b.id === boardId ? { ...b, serialOutput: b.serialOutput + ch } : b
            );
            const isActive = s.activeBoardId === boardId;
            return { boards, ...(isActive ? { serialOutput: s.serialOutput + ch } : {}) };
          });
        };
        bridge.onPinChange = (gpioPin, state) => {
          const { wires } = get();
          const sim = getBoardSimulator(get().activeBoardId ?? INITIAL_BOARD_ID);
          if (!sim) return;
          const wire = wires.find(w =>
            (w.start.componentId.includes('raspberry-pi') && w.start.pinName === String(gpioPin)) ||
            (w.end.componentId.includes('raspberry-pi') && w.end.pinName === String(gpioPin))
          );
          if (wire) {
            const isArduinoStart = !wire.start.componentId.includes('raspberry-pi');
            const targetEndpoint = isArduinoStart ? wire.start : wire.end;
            const pinNum = parseInt(targetEndpoint.pinName, 10);
            if (!isNaN(pinNum)) sim.setPinState(pinNum, state);
          }
        };
        bridgeMap.set(boardId, bridge);
      }
      bridge.connect();
      set({ remoteConnected: true });
    },

    disconnectRemoteSimulator: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      getBoardBridge(boardId)?.disconnect();
      set({ remoteConnected: false, remoteSocket: null });
    },

    sendRemotePinEvent: (pin: string, state: number) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      getBoardBridge(boardId)?.sendPinEvent(parseInt(pin, 10), state === 1);
    },

    // ── Components ────────────────────────────────────────────────────────
    components: [
      {
        id: 'led-builtin',
        metadataId: 'led',
        x: 350,
        y: 100,
        properties: { color: 'red', pin: 13, state: false },
      },
    ],

    wires: [
      {
        id: 'wire-test-1',
        start: { componentId: 'arduino-uno', pinName: 'GND.1', x: 0, y: 0 },
        end: { componentId: 'led-builtin', pinName: 'A', x: 0, y: 0 },
        controlPoints: [],
        color: '#000000',
        signalType: 'power-gnd',
        isValid: true,
      },
      {
        id: 'wire-test-2',
        start: { componentId: 'arduino-uno', pinName: '13', x: 0, y: 0 },
        end: { componentId: 'led-builtin', pinName: 'C', x: 0, y: 0 },
        controlPoints: [],
        color: '#00ff00',
        signalType: 'digital',
        isValid: true,
      },
    ],
    selectedWireId: null,
    wireInProgress: null,

    addComponent: (component) => set((state) => ({ components: [...state.components, component] })),

    removeComponent: (id) => set((state) => ({
      components: state.components.filter((c) => c.id !== id),
      wires: state.wires.filter((w) => w.start.componentId !== id && w.end.componentId !== id),
    })),

    updateComponent: (id, updates) => {
      set((state) => ({
        components: state.components.map((c) => c.id === id ? { ...c, ...updates } : c),
      }));
      if (updates.x !== undefined || updates.y !== undefined) {
        get().updateWirePositions(id);
      }
    },

    updateComponentState: (id, state) => {
      set((prevState) => ({
        components: prevState.components.map((c) =>
          c.id === id ? { ...c, properties: { ...c.properties, state, value: state } } : c
        ),
      }));
    },

    handleComponentEvent: (_componentId, _eventName, _data) => {},

    setComponents: (components) => set({ components }),

    addWire: (wire) => set((state) => ({ wires: [...state.wires, wire] })),

    removeWire: (wireId) => set((state) => ({
      wires: state.wires.filter((w) => w.id !== wireId),
      selectedWireId: state.selectedWireId === wireId ? null : state.selectedWireId,
    })),

    updateWire: (wireId, updates) => set((state) => ({
      wires: state.wires.map((w) => w.id === wireId ? { ...w, ...updates } : w),
    })),

    setSelectedWire: (wireId) => set({ selectedWireId: wireId }),

    setWires: (wires) => set({ wires }),

    startWireCreation: (endpoint) => set({
      wireInProgress: { startEndpoint: endpoint, currentX: endpoint.x, currentY: endpoint.y },
    }),

    updateWireInProgress: (x, y) => set((state) => {
      if (!state.wireInProgress) return state;
      return { wireInProgress: { ...state.wireInProgress, currentX: x, currentY: y } };
    }),

    finishWireCreation: (endpoint) => {
      const state = get();
      if (!state.wireInProgress) return;
      const { startEndpoint } = state.wireInProgress;
      const midX = (startEndpoint.x + endpoint.x) / 2;
      const midY = (startEndpoint.y + endpoint.y) / 2;
      const newWire: Wire = {
        id: `wire-${Date.now()}`,
        start: startEndpoint,
        end: endpoint,
        controlPoints: [{ id: `cp-${Date.now()}`, x: midX, y: midY }],
        color: '#00ff00',
        signalType: 'digital',
        isValid: true,
      };
      set((state) => ({ wires: [...state.wires, newWire], wireInProgress: null }));
    },

    cancelWireCreation: () => set({ wireInProgress: null }),

    updateWirePositions: (componentId) => {
      set((state) => {
        const component = state.components.find((c) => c.id === componentId);
        // Check if this componentId matches a board id
        const board = state.boards.find((b) => b.id === componentId);
        const compX = component ? component.x : (board ? board.x : state.boardPosition.x);
        const compY = component ? component.y : (board ? board.y : state.boardPosition.y);

        const updatedWires = state.wires.map((wire) => {
          const updated = { ...wire };
          if (wire.start.componentId === componentId) {
            const pos = calculatePinPosition(componentId, wire.start.pinName, compX, compY);
            if (pos) updated.start = { ...wire.start, x: pos.x, y: pos.y };
          }
          if (wire.end.componentId === componentId) {
            const pos = calculatePinPosition(componentId, wire.end.pinName, compX, compY);
            if (pos) updated.end = { ...wire.end, x: pos.x, y: pos.y };
          }
          return updated;
        });
        return { wires: updatedWires };
      });
    },

    recalculateAllWirePositions: () => {
      const state = get();
      const updatedWires = state.wires.map((wire) => {
        const updated = { ...wire };

        // Resolve start
        const startComp = state.components.find((c) => c.id === wire.start.componentId);
        const startBoard = state.boards.find((b) => b.id === wire.start.componentId);
        const startX = startComp ? startComp.x : (startBoard ? startBoard.x : state.boardPosition.x);
        const startY = startComp ? startComp.y : (startBoard ? startBoard.y : state.boardPosition.y);
        const startPos = calculatePinPosition(wire.start.componentId, wire.start.pinName, startX, startY);
        updated.start = startPos
          ? { ...wire.start, x: startPos.x, y: startPos.y }
          : { ...wire.start, x: startX, y: startY };

        // Resolve end
        const endComp = state.components.find((c) => c.id === wire.end.componentId);
        const endBoard = state.boards.find((b) => b.id === wire.end.componentId);
        const endX = endComp ? endComp.x : (endBoard ? endBoard.x : state.boardPosition.x);
        const endY = endComp ? endComp.y : (endBoard ? endBoard.y : state.boardPosition.y);
        const endPos = calculatePinPosition(wire.end.componentId, wire.end.pinName, endX, endY);
        updated.end = endPos
          ? { ...wire.end, x: endPos.x, y: endPos.y }
          : { ...wire.end, x: endX, y: endY };

        // Auto-generate control points for wires with none
        if (
          updated.controlPoints.length === 0 &&
          (updated.start.x !== 0 || updated.start.y !== 0) &&
          (updated.end.x !== 0 || updated.end.y !== 0)
        ) {
          const midX = updated.start.x + (updated.end.x - updated.start.x) / 2;
          updated.controlPoints = [
            { id: `cp-${wire.id}-0`, x: midX, y: updated.start.y },
            { id: `cp-${wire.id}-1`, x: midX, y: updated.end.y },
          ];
        }

        return updated;
      });
      set({ wires: updatedWires });
    },

    toggleSerialMonitor: () => set((s) => ({ serialMonitorOpen: !s.serialMonitorOpen })),

    serialWrite: (text: string) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (board.boardKind === 'raspberry-pi-3') {
        const bridge = getBoardBridge(boardId);
        if (bridge) {
          for (let i = 0; i < text.length; i++) {
            bridge.sendSerialByte(text.charCodeAt(i));
          }
        }
      } else {
        getBoardSimulator(boardId)?.serialWrite(text);
      }
    },

    clearSerialOutput: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      set((s) => ({
        serialOutput: '',
        boards: s.boards.map((b) => b.id === boardId ? { ...b, serialOutput: '' } : b),
      }));
    },
  };
});

// ── Helper: get the active board instance (convenience for consumers) ─────
export function getActiveBoard(): BoardInstance | null {
  const { boards, activeBoardId } = useSimulatorStore.getState();
  return boards.find((b) => b.id === activeBoardId) ?? null;
}
