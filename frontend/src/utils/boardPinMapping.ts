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

/**
 * Arduino Mega analog pin names → AVR pin numbers.
 * A0–A15 map to physical pins 54–69 on the ATmega2560.
 */
const ARDUINO_MEGA_ANALOG_MAP: Record<string, number> = {
  'A0': 54,  'A1': 55,  'A2': 56,  'A3': 57,
  'A4': 58,  'A5': 59,  'A6': 60,  'A7': 61,
  'A8': 62,  'A9': 63,  'A10': 64, 'A11': 65,
  'A12': 66, 'A13': 67, 'A14': 68, 'A15': 69,
};

/**
 * Raspberry Pi 3B physical pin number → BCM GPIO number.
 * Power / GND / special-function pins are mapped to -1 (not a GPIO).
 * Source: https://pinout.xyz
 */
export const PI3_PHYSICAL_TO_BCM: Record<number, number> = {
  1:  -1,  // 3.3V
  2:  -1,  // 5V
  3:  2,   // BCM2 (SDA1)
  4:  -1,  // 5V
  5:  3,   // BCM3 (SCL1)
  6:  -1,  // GND
  7:  4,   // BCM4 (GPCLK0)
  8:  14,  // BCM14 (TXD0 / ttyAMA0)
  9:  -1,  // GND
  10: 15,  // BCM15 (RXD0 / ttyAMA0)
  11: 17,  // BCM17
  12: 18,  // BCM18 (PWM0)
  13: 27,  // BCM27
  14: -1,  // GND
  15: 22,  // BCM22
  16: 23,  // BCM23
  17: -1,  // 3.3V
  18: 24,  // BCM24
  19: 10,  // BCM10 (MOSI)
  20: -1,  // GND
  21: 9,   // BCM9 (MISO)
  22: 25,  // BCM25
  23: 11,  // BCM11 (SCLK)
  24: 8,   // BCM8 (CE0)
  25: -1,  // GND
  26: 7,   // BCM7 (CE1)
  27: -1,  // ID_SD (reserved)
  28: -1,  // ID_SC (reserved)
  29: 5,   // BCM5
  30: -1,  // GND
  31: 6,   // BCM6
  32: 12,  // BCM12 (PWM0)
  33: 13,  // BCM13 (PWM1)
  34: -1,  // GND
  35: 19,  // BCM19 (MISO1)
  36: 16,  // BCM16 (CE2)
  37: 26,  // BCM26
  38: 20,  // BCM20 (MOSI1)
  39: -1,  // GND
  40: 21,  // BCM21 (SCLK1)
};

/** BCM GPIO number → physical pin number (reverse map) */
export const PI3_BCM_TO_PHYSICAL: Record<number, number> = Object.fromEntries(
  Object.entries(PI3_PHYSICAL_TO_BCM)
    .filter(([, bcm]) => bcm >= 0)
    .map(([physical, bcm]) => [bcm, Number(physical)])
);

/** All known board component IDs in the simulator */
export const BOARD_COMPONENT_IDS = [
  'arduino-uno', 'arduino-nano', 'arduino-mega', 'nano-rp2040', 'raspberry-pi-3',
];

/**
 * Check whether a componentId represents a board (not an external component).
 */
export function isBoardComponent(componentId: string): boolean {
  return BOARD_COMPONENT_IDS.some((id) => componentId === id || componentId.startsWith(id));
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

  if (boardId === 'arduino-mega') {
    // Digital pins D0–D53 parsed numerically
    const num = parseInt(pinName, 10);
    if (!isNaN(num) && num >= 0 && num <= 53) return num;
    if (pinName.startsWith('D')) {
      const d = parseInt(pinName.substring(1), 10);
      if (!isNaN(d) && d <= 53) return d;
    }
    return ARDUINO_MEGA_ANALOG_MAP[pinName] ?? null;
  }

  if (boardId === 'nano-rp2040') {
    return NANO_RP2040_PIN_MAP[pinName] ?? null;
  }

  // Raspberry Pi 3B — pinName is the physical pin number ("1" … "40")
  // We return the BCM GPIO number, or -1 for power/GND pins.
  if (boardId === 'raspberry-pi-3' || boardId.startsWith('raspberry-pi-3')) {
    const physical = parseInt(pinName, 10);
    if (!isNaN(physical)) return PI3_PHYSICAL_TO_BCM[physical] ?? null;
    return null;
  }

  return null;
}
