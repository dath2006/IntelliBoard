import type { BoardKind } from '../types/board';

const KNOWN_BOARD_KINDS = new Set<BoardKind>([
  'arduino-uno',
  'arduino-nano',
  'arduino-mega',
  'raspberry-pi-pico',
  'pi-pico-w',
  'raspberry-pi-3',
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
  'attiny85',
]);

const BOARD_KIND_ALIASES: Record<string, BoardKind> = {
  'esp32-devkit-v1': 'esp32',
  'wokwi-esp32-devkit-v1': 'esp32',
  'wokwi-esp32-devkit-c-v4': 'esp32-devkit-c-v4',
  'wokwi-esp32-cam': 'esp32-cam',
  'wokwi-wemos-lolin32-lite': 'wemos-lolin32-lite',
  'wokwi-esp32-s3': 'esp32-s3',
  'wokwi-xiao-esp32-s3': 'xiao-esp32-s3',
  'wokwi-arduino-nano-esp32': 'arduino-nano-esp32',
  'wokwi-esp32-c3': 'esp32-c3',
  'wokwi-xiao-esp32-c3': 'xiao-esp32-c3',
  'wokwi-aitewinrobot-esp32c3-supermini': 'aitewinrobot-esp32c3-supermini',
  'wokwi-arduino-uno': 'arduino-uno',
  'wokwi-arduino-nano': 'arduino-nano',
  'wokwi-arduino-mega': 'arduino-mega',
  'wokwi-pi-pico': 'raspberry-pi-pico',
  'wokwi-pi-pico-w': 'pi-pico-w',
  'wokwi-raspberry-pi-pico': 'raspberry-pi-pico',
};

const ESP32_XTENSA_KINDS = new Set<BoardKind>([
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
]);

const ESP32_RISCV_KINDS = new Set<BoardKind>([
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
]);

export function isKnownBoardKind(value: string): value is BoardKind {
  return KNOWN_BOARD_KINDS.has(value as BoardKind);
}

export function resolveBoardKind(input: string | BoardKind, fallback: BoardKind = 'arduino-uno'): BoardKind {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return fallback;

  if (isKnownBoardKind(raw)) return raw;

  const alias = BOARD_KIND_ALIASES[raw];
  if (alias) return alias;

  // Family-level fallback for forward compatibility with new ESP32 variants.
  if (raw.includes('esp32c3') || raw.includes('esp32-c3')) return 'esp32-c3';
  if (raw.includes('esp32s3') || raw.includes('esp32-s3')) return 'esp32-s3';
  if (raw.includes('esp32')) return 'esp32';
  if (raw.includes('pico-w')) return 'pi-pico-w';
  if (raw.includes('pico')) return 'raspberry-pi-pico';

  return fallback;
}

export function isEsp32BoardKind(kind: string | BoardKind): boolean {
  const resolved = resolveBoardKind(kind);
  return ESP32_XTENSA_KINDS.has(resolved) || ESP32_RISCV_KINDS.has(resolved);
}

export function isRiscVEsp32BoardKind(kind: string | BoardKind): boolean {
  return ESP32_RISCV_KINDS.has(resolveBoardKind(kind));
}

