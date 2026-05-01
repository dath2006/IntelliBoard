/**
 * Pin Position Calculator
 *
 * Converts pin coordinates from element space to canvas space (pixels).
 * This is the CRITICAL piece for wire system - without accurate pin positions,
 * wires cannot connect properly to components.
 *
 * Coordinate Systems:
 * 1. Element Space: Pin positions in pinInfo are in CSS pixels relative to element origin
 * 2. Canvas Space: Absolute positioning in pixels on the canvas
 *
 * Note: wokwi-elements pinInfo x/y are already in CSS pixels.
 */

import { boardPinToNumber } from './boardPinMapping';

/**
 * Calculates the absolute canvas position of a specific pin.
 *
 * @param componentId - The DOM ID of the component element
 * @param pinName - The name of the pin (e.g., 'A', 'C', 'GND.1', '13')
 * @param componentX - Component's X position on canvas (pixels)
 * @param componentY - Component's Y position on canvas (pixels)
 * @returns Absolute canvas coordinates { x, y } or null if pin not found
 */
export function calculatePinPosition(
  componentId: string,
  pinName: string,
  componentX: number,
  componentY: number,
  boardKind?: string,
): { x: number; y: number } | null {
  // Get the DOM element
  const element = document.getElementById(componentId);
  if (!element) {
    console.warn(`[pinPositionCalculator] Component ${componentId} not found in DOM`);
    return null;
  }

  // Access the pinInfo property (all wokwi-elements expose this)
  const pinInfo = (element as any).pinInfo;
  if (!pinInfo || !Array.isArray(pinInfo)) {
    console.warn(`[pinPositionCalculator] Component ${componentId} does not have pinInfo`);
    return null;
  }

  // Find the specific pin
  let pin = pinInfo.find((p: any) => p.name === pinName);
  // Fallback: try numbered variant (e.g. GND → GND.1) for pins that have suffix variants
  if (!pin && !pinName.includes('.')) {
    pin = pinInfo.find((p: any) => p.name === `${pinName}.1`);
  }
  // Fallback: case-insensitive match (agents frequently use lowercase pin names like
  // "a".."g" / "dp" for 7-segment displays, while wokwi-elements expose "A".."G" / "DP")
  if (!pin) {
    const target = pinName.trim().toLowerCase();
    pin = pinInfo.find((p: any) => String(p.name ?? '').trim().toLowerCase() === target);
  }
  if (!pin && !pinName.includes('.')) {
    const target = `${pinName}.1`.trim().toLowerCase();
    pin = pinInfo.find((p: any) => String(p.name ?? '').trim().toLowerCase() === target);
  }
  // Fallback: GP-prefix → match description field (e.g. 'GP15' → description 'GPIO15')
  // Needed for Nano RP2040 Connect which uses D-prefix pin names but GPIO descriptions
  if (!pin && pinName.startsWith('GP')) {
    const gpioNum = parseInt(pinName.substring(2), 10);
    if (!isNaN(gpioNum)) {
      pin = pinInfo.find((p: any) => p.description === `GPIO${gpioNum}`);
    }
  }
  if (!pin) {
    // Fallback for board pins: resolve by electrical equivalence rather than
    // raw pin label. This handles catalog/agent labels (e.g. "D2", "GND.1")
    // when the rendered board element exposes a different naming style
    // (e.g. "2", "GND", "GPIO2").
    const lookupBoard = boardKind ?? componentId;
    const targetNum = boardPinToNumber(lookupBoard, pinName);
    if (targetNum !== null) {
      // For GPIO pins, find a candidate that maps to the same numeric pin.
      if (targetNum >= 0) {
        pin = pinInfo.find((p: any) => {
          const n = String(p?.name ?? '').trim();
          if (!n) return false;
          return boardPinToNumber(lookupBoard, n) === targetNum;
        });
      } else {
        // Power/ground rails map to -1. Prefer same family (GND/3V3/5V/VIN/VCC),
        // then pick first available rail pin as a graceful fallback.
        const family = inferPowerFamily(pinName);
        pin =
          pinInfo.find((p: any) => {
            const n = String(p?.name ?? '').trim();
            return inferPowerFamily(n) === family;
          }) ??
          pinInfo.find((p: any) => {
            const n = String(p?.name ?? '').trim();
            return boardPinToNumber(lookupBoard, n) === -1;
          });
      }
    }
  }

  if (!pin) {
    console.warn(`[pinPositionCalculator] Pin ${pinName} not found on component ${componentId}`);
    console.warn(
      `Available pins:`,
      pinInfo.map((p: any) => p.name),
    );
    return null;
  }

  // Pin coordinates are already in CSS pixels, just add component position
  const pinX = componentX + pin.x;
  const pinY = componentY + pin.y;

  return { x: pinX, y: pinY };
}

function inferPowerFamily(pinName: string): 'gnd' | 'vcc' | 'vin' | '3v3' | '5v' | 'other' {
  const n = String(pinName ?? '').trim().toUpperCase();
  if (n.startsWith('GND')) return 'gnd';
  if (n.startsWith('VCC') || n.startsWith('VDD')) return 'vcc';
  if (n.startsWith('VIN')) return 'vin';
  if (n.startsWith('3V3') || n.startsWith('3.3V')) return '3v3';
  if (n.startsWith('5V')) return '5v';
  return 'other';
}

/**
 * Gets all pins for a component with their absolute canvas positions.
 * Useful for rendering pin overlays and finding nearby pins.
 *
 * @param componentId - The DOM ID of the component element
 * @param componentX - Component's X position on canvas
 * @param componentY - Component's Y position on canvas
 * @returns Array of pins with absolute positions and signal info
 */
export function getAllPinPositions(
  componentId: string,
  componentX: number,
  componentY: number,
): Array<{ name: string; x: number; y: number; signals: any[] }> {
  const element = document.getElementById(componentId);
  if (!element) return [];

  const pinInfo = (element as any).pinInfo;
  if (!pinInfo || !Array.isArray(pinInfo)) return [];

  return pinInfo.map((pin: any) => ({
    name: pin.name,
    x: componentX + pin.x,
    y: componentY + pin.y,
    signals: pin.signals || [],
  }));
}

/**
 * Finds the closest pin to a given canvas position.
 * Useful for snapping wire endpoints to nearby pins.
 *
 * @param componentId - The component to search
 * @param componentX - Component's X position
 * @param componentY - Component's Y position
 * @param targetX - Target X coordinate to find nearest pin
 * @param targetY - Target Y coordinate to find nearest pin
 * @param maxDistance - Maximum distance in pixels to consider (default 20)
 * @returns Closest pin info or null if none within maxDistance
 */
export function findClosestPin(
  componentId: string,
  componentX: number,
  componentY: number,
  targetX: number,
  targetY: number,
  maxDistance: number = 20,
): { name: string; x: number; y: number; signals: any[] } | null {
  const pins = getAllPinPositions(componentId, componentX, componentY);

  let closestPin: { name: string; x: number; y: number; signals: any[] } | null = null;
  let minDistance = maxDistance;

  for (const pin of pins) {
    const distance = Math.sqrt(Math.pow(pin.x - targetX, 2) + Math.pow(pin.y - targetY, 2));

    if (distance < minDistance) {
      minDistance = distance;
      closestPin = pin;
    }
  }

  return closestPin;
}
