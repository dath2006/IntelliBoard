/**
 * Hooks up the electrical solver to the main simulator store:
 *   - subscribe to components, wires, pin changes
 *   - on change, build the input and request a solve
 *   - inject node voltages back into ADC channels
 *
 * Called once at app startup (typically from EditorPage or main.tsx).
 * Returns an `unsubscribe()` for cleanup.
 */
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import { buildInputFromStore } from './storeAdapter';
import type { PinSourceState } from './types';
import type { BoardKind } from '../../types/board';

// Which Arduino-style pin name maps to which ADC channel, per board.
// Used to inject SPICE-solved voltages back into the MCU's ADC peripheral.
function adcRange(prefix: string, start: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    pinName: `${prefix}${start + i}`,
    channel: i,
  }));
}

const ADC_6CH = adcRange('A', 0, 6);  // A0..A5
const ADC_8CH = adcRange('A', 0, 8);  // A0..A7
const ADC_16CH = adcRange('A', 0, 16); // A0..A15

const ADC_PIN_MAP: Partial<Record<BoardKind, Array<{ pinName: string; channel: number }>>> = {
  // AVR boards
  'arduino-uno':  ADC_6CH,
  'arduino-nano': ADC_8CH,
  'arduino-mega': ADC_16CH,
  'attiny85':     adcRange('A', 0, 4), // A0..A3 (PB2-PB5)

  // RP2040 boards — 4 ADC channels (GP26-GP29)
  'raspberry-pi-pico': [
    { pinName: 'GP26', channel: 0 }, { pinName: 'GP27', channel: 1 },
    { pinName: 'GP28', channel: 2 }, { pinName: 'GP29', channel: 3 },
  ],
  'pi-pico-w': [
    { pinName: 'GP26', channel: 0 }, { pinName: 'GP27', channel: 1 },
    { pinName: 'GP28', channel: 2 }, { pinName: 'GP29', channel: 3 },
  ],

  // ESP32 variants — most GPIOs can be ADC but the common ones are:
  // ADC1: GPIO 32-39 (channels 0-7), ADC2: GPIO 0,2,4,12-15,25-27
  // Simplified to the 8 most-used pins (GPIO 32-39 = ADC1)
  'esp32':              adcRange('GPIO', 32, 8),
  'esp32-devkit-c-v4':  adcRange('GPIO', 32, 8),
  'esp32-cam':          adcRange('GPIO', 32, 8),
  'wemos-lolin32-lite': adcRange('GPIO', 32, 8),

  // ESP32-S3 — ADC1 channels on GPIO 1-10, ADC2 on GPIO 11-20
  'esp32-s3':           adcRange('GPIO', 1, 10),
  'xiao-esp32-s3':      adcRange('GPIO', 1, 10),
  'arduino-nano-esp32': adcRange('A', 0, 8),

  // ESP32-C3 — ADC1 channels on GPIO 0-4, ADC2 on GPIO 5
  'esp32-c3':                      adcRange('GPIO', 0, 6),
  'xiao-esp32-c3':                 adcRange('GPIO', 0, 6),
  'aitewinrobot-esp32c3-supermini': adcRange('GPIO', 0, 6),
};

export function wireElectricalSolver(): () => void {
  let lastPinStates: Record<string, Record<string, PinSourceState>> = {};

  function collectPinStates(): Record<string, Record<string, PinSourceState>> {
    const boards = useSimulatorStore.getState().boards;
    const out: Record<string, Record<string, PinSourceState>> = {};
    for (const board of boards) {
      const simulator = board.simulator as unknown as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pinManager?: any;
      } | null;
      const entries: Record<string, PinSourceState> = {};
      // NOTE: Velxio's PinManager tracks state per pin number. Translating
      // number → pin name depends on board-specific maps. For Phase 8.3 we
      // emit pin states only when `pinManager.getPinState(pin)` is readable;
      // boards without that accessor simply contribute no GPIO sources
      // (their wires still participate via canonicalized ground/vcc).
      if (simulator?.pinManager?.getPinState) {
        // Best-effort: we don't yet have a canonical pin-number → pin-name
        // map for all boards here. Future work (Phase 8.4) will enrich this.
      }
      out[board.id] = entries;
    }
    return out;
  }

  function maybeSolve() {
    const { mode } = useElectricalStore.getState();
    if (mode === 'off') return;
    const storeState = useSimulatorStore.getState();
    const pinStates = collectPinStates();
    lastPinStates = pinStates;
    const snap = {
      components: storeState.components,
      wires: storeState.wires,
      boards: storeState.boards.map((b) => ({
        id: b.id,
        boardKind: b.boardKind,
        pinStates: pinStates[b.id] ?? {},
      })),
    };
    const input = buildInputFromStore(snap);
    useElectricalStore.getState().triggerSolve(input);
  }

  function injectVoltagesIntoADC() {
    const { nodeVoltages } = useElectricalStore.getState();
    const { boards } = useSimulatorStore.getState();
    for (const board of boards) {
      const map = ADC_PIN_MAP[board.boardKind];
      if (!map) continue;
      const simulator = board.simulator as unknown as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getADC?: () => { channelValues: number[] } | null;
      } | null;
      const adc = simulator?.getADC?.();
      if (!adc) continue;
      // Try to find a net matching "<boardId>_<pinName>" by string lookup
      for (const { pinName, channel } of map) {
        const probeKey = `${board.id}:${pinName}`;
        // ngspice result keys are net names from NetlistBuilder — we don't
        // yet have a direct pin→net lookup here. This is a forward-looking
        // scaffold; Phase 8.4 will add the map via storeAdapter.
        void probeKey;
        // For now: if any net name literally equals the pin label, use it.
        const v = nodeVoltages[pinName] ?? nodeVoltages[probeKey] ?? null;
        if (v != null) {
          adc.channelValues[channel] = Math.max(0, Math.min(board.boardKind.startsWith('esp32') ? 3.3 : 5, v));
        }
      }
    }
  }

  // Re-solve on components / wires / mode changes.
  const unsubSim = useSimulatorStore.subscribe((state, prev) => {
    if (state.components !== prev.components || state.wires !== prev.wires) {
      maybeSolve();
    }
  });

  const unsubMode = useElectricalStore.subscribe((state, prev) => {
    if (state.mode !== prev.mode && state.mode !== 'off') {
      maybeSolve();
    }
  });

  // On every solve result, re-inject ADC voltages.
  const unsubResult = useElectricalStore.subscribe((state, prev) => {
    if (state.nodeVoltages !== prev.nodeVoltages) {
      injectVoltagesIntoADC();
    }
  });

  return () => {
    unsubSim();
    unsubMode();
    unsubResult();
    void lastPinStates;
  };
}
