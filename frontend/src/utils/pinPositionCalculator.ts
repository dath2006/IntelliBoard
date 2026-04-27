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
  componentY: number
): { x: number; y: number } | null {
  const element = document.getElementById(componentId);
  if (!element) {
    console.warn(`[pinPositionCalculator] Component ${componentId} not found in DOM`);
    return null;
  }

  const pinInfo = (element as any).pinInfo;
  if (!pinInfo || !Array.isArray(pinInfo)) {
    console.warn(`[pinPositionCalculator] Component ${componentId} does not have pinInfo`);
    return null;
  }

  const byName = (name: string) => pinInfo.find((p: any) => p.name === name);

  let pin =
    // 1. Exact match (covers D4, D23, GND.1, A0, GP0, etc.)
    byName(pinName) ??
    // 2. Suffix variant: bare "GND" → "GND.1" (power pins with numeric suffix)
    (!pinName.includes('.') ? byName(`${pinName}.1`) : undefined) ??
    // 3. GP-prefix → GPIO description (RP2040: 'GP15' → description 'GPIO15')
    (pinName.startsWith('GP') && !pinName.startsWith('GPIO')
      ? (() => {
          const n = parseInt(pinName.substring(2), 10);
          return isNaN(n) ? undefined : pinInfo.find((p: any) => p.description === `GPIO${n}`);
        })()
      : undefined) ??
    // 4. Bare number → D-prefix (e.g. '4' → 'D4' for Arduino/ESP32 DevKit V1)
    (/^\d+$/.test(pinName) ? byName(`D${pinName}`) : undefined) ??
    // 5. Bare number → exact (some elements store bare numbers directly)
    (/^\d+$/.test(pinName) ? byName(pinName) : undefined);

  if (!pin) {
    console.warn(`[pinPositionCalculator] Pin ${pinName} not found on component ${componentId}`);
    console.warn(`Available pins:`, pinInfo.map((p: any) => p.name));
    return null;
  }

  return { x: componentX + pin.x, y: componentY + pin.y };
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
  componentY: number
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
  maxDistance: number = 20
): { name: string; x: number; y: number; signals: any[] } | null {
  const pins = getAllPinPositions(componentId, componentX, componentY);

  let closestPin: { name: string; x: number; y: number; signals: any[] } | null = null;
  let minDistance = maxDistance;

  for (const pin of pins) {
    const distance = Math.sqrt(
      Math.pow(pin.x - targetX, 2) + Math.pow(pin.y - targetY, 2)
    );

    if (distance < minDistance) {
      minDistance = distance;
      closestPin = pin;
    }
  }

  return closestPin;
}


