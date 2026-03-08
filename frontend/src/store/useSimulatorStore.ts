import { create } from 'zustand';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { RP2040Simulator } from '../simulation/RP2040Simulator';
import { PinManager } from '../simulation/PinManager';
import { VirtualDS1307, VirtualTempSensor, I2CMemoryDevice } from '../simulation/I2CBusManager';
import type { RP2040I2CDevice } from '../simulation/RP2040Simulator';
import type { Wire, WireInProgress, WireEndpoint } from '../types/wire';
import { calculatePinPosition } from '../utils/pinPositionCalculator';

export type BoardType = 'arduino-uno' | 'arduino-nano' | 'raspberry-pi-pico';

export const BOARD_FQBN: Record<BoardType, string> = {
  'arduino-uno': 'arduino:avr:uno',
  'arduino-nano': 'arduino:avr:nano:cpu=atmega328',
  'raspberry-pi-pico': 'rp2040:rp2040:rpipico',
};

export const BOARD_LABELS: Record<BoardType, string> = {
  'arduino-uno': 'Arduino Uno',
  'arduino-nano': 'Arduino Nano',
  'raspberry-pi-pico': 'Raspberry Pi Pico',
};

// Default position for the Arduino board
export const DEFAULT_BOARD_POSITION = { x: 50, y: 50 };
// Keep legacy export alias for any remaining references
export const ARDUINO_POSITION = DEFAULT_BOARD_POSITION;

interface Component {
  id: string;
  metadataId: string;  // References ComponentMetadata by ID (e.g., 'led', 'dht22')
  x: number;
  y: number;
  properties: Record<string, unknown>;  // Flexible properties for any component type
}

interface SimulatorState {
  // Board selection
  boardType: BoardType;
  setBoardType: (type: BoardType) => void;

  // Board position (mutable — allows dragging)
  boardPosition: { x: number; y: number };
  setBoardPosition: (pos: { x: number; y: number }) => void;

  // Simulation state
  simulator: AVRSimulator | RP2040Simulator | null;
  pinManager: PinManager;
  running: boolean;
  compiledHex: string | null;

  // Components
  components: Component[];

  // Wire state (Phase 1)
  wires: Wire[];
  selectedWireId: string | null;
  wireInProgress: WireInProgress | null;

  // Serial monitor state
  serialOutput: string;
  serialBaudRate: number;
  serialMonitorOpen: boolean;

  // Actions
  initSimulator: () => void;
  loadHex: (hex: string) => void;
  loadBinary: (base64: string) => void;
  startSimulation: () => void;
  stopSimulation: () => void;
  resetSimulation: () => void;
  setCompiledHex: (hex: string) => void;
  setCompiledBinary: (base64: string) => void;
  setRunning: (running: boolean) => void;

  // Component management
  addComponent: (component: Component) => void;
  removeComponent: (id: string) => void;
  updateComponent: (id: string, updates: Partial<Component>) => void;
  updateComponentState: (id: string, state: boolean) => void;
  handleComponentEvent: (componentId: string, eventName: string, data?: any) => void;
  setComponents: (components: Component[]) => void;

  // Wire management (Phase 1)
  addWire: (wire: Wire) => void;
  removeWire: (wireId: string) => void;
  updateWire: (wireId: string, updates: Partial<Wire>) => void;
  setSelectedWire: (wireId: string | null) => void;
  setWires: (wires: Wire[]) => void;

  // Wire creation (Phase 2)
  startWireCreation: (endpoint: WireEndpoint) => void;
  updateWireInProgress: (x: number, y: number) => void;
  finishWireCreation: (endpoint: WireEndpoint) => void;
  cancelWireCreation: () => void;

  // Wire position updates (auto-update when components move)
  updateWirePositions: (componentId: string) => void;
  recalculateAllWirePositions: () => void;

  // Serial monitor
  toggleSerialMonitor: () => void;
  serialWrite: (text: string) => void;
  clearSerialOutput: () => void;
}

