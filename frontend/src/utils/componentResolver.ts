import { boardPinToNumber } from './boardPinMapping';

export interface PinInfoLike {
  name?: string;
  description?: string;
  x?: number;
  y?: number;
  [key: string]: unknown;
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace('wokwi-', '')
    .replace(/[^a-z0-9]/g, '');
}

function powerFamily(pinName: string): 'gnd' | 'vcc' | 'vin' | '3v3' | '5v' | 'other' {
  const n = String(pinName ?? '').trim().toUpperCase();
  if (n.startsWith('GND')) return 'gnd';
  if (n.startsWith('VCC') || n.startsWith('VDD')) return 'vcc';
  if (n.startsWith('VIN')) return 'vin';
  if (n.startsWith('3V3') || n.startsWith('3.3V')) return '3v3';
  if (n.startsWith('5V')) return '5v';
  return 'other';
}

export function resolvePinFromPinInfo(
  pinInfo: PinInfoLike[],
  requestedPinName: string,
  opts?: { boardKind?: string; componentId?: string },
): PinInfoLike | null {
  const raw = String(requestedPinName ?? '').trim();
  if (!raw || !Array.isArray(pinInfo) || pinInfo.length === 0) return null;

  const pinBy = (predicate: (pin: PinInfoLike) => boolean) => pinInfo.find(predicate) ?? null;

  // 1) Exact + normalized text matching.
  let pin =
    pinBy((p) => String(p.name ?? '') === raw) ??
    pinBy((p) => String(p.name ?? '').trim().toLowerCase() === raw.toLowerCase()) ??
    pinBy((p) => normalizeKey(String(p.name ?? '')) === normalizeKey(raw));
  if (pin) return pin;

  // 2) Numbered variant fallback (GND -> GND.1).
  if (!raw.includes('.')) {
    const dotted = `${raw}.1`;
    pin =
      pinBy((p) => String(p.name ?? '') === dotted) ??
      pinBy((p) => String(p.name ?? '').trim().toLowerCase() === dotted.toLowerCase());
    if (pin) return pin;
  }

  // 3) RP2040 style GPxx aliases via description (GP15 -> GPIO15).
  if (raw.toUpperCase().startsWith('GP')) {
    const gpioNum = parseInt(raw.substring(2), 10);
    if (!Number.isNaN(gpioNum)) {
      pin = pinBy((p) => String(p.description ?? '').trim().toUpperCase() === `GPIO${gpioNum}`);
      if (pin) return pin;
    }
  }

  // 4) Board electrical-equivalence fallback (D2 == 2 == GPIO2, etc.).
  const lookupBoard = opts?.boardKind ?? opts?.componentId;
  if (lookupBoard) {
    const targetNum = boardPinToNumber(lookupBoard, raw);
    if (targetNum !== null) {
      if (targetNum >= 0) {
        pin = pinBy((p) => boardPinToNumber(lookupBoard, String(p.name ?? '').trim()) === targetNum);
      } else {
        const family = powerFamily(raw);
        pin =
          pinBy((p) => powerFamily(String(p.name ?? '').trim()) === family) ??
          pinBy((p) => boardPinToNumber(lookupBoard, String(p.name ?? '').trim()) === -1);
      }
      if (pin) return pin;
    }
  }

  return null;
}

