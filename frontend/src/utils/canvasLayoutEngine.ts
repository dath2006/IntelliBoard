/**
 * Canvas Layout Engine
 *
 * Provides intelligent spatial services for the agent so it never has to
 * guess coordinates or compute wire waypoints manually.
 *
 * Exported surface (called from agentFrontendActions.ts):
 *   - suggestPlacements()    → where to place new components, pin-proximity aware
 *   - autoRouteWires()       → compute obstacle-free waypoints for placed wires
 *   - getCanvasSpatialContext() → full spatial snapshot of the live canvas
 */

import { calculatePinPosition, getAllPinPositions } from './pinPositionCalculator';
import { getObstacleRects, routeAroundObstacles } from './wireObstacleRouter';

// ── Shared board size table (kept in sync with wireObstacleRouter.ts) ─────────
const BOARD_SIZE: Record<string, { w: number; h: number }> = {
  'arduino-uno': { w: 274, h: 202 },
  'arduino-nano': { w: 170, h: 67 },
  'arduino-mega': { w: 388, h: 192 },
  'raspberry-pi-pico': { w: 168, h: 68 },
  'raspberry-pi-3': { w: 250, h: 160 },
  esp32: { w: 141, h: 265 },
  'esp32-s3': { w: 128, h: 350 },
  'esp32-c3': { w: 127, h: 215 },
  'pi-pico-w': { w: 105, h: 264 },
  'esp32-devkit-c-v4': { w: 140, h: 283 },
  'esp32-cam': { w: 136, h: 202 },
  'wemos-lolin32-lite': { w: 128, h: 250 },
  'xiao-esp32-s3': { w: 91, h: 117 },
  'arduino-nano-esp32': { w: 217, h: 90 },
  'xiao-esp32-c3': { w: 91, h: 117 },
  'aitewinrobot-esp32c3-supermini': { w: 90, h: 123 },
  attiny85: { w: 160, h: 100 },
};

/** Gap between the board edge and the first placed component (px) */
const BOARD_MARGIN = 40;
/** Horizontal gap between consecutive components in the same column (px) */
const COMP_GAP_X = 20;
/** Vertical gap between rows of components (px) */
const COMP_GAP_Y = 16;
/** Default component size when DOM measurement is unavailable */
const DEFAULT_COMP_W = 60;
const DEFAULT_COMP_H = 60;
/** Component wrapper CSS offset (border + padding in DynamicComponent) */
const COMP_OFFSET_X = 4;
const COMP_OFFSET_Y = 6;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BoardInfo {
  id: string;
  boardKind: string;
  x: number;
  y: number;
}

export interface ComponentInfo {
  id: string;
  metadataId: string;
  x: number;
  y: number;
}

export interface WireInfo {
  id: string;
  start: { componentId: string; pinName: string; x: number; y: number };
  end: { componentId: string; pinName: string; x: number; y: number };
  waypoints: Array<{ x: number; y: number }>;
}

export interface PlacementRequest {
  id: string;
  metadataId: string;
  /** Optional: the board pin this component will connect to (used for side selection) */
  connectsToBoardPin?: string;
  /** Optional: prefer placing on a specific side: 'right' | 'left' | 'top' | 'bottom' */
  preferSide?: 'right' | 'left' | 'top' | 'bottom';
}

export interface PlacementResult {
  id: string;
  x: number;
  y: number;
  side: 'right' | 'left' | 'top' | 'bottom';
}

export interface RouteResult {
  wireId: string;
  waypoints: Array<{ x: number; y: number }>;
  routed: boolean;
  reason?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read the rendered pixel size of a component from the DOM, with fallback. */
function getComponentSize(id: string): { w: number; h: number } {
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { w: r.width, h: r.height };
  }
  return { w: DEFAULT_COMP_W, h: DEFAULT_COMP_H };
}