export const useSimulatorStore = create<SimulatorState>((set, get) => {
  // Create PinManager instance
  const pinManager = new PinManager();

  return {
    boardType: 'arduino-uno' as BoardType,
    boardPosition: { ...DEFAULT_BOARD_POSITION },
    simulator: null,
    pinManager,
    running: false,
    compiledHex: null,
    components: [
      {
        id: 'led-builtin',
        metadataId: 'led',
        x: 350,
        y: 100,
        properties: {
          color: 'red',
          pin: 13,
          state: false,
        },
      },
    ],

    // Wire state with test wires (Phase 1 - Testing)
    // Positions will be recalculated dynamically after DOM mount
    wires: [
      {
        id: 'wire-test-1',
        start: {
          componentId: 'arduino-uno',
          pinName: 'GND.1',
          x: 0,
          y: 0,
        },
        end: {
          componentId: 'led-builtin',
          pinName: 'A',
          x: 0,
          y: 0,
        },
        controlPoints: [],
        color: '#000000', // Black for GND
        signalType: 'power-gnd',
        isValid: true,
      },
      {
        id: 'wire-test-2',
        start: {
          componentId: 'arduino-uno',
          pinName: '13',
          x: 0,
          y: 0,
        },
        end: {
          componentId: 'led-builtin',
          pinName: 'C',
          x: 0,
          y: 0,
        },
        controlPoints: [],
        color: '#00ff00', // Green for digital
        signalType: 'digital',
        isValid: true,
      },
    ],
    selectedWireId: null,
    wireInProgress: null,
    serialOutput: '',
    serialBaudRate: 0,
    serialMonitorOpen: false,

    setBoardPosition: (pos) => {
      set({ boardPosition: pos });
    },

    setBoardType: (type: BoardType) => {
      const { running } = get();
      if (running) {
        get().stopSimulation();
      }
      const simulator = (type === 'arduino-uno' || type === 'arduino-nano')
        ? new AVRSimulator(pinManager)
        : new RP2040Simulator(pinManager);
      // Wire serial output callback for both simulator types
      simulator.onSerialData = (char: string) => {
        set((s) => ({ serialOutput: s.serialOutput + char }));
      };
      if (simulator instanceof AVRSimulator) {
        simulator.onBaudRateChange = (baudRate: number) => set({ serialBaudRate: baudRate });
      }
      set({ boardType: type, simulator, compiledHex: null, serialOutput: '', serialBaudRate: 0 });
      console.log(`Board switched to: ${type}`);
    },

    initSimulator: () => {
      const { boardType } = get();
      const simulator = (boardType === 'arduino-uno' || boardType === 'arduino-nano')
        ? new AVRSimulator(pinManager)
        : new RP2040Simulator(pinManager);
      // Wire serial output callback for both simulator types
      simulator.onSerialData = (char: string) => {
        set((s) => ({ serialOutput: s.serialOutput + char }));
      };
      if (simulator instanceof AVRSimulator) {
        simulator.onBaudRateChange = (baudRate: number) => set({ serialBaudRate: baudRate });
      }
      set({ simulator, serialOutput: '', serialBaudRate: 0 });
      console.log(`Simulator initialized: ${boardType}`);
    },

    loadHex: (hex: string) => {
      const { simulator } = get();
      if (simulator && simulator instanceof AVRSimulator) {
        try {
          simulator.loadHex(hex);
          set({ compiledHex: hex });
          console.log('HEX file loaded successfully');
        } catch (error) {
          console.error('Failed to load HEX:', error);
        }
      } else {
        console.warn('loadHex: simulator not initialized or wrong board type');
      }
    },

    loadBinary: (base64: string) => {
      const { simulator } = get();
      if (simulator && simulator instanceof RP2040Simulator) {
        try {
          simulator.loadBinary(base64);
          set({ compiledHex: base64 }); // reuse compiledHex as "program loaded" flag
          console.log('Binary loaded into RP2040 successfully');
        } catch (error) {
          console.error('Failed to load binary:', error);
        }
      } else {
        console.warn('loadBinary: simulator not initialized or wrong board type');
      }
    },

    startSimulation: () => {
      const { simulator } = get();
      if (simulator) {
        // Register virtual I2C devices before starting
        if (simulator instanceof AVRSimulator && simulator.i2cBus) {
          simulator.addI2CDevice(new VirtualDS1307());
          simulator.addI2CDevice(new VirtualTempSensor());
          simulator.addI2CDevice(new I2CMemoryDevice(0x50));
        } else if (simulator instanceof RP2040Simulator) {
          simulator.addI2CDevice(new VirtualDS1307() as RP2040I2CDevice);
          simulator.addI2CDevice(new VirtualTempSensor() as RP2040I2CDevice);
          simulator.addI2CDevice(new I2CMemoryDevice(0x50) as RP2040I2CDevice);
        }
        simulator.start();
        set({ running: true, serialMonitorOpen: true });
      }
    },

    stopSimulation: () => {
      const { simulator } = get();
      if (simulator) {
        simulator.stop();
        set({ running: false });
      }
    },

    resetSimulation: () => {
      const { simulator } = get();
      if (simulator) {
        simulator.reset();
        // Re-wire serial callback after reset (both simulator types)
        simulator.onSerialData = (char: string) => {
          set((s) => ({ serialOutput: s.serialOutput + char }));
        };
        if (simulator instanceof AVRSimulator) {
          simulator.onBaudRateChange = (baudRate: number) => set({ serialBaudRate: baudRate });
        }
        set({ running: false, serialOutput: '', serialBaudRate: 0 });
      }
    },

    setCompiledHex: (hex: string) => {
      set({ compiledHex: hex });
      get().loadHex(hex);
    },

    setCompiledBinary: (base64: string) => {
      set({ compiledHex: base64 }); // use compiledHex as "program ready" flag
      get().loadBinary(base64);
    },

    setRunning: (running: boolean) => set({ running }),

    addComponent: (component) => {
      set((state) => ({
        components: [...state.components, component],
      }));
    },

    removeComponent: (id) => {
      set((state) => ({
        components: state.components.filter((c) => c.id !== id),
        // Also remove wires connected to this component
        wires: state.wires.filter((w) =>
          w.start.componentId !== id && w.end.componentId !== id
        ),
      }));
    },

    updateComponent: (id, updates) => {
      set((state) => ({
        components: state.components.map((c) =>
          c.id === id ? { ...c, ...updates } : c
        ),
      }));

      // Update wire positions if component moved
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

    handleComponentEvent: (_componentId, _eventName, _data) => {
      // Legacy UI-based handling can be placed here if needed
      // but device simulation events are now in DynamicComponent via PartSimulationRegistry
    },

    setComponents: (components) => {
      set({ components });
    },

    // Wire management actions
    addWire: (wire) => {
      set((state) => ({
        wires: [...state.wires, wire],
      }));
    },

    removeWire: (wireId) => {
      set((state) => ({
        wires: state.wires.filter((w) => w.id !== wireId),
        selectedWireId: state.selectedWireId === wireId ? null : state.selectedWireId,
      }));
    },

    updateWire: (wireId, updates) => {
      set((state) => ({
        wires: state.wires.map((w) =>
          w.id === wireId ? { ...w, ...updates } : w
        ),
      }));
    },

    setSelectedWire: (wireId) => {
      set({ selectedWireId: wireId });
    },

    setWires: (wires) => {
      set({ wires });
    },

    // Wire creation actions (Phase 2)
    startWireCreation: (endpoint) => {
      set({
        wireInProgress: {
          startEndpoint: endpoint,
          currentX: endpoint.x,
          currentY: endpoint.y,
        },
      });
    },

    updateWireInProgress: (x, y) => {
      set((state) => {
        if (!state.wireInProgress) return state;
        return {
          wireInProgress: {
            ...state.wireInProgress,
            currentX: x,
            currentY: y,
          },
        };
      });
    },

    finishWireCreation: (endpoint) => {
      const state = get();
      if (!state.wireInProgress) return;

      const { startEndpoint } = state.wireInProgress;

      // Calculate midpoint for control point
      const midX = (startEndpoint.x + endpoint.x) / 2;
      const midY = (startEndpoint.y + endpoint.y) / 2;

      const newWire: Wire = {
        id: `wire-${Date.now()}`,
        start: startEndpoint,
        end: endpoint,
        controlPoints: [
          {
            id: `cp-${Date.now()}`,
            x: midX,
            y: midY,
          },
        ],
        color: '#00ff00', // Default green, will be calculated based on signal type
        signalType: 'digital',
        isValid: true,
      };

      set((state) => ({
        wires: [...state.wires, newWire],
        wireInProgress: null,
      }));
    },

    cancelWireCreation: () => {
      set({ wireInProgress: null });
    },

    // Update wire positions when component moves
    updateWirePositions: (componentId) => {
      set((state) => {
        const component = state.components.find((c) => c.id === componentId);
        // For the board, use boardPosition from state
        const bp = state.boardPosition;
        const compX = component ? component.x : bp.x;
        const compY = component ? component.y : bp.y;

        const updatedWires = state.wires.map((wire) => {
          const updated = { ...wire };
          if (wire.start.componentId === componentId) {
            const pos = calculatePinPosition(
              componentId,
              wire.start.pinName,
              compX,
              compY
            );
            if (pos) {
              updated.start = { ...wire.start, x: pos.x, y: pos.y };
            }
          }

          // Update end endpoint if it belongs to this component
          if (wire.end.componentId === componentId) {
            const pos = calculatePinPosition(
              componentId,
              wire.end.pinName,
              compX,
              compY
            );
            if (pos) {
              updated.end = { ...wire.end, x: pos.x, y: pos.y };
            }
          }

          return updated;
        });

        return { wires: updatedWires };
      });
    },

    // Recalculate all wire positions from actual DOM pinInfo
    recalculateAllWirePositions: () => {
      const state = get();

      const updatedWires = state.wires.map((wire) => {
        const updated = { ...wire };
        const startComp = state.components.find((c) => c.id === wire.start.componentId);
        const bp = state.boardPosition;
        const startX = startComp ? startComp.x : bp.x;
        const startY = startComp ? startComp.y : bp.y;

        const startPos = calculatePinPosition(
          wire.start.componentId,
          wire.start.pinName,
          startX,
          startY
        );
        if (startPos) {
          updated.start = { ...wire.start, x: startPos.x, y: startPos.y };
        }

        // Resolve end component position
        const endComp = state.components.find((c) => c.id === wire.end.componentId);
        const endX = endComp ? endComp.x : bp.x;
        const endY = endComp ? endComp.y : bp.y;

        const endPos = calculatePinPosition(
          wire.end.componentId,
          wire.end.pinName,
          endX,
          endY
        );
        if (endPos) {
          updated.end = { ...wire.end, x: endPos.x, y: endPos.y };
        }

        // Auto-generate control points for wires that have none
        // (e.g., wires loaded from examples or old saved projects).
        // This ensures the rendered path and interactive segments use the
        // same Z-shape routing, enabling proper segment dragging.
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

    // Serial monitor actions
    toggleSerialMonitor: () => {
      set((s) => ({ serialMonitorOpen: !s.serialMonitorOpen }));
    },

    serialWrite: (text: string) => {
      const { simulator } = get();
      if (simulator) {
        simulator.serialWrite(text);
      }
    },

    clearSerialOutput: () => {
      set({ serialOutput: '' });
    },
  };
});
