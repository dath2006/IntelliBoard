/**
 * Board Pin Mapping Utility
 *
 * Maps wokwi-element pin names to simulator GPIO/pin numbers
 * for both Arduino Uno (AVR) and Nano RP2040 Connect (RP2040).
 *
 * The wokwi board elements expose pin names like 'D2', 'A0', 'TX', etc.
 * The simulators need numeric GPIO/pin numbers.
 */

/**
 * Nano RP2040 Connect element pin names → RP2040 GPIO numbers.
 * Derived from wokwi-nano-rp2040-connect-element.ts pinInfo descriptions.
 */
const NANO_RP2040_PIN_MAP: Record<string, number> = {
  'D2': 25,   // GPIO25 — LED_BUILTIN
  'D3': 15,   // GPIO15
  'D4': 16,   // GPIO16 — SPI0 MISO
  'D5': 17,   // GPIO17 — SPI0 CS
  'D6': 18,   // GPIO18 — SPI0 SCK
  'D7': 19,   // GPIO19 — SPI0 MOSI
  'D8': 20,   // GPIO20
  'D9': 21,   // GPIO21
  'D10': 5,   // GPIO05
  'D11': 7,   // GPIO07
  'D12': 4,   // GPIO04 — I2C0 SDA
  'D13': 6,   // GPIO06 — SPI0 SCK (alternate)
  'TX': 0,    // GPIO0 — UART0 TX
  'RX': 1,    // GPIO1 — UART0 RX
  'A0': 26,   // GPIO26 — ADC channel 0
  'A1': 27,   // GPIO27 — ADC channel 1
  'A2': 28,   // GPIO28 — ADC channel 2
  'A3': 29,   // GPIO29 — ADC channel 3
  'A4': 12,   // GPIO12
  'A5': 13,   // GPIO13
};

/**
 * Arduino Uno analog pin names → AVR pin numbers.
 * Digital pins D0-D13 are parsed numerically; only analog names need mapping.
 */
const ARDUINO_UNO_ANALOG_MAP: Record<string, number> = {
  'A0': 14,
  'A1': 15,
  'A2': 16,
  'A3': 17,
  'A4': 18,
  'A5': 19,
  'A6': 20,
  'A7': 21,
};

/** All known board component IDs in the simulator */
export const BOARD_COMPONENT_IDS = ['arduino-uno', 'arduino-nano', 'nano-rp2040'];

/**
 * Check whether a componentId represents a board (not an external component).
 */
export function isBoardComponent(componentId: string): boolean {
  return BOARD_COMPONENT_IDS.includes(componentId);
}

/**
 * Convert a board element pin name to a simulator-usable pin/GPIO number.
 *
 * For Arduino Uno: 'D0'-'D13' / '0'-'13' → 0-13, 'A0'-'A7' → 14-21
 * For Nano RP2040: 'D2'-'D13' / 'A0'-'A5' / 'TX' / 'RX' → GPIO number
 *
 * @returns Numeric pin/GPIO number, or null if unmapped
 */
export function boardPinToNumber(boardId: string, pinName: string): number | null {
  if (boardId === 'arduino-uno' || boardId === 'arduino-nano') {
    // Try numeric (covers '0' through '13', also legacy examples using just numbers)
    const num = parseInt(pinName, 10);
    if (!isNaN(num) && num >= 0 && num <= 21) return num;
    // Try 'Dx' style
    if (pinName.startsWith('D')) {
      const d = parseInt(pinName.substring(1), 10);
      if (!isNaN(d)) return d;
    }
    // Analog naming
    return ARDUINO_UNO_ANALOG_MAP[pinName] ?? null;
  }

  if (boardId === 'nano-rp2040') {
    return NANO_RP2040_PIN_MAP[pinName] ?? null;
  }

  return null;
}