/** Get board pixel size — DOM first, then static table, then generous default. */
function getBoardSize(boardKind: string, boardId: string): { w: number; h: number } {
  const el = typeof document !== 'undefined' ? document.getElementById(boardId) : null;
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { w: r.width, h: r.height };
  }
  return BOARD_SIZE[boardKind] ?? { w: 300, h: 200 };
}

/**
 * Determine which side of a board a pin exits from, using the live DOM pinInfo.
 * Falls back to 'right' when the board or pin is not found in the DOM.
 */
function getPinSideOnBoard(
  boardId: string,
  pinName: string,
  boardSize: { w: number; h: number },
): 'right' | 'left' | 'top' | 'bottom' {
  const el = typeof document !== 'undefined' ? document.getElementById(boardId) : null;
  if (!el) return 'right';
  const pinInfo: any[] = (el as any).pinInfo ?? [];
  const pin = pinInfo.find(
    (p: any) => String(p.name).toLowerCase() === String(pinName).toLowerCase(),
  );
  if (!pin) return 'right';
  const px: number = pin.x ?? 0;
  const py: number = pin.y ?? 0;
  const { w, h } = boardSize;
  const fromLeft = px;
  const fromRight = w - px;
  const fromTop = py;
  const fromBottom = h - py;
  const minDist = Math.min(fromLeft, fromRight, fromTop, fromBottom);
  if (minDist === fromRight) return 'right';
  if (minDist === fromLeft) return 'left';
  if (minDist === fromTop) return 'top';
  return 'bottom';
}

/**
 * Compute the bounding union of all currently placed components and boards
 * so the layout engine can avoid overlapping existing content.
 */
function computeOccupiedRects(
  components: ComponentInfo[],
  boards: BoardInfo[],
): Array<{ x: number; y: number; w: number; h: number }> {
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const b of boards) {
    const s = getBoardSize(b.boardKind, b.id);
    rects.push({ x: b.x, y: b.y, w: s.w, h: s.h });
  }
  for (const c of components) {
    const s = getComponentSize(c.id);
    rects.push({ x: c.x, y: c.y, w: s.w, h: s.h });
  }
  return rects;
}

/** Check whether a candidate rect overlaps any occupied rect. */
function overlapsAny(
  candidate: { x: number; y: number; w: number; h: number },
  occupied: Array<{ x: number; y: number; w: number; h: number }>,
  pad = 8,
): boolean {
  for (const r of occupied) {
    const noOverlap =
      candidate.x + candidate.w + pad <= r.x ||
      candidate.x >= r.x + r.w + pad ||
      candidate.y + candidate.h + pad <= r.y ||
      candidate.y >= r.y + r.h + pad;
    if (!noOverlap) return true;
  }
  return false;
}

/**
 * Find a free canvas position starting from (startX, startY) scanning downward
 * in rows, skipping occupied rectangles.
 */
