/**
 * Wire Obstacle Router
 *
 * Routes orthogonal wires around component and board bounding boxes so that
 * wires never pass through component bodies or over unrelated pins.
 *
 * Algorithm:
 * 1. Collect axis-aligned bounding rectangles (with padding) of every
 *    component and board on the canvas, *excluding* the two components a
 *    wire connects to.
 * 2. Generate a default orthogonal (L-shape or Z-shape) path.
 * 3. Check each segment for intersection with obstacle rectangles.
 * 4. If an intersection is found, reroute along the obstacle edge + padding.
 */

import type { Wire } from '../types/wire';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Clearance in pixels between a wire and an obstacle edge */
const OBSTACLE_PADDING = 12;

// ── Board sizes (imported from BoardOnCanvas at build time is circular,
//    so we duplicate the lookup here — kept in sync manually) ──────────────
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

// ── Obstacle collection ──────────────────────────────────────────────────────

/**
 * Collect bounding rectangles of every component and board on the canvas.
 *
 * We exclude the two endpoint components of the wire so the wire is allowed
 * to touch them (it must reach its pins).
 */
export function getObstacleRects(
  components: Array<{ id: string; metadataId: string; x: number; y: number }>,
  boards: Array<{ id: string; boardKind: string; x: number; y: number }>,
  excludeIds: Set<string>,
): Rect[] {
  const rects: Rect[] = [];

  // Board bounding boxes
  for (const board of boards) {
    if (excludeIds.has(board.id)) continue;
    const size = BOARD_SIZE[board.boardKind] ?? { w: 300, h: 200 };
    rects.push({ x: board.x, y: board.y, w: size.w, h: size.h });
  }

  // Component bounding boxes — we measure from the DOM if available,
  // otherwise fall back to a generous default
  for (const comp of components) {
    if (excludeIds.has(comp.id)) continue;
    const el = typeof document !== 'undefined' ? document.getElementById(comp.id) : null;
    let w = 60;
    let h = 60;
    if (el) {
      const r = el.getBoundingClientRect();
      // getBoundingClientRect gives screen pixels; we need canvas-space.
      // Components are positioned with position:absolute at comp.x, comp.y,
      // so we can use the natural element size.
      w = r.width || 60;
      h = r.height || 60;
    }
    rects.push({ x: comp.x, y: comp.y, w, h });
  }

  return rects;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** Expand a rect by `pad` on every side */
function inflateRect(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

/** Does the axis-aligned segment from p1→p2 intersect the rectangle? */
function segmentIntersectsRect(p1: Point, p2: Point, rect: Rect): boolean {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  const rLeft = rect.x;
  const rRight = rect.x + rect.w;
  const rTop = rect.y;
  const rBottom = rect.y + rect.h;

  // No overlap at all → no intersection
  if (maxX <= rLeft || minX >= rRight || maxY <= rTop || minY >= rBottom) {
    return false;
  }

  return true;
}

// ── Routing ──────────────────────────────────────────────────────────────────

/**
 * Route an orthogonal wire path from `start` to `end`, avoiding all
 * obstacle rectangles.
 *
 * Returns an array of intermediate waypoints (excluding start and end).
 *
 * Strategy:
 * 1. Try the basic L-shape (horizontal-first then vertical, or vice versa).
 * 2. If any segment of the L-shape intersects an obstacle, compute a
 *    U-shape detour around it.
 * 3. The detour hugs the nearest obstacle edge + padding.
 */
export function routeAroundObstacles(
  start: Point,
  end: Point,
  obstacles: Rect[],
): Point[] {
  // Pad all obstacles
  const padded = obstacles.map((r) => inflateRect(r, OBSTACLE_PADDING));

  // Try horizontal-first L-shape: start → (end.x, start.y) → end
  const cornerH: Point = { x: end.x, y: start.y };
  const seg1H_ok = !padded.some((r) => segmentIntersectsRect(start, cornerH, r));
  const seg2H_ok = !padded.some((r) => segmentIntersectsRect(cornerH, end, r));

  if (seg1H_ok && seg2H_ok) {
    // Simple L works — no extra waypoints needed (the renderer already
    // generates L-shapes implicitly)
    return [];
  }

  // Try vertical-first L-shape: start → (start.x, end.y) → end
  const cornerV: Point = { x: start.x, y: end.y };
  const seg1V_ok = !padded.some((r) => segmentIntersectsRect(start, cornerV, r));
  const seg2V_ok = !padded.some((r) => segmentIntersectsRect(cornerV, end, r));

  if (seg1V_ok && seg2V_ok) {
    // Vertical-first L works — add corner as explicit waypoint so the
    // renderer uses it instead of the default horizontal-first shape
    return [cornerV];
  }

  // Neither simple L works — find the blocking obstacles and route around
  // Try U-shape detour: go around the obstructing rectangle(s)
  return computeDetour(start, end, padded);
}

/**
 * Compute a U-shape or Z-shape detour around obstacles.
 *
 * We find the first obstacle blocking the path and route along its nearest
 * edge, trying all 4 possible detour directions (above, below, left, right)
 * and picking the shortest valid one.
 */
function computeDetour(start: Point, end: Point, paddedObstacles: Rect[]): Point[] {
  // Find the primary blocking obstacle (first one hit by horizontal-first L)
  const cornerH: Point = { x: end.x, y: start.y };

  let blockingRect: Rect | null = null;
  for (const r of paddedObstacles) {
    if (segmentIntersectsRect(start, cornerH, r) || segmentIntersectsRect(cornerH, end, r)) {
      blockingRect = r;
      break;
    }
  }

  if (!blockingRect) {
    // Shouldn't happen, but fall back to empty (let default L render)
    return [];
  }

  const br = blockingRect;

  // Try 4 detour routes around the blocking rectangle and pick the first
  // that doesn't intersect any other obstacle. Each route is a set of
  // 3 waypoints forming a U-shape or Z-shape.

  const candidates: Point[][] = [];

  // Route above the obstacle
  const aboveY = br.y - 2;
  candidates.push([
    { x: start.x, y: aboveY },
    { x: end.x, y: aboveY },
  ]);

  // Route below the obstacle
  const belowY = br.y + br.h + 2;
  candidates.push([
    { x: start.x, y: belowY },
    { x: end.x, y: belowY },
  ]);

  // Route left of the obstacle
  const leftX = br.x - 2;
  candidates.push([
    { x: leftX, y: start.y },
    { x: leftX, y: end.y },
  ]);

  // Route right of the obstacle
  const rightX = br.x + br.w + 2;
  candidates.push([
    { x: rightX, y: start.y },
    { x: rightX, y: end.y },
  ]);

  // Score each candidate by total path length and whether it's intersection-free
  let bestRoute: Point[] = [];
  let bestScore = Infinity;

  for (const route of candidates) {
    // Check all segments of the full path: start → wp[0] → wp[1] → end
    const fullPath = [start, ...route, end];
    let intersects = false;

    for (let i = 0; i < fullPath.length - 1; i++) {
      for (const r of paddedObstacles) {
        if (segmentIntersectsRect(fullPath[i], fullPath[i + 1], r)) {
          intersects = true;
          break;
        }
      }
      if (intersects) break;
    }

    if (intersects) continue;

    // Calculate path length
    let length = 0;
    for (let i = 0; i < fullPath.length - 1; i++) {
      length += Math.abs(fullPath[i + 1].x - fullPath[i].x) + Math.abs(fullPath[i + 1].y - fullPath[i].y);
    }

    if (length < bestScore) {
      bestScore = length;
      bestRoute = route;
    }
  }

  return bestRoute;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Apply obstacle-aware routing to a wire.
 *
 * This replaces the wire's waypoints with new ones that avoid all obstacles.
 * Only applies when the wire has no user-defined waypoints (i.e., a simple
 * pin-to-pin connection). Wires with manual waypoints are left as-is to
 * respect user intent.
 */
export function routeWireAroundObstacles(
  wire: Wire,
  components: Array<{ id: string; metadataId: string; x: number; y: number }>,
  boards: Array<{ id: string; boardKind: string; x: number; y: number }>,
): Wire {
  // Only auto-route wires that have no user waypoints
  if (wire.waypoints && wire.waypoints.length > 0) {
    return wire;
  }

  // Exclude the components this wire connects to
  const excludeIds = new Set([wire.start.componentId, wire.end.componentId]);

  const obstacles = getObstacleRects(components, boards, excludeIds);

  if (obstacles.length === 0) {
    return wire;
  }

  const startPt: Point = { x: wire.start.x, y: wire.start.y };
  const endPt: Point = { x: wire.end.x, y: wire.end.y };

  // Skip if coordinates are not resolved yet
  if (!startPt.x && !startPt.y) return wire;
  if (!endPt.x && !endPt.y) return wire;

  const waypoints = routeAroundObstacles(startPt, endPt, obstacles);

  if (waypoints.length === 0) {
    return wire;
  }

  return {
    ...wire,
    waypoints,
  };
}