function findFreePosition(
  startX: number,
  startY: number,
  compW: number,
  compH: number,
  occupied: Array<{ x: number; y: number; w: number; h: number }>,
): { x: number; y: number } {
  let x = startX;
  let y = startY;
  const maxAttempts = 50;
  for (let i = 0; i < maxAttempts; i++) {
    if (!overlapsAny({ x, y, w: compW, h: compH }, occupied)) {
      return { x, y };
    }
    y += compH + COMP_GAP_Y;
    if (y > startY + 800) {
      y = startY;
      x += compW + COMP_GAP_X + 20;
    }
  }
  return { x, y };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Suggest canvas positions for a batch of new components.
 *
 * Strategy:
 * 1. Identify the primary board and its pixel size.
 * 2. For each requested component, determine the preferred board side based on
 *    the connectsToBoardPin hint (or fall back to 'right').
 * 3. Assign a start anchor just outside that board edge.
 * 4. Pack components into free slots, scanning downward, skipping existing rects.
 * 5. Return {id, x, y, side} for each requested component.
 */
export function suggestPlacements(
  requests: PlacementRequest[],
  boards: BoardInfo[],
  existingComponents: ComponentInfo[],
): PlacementResult[] {
  if (boards.length === 0 || requests.length === 0) return [];

  const primaryBoard = boards[0];
  const boardSize = getBoardSize(primaryBoard.boardKind, primaryBoard.id);

  const occupied = computeOccupiedRects(existingComponents, boards);
  const results: PlacementResult[] = [];

  // Track per-side placement cursors so components on the same side stack cleanly
  const sideCursors: Record<string, { x: number; y: number }> = {
    right: {
      x: primaryBoard.x + boardSize.w + BOARD_MARGIN,
      y: primaryBoard.y,
    },
    left: {
      x: primaryBoard.x - BOARD_MARGIN - DEFAULT_COMP_W,
      y: primaryBoard.y,
    },
    top: {
      x: primaryBoard.x,
      y: primaryBoard.y - BOARD_MARGIN - DEFAULT_COMP_H,
    },
    bottom: {
      x: primaryBoard.x,
      y: primaryBoard.y + boardSize.h + BOARD_MARGIN,
    },
  };

  for (const req of requests) {
    // Determine preferred side
    let side: 'right' | 'left' | 'top' | 'bottom' = req.preferSide ?? 'right';
    if (req.connectsToBoardPin && !req.preferSide) {
      side = getPinSideOnBoard(primaryBoard.id, req.connectsToBoardPin, boardSize);
    }

    const cursor = sideCursors[side];
    const compSize = { w: DEFAULT_COMP_W, h: DEFAULT_COMP_H };

    const pos = findFreePosition(cursor.x, cursor.y, compSize.w, compSize.h, occupied);

    results.push({ id: req.id, x: pos.x, y: pos.y, side });

    // Advance cursor for this side
    if (side === 'right' || side === 'left') {
      sideCursors[side].y = pos.y + compSize.h + COMP_GAP_Y;
    } else {
      sideCursors[side].x = pos.x + compSize.w + COMP_GAP_X;
    }

    // Register this placement as occupied so the next component avoids it
    occupied.push({ x: pos.x, y: pos.y, w: compSize.w, h: compSize.h });
  }

  return results;
}

/**
 * Compute obstacle-avoiding waypoints for a list of wires using live DOM data.
 *
 * For each wire:
 * 1. Resolve the actual canvas-space pin positions using calculatePinPosition.
 * 2. Collect obstacle rects (excluding the wire's own endpoints).
 * 3. Run routeAroundObstacles() to produce clean waypoints.
 *
 * Returns waypoints in the same {x, y}[] format used by route_wire_batch.
 * An empty waypoints array means a straight L-shape is already clean.
 */
export function autoRouteWires(
  wires: WireInfo[],
  components: ComponentInfo[],
  boards: BoardInfo[],
): RouteResult[] {
  const results: RouteResult[] = [];

  for (const wire of wires) {
    // Resolve start pin position
    const startComp = components.find((c) => c.id === wire.start.componentId);
    const startBoard = boards.find((b) => b.id === wire.start.componentId);
    const startX = startComp
      ? startComp.x + COMP_OFFSET_X
      : startBoard
        ? startBoard.x
        : 0;
    const startY = startComp
      ? startComp.y + COMP_OFFSET_Y
      : startBoard
        ? startBoard.y
        : 0;
    const startPos = calculatePinPosition(
      wire.start.componentId,
      wire.start.pinName,
      startX,
      startY,
      startBoard?.boardKind,
    );

    // Resolve end pin position
    const endComp = components.find((c) => c.id === wire.end.componentId);
    const endBoard = boards.find((b) => b.id === wire.end.componentId);
    const endX = endComp ? endComp.x + COMP_OFFSET_X : endBoard ? endBoard.x : 0;
    const endY = endComp ? endComp.y + COMP_OFFSET_Y : endBoard ? endBoard.y : 0;
    const endPos = calculatePinPosition(
      wire.end.componentId,
      wire.end.pinName,
      endX,
      endY,
      endBoard?.boardKind,
    );

    if (!startPos || !endPos) {
      results.push({
        wireId: wire.id,
        waypoints: [],
        routed: false,
        reason: !startPos
          ? `Pin ${wire.start.pinName} on ${wire.start.componentId} not found in DOM`
          : `Pin ${wire.end.pinName} on ${wire.end.componentId} not found in DOM`,
      });
      continue;
    }

    const excludeIds = new Set([wire.start.componentId, wire.end.componentId]);
    const obstacles = getObstacleRects(components, boards, excludeIds);
    const waypoints = routeAroundObstacles(startPos, endPos, obstacles);

    results.push({
      wireId: wire.id,
      waypoints,
      routed: true,
    });
  }

  return results;
}

/**
 * Capture a full spatial snapshot of the live canvas.
 *
 * Returns for each entity:
 * - Canvas-space bounding box (x, y, width, height)
 * - All pin positions in canvas space (name, x, y, side)
 *
 * Also returns suggestedNextX — a safe X coordinate past all current content
 * where the agent could place new components.
 */
export function getCanvasSpatialContext(
  components: ComponentInfo[],
  boards: BoardInfo[],
): {
  boards: Array<{
    id: string;
    boardKind: string;
    x: number;
    y: number;
    width: number;
    height: number;
    pins: Array<{ name: string; canvasX: number; canvasY: number; side: string }>;
  }>;
  components: Array<{
    id: string;
    metadataId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    pins: Array<{ name: string; canvasX: number; canvasY: number; side: string }>;
  }>;
  canvasBounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    suggestedNextX: number;
    suggestedNextY: number;
  };
} {
  const boardResults = boards.map((b) => {
    const size = getBoardSize(b.boardKind, b.id);
    const el = typeof document !== 'undefined' ? document.getElementById(b.id) : null;
    const rawPins: any[] = el ? (el as any).pinInfo ?? [] : [];
    const pins = rawPins.map((p: any) => {
      const cx = b.x + (p.x ?? 0);
      const cy = b.y + (p.y ?? 0);
      const side = determinePinSide(p.x, p.y, size.w, size.h);
      return { name: String(p.name), canvasX: cx, canvasY: cy, side };
    });
    return { id: b.id, boardKind: b.boardKind, x: b.x, y: b.y, width: size.w, height: size.h, pins };
  });

  const compResults = components.map((c) => {
    const size = getComponentSize(c.id);
    const cx = c.x + COMP_OFFSET_X;
    const cy = c.y + COMP_OFFSET_Y;
    const allPins = getAllPinPositions(c.id, cx, cy);
    const el = typeof document !== 'undefined' ? document.getElementById(c.id) : null;
    const rawPins: any[] = el ? (el as any).pinInfo ?? [] : [];
    const pins = allPins.map((p, i) => {
      const raw = rawPins[i];
      const side = raw ? determinePinSide(raw.x, raw.y, size.w, size.h) : 'right';
      return { name: p.name, canvasX: p.x, canvasY: p.y, side };
    });
    return { id: c.id, metadataId: c.metadataId, x: c.x, y: c.y, width: size.w, height: size.h, pins };
  });

  // Compute bounding box of all content
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boardResults) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  for (const c of compResults) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.width);
    maxY = Math.max(maxY, c.y + c.height);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }

  return {
    boards: boardResults,
    components: compResults,
    canvasBounds: {
      minX,
      minY,
      maxX,
      maxY,
      suggestedNextX: maxX + BOARD_MARGIN,
      suggestedNextY: minY,
    },
  };
}

// ── Internal helper ───────────────────────────────────────────────────────────

function determinePinSide(
  pinX: number,
  pinY: number,
  w: number,
  h: number,
): string {
  const fromLeft = pinX;
  const fromRight = w - pinX;
  const fromTop = pinY;
  const fromBottom = h - pinY;
  const minDist = Math.min(fromLeft, fromRight, fromTop, fromBottom);
  if (minDist === fromRight) return 'right';
  if (minDist === fromLeft) return 'left';
  if (minDist === fromTop) return 'top';
  return 'bottom';
}
