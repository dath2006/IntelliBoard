/**
 * Wire Segment Utilities
 *
 * Handles computation and manipulation of wire segments for interactive editing.
 * Segments are the straight horizontal/vertical lines between path points.
 */

import type { Wire, WireControlPoint } from '../types/wire';

export interface WireSegment {
  id: string;
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  orientation: 'horizontal' | 'vertical';
  midPoint: { x: number; y: number };
  length: number;
  startIndex: number; // Index in orthoPoints array
  endIndex: number;   // Index in orthoPoints array
}

/**
 * Get all path points (start + control points + end)
 */
export function getPathPoints(wire: Wire): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];

  points.push({ x: wire.start.x, y: wire.start.y });

  for (const cp of wire.controlPoints) {
    points.push({ x: cp.x, y: cp.y });
  }

  points.push({ x: wire.end.x, y: wire.end.y });

  return points;
}

/**
 * Generate orthogonal path points from control points
 * Converts diagonal connections to L-shapes (horizontal then vertical or vice versa)
 */
export function generateOrthogonalPoints(
  points: Array<{ x: number; y: number }>
): Array<{ x: number; y: number }> {
  const result: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < points.length - 1; i++) {
    const current = points[i];
    const next = points[i + 1];

    result.push(current);

    // If points are not aligned, add intermediate point
    if (current.x !== next.x && current.y !== next.y) {
      const dx = Math.abs(next.x - current.x);
      const dy = Math.abs(next.y - current.y);

      if (dx > dy) {
        // Go horizontal first
        result.push({ x: next.x, y: current.y });
      } else {
        // Go vertical first
        result.push({ x: current.x, y: next.y });
      }
    }
  }

  result.push(points[points.length - 1]);

  return result;
}

/**
 * Compute all segments from a wire
 */
export function computeSegments(wire: Wire): WireSegment[] {
  const pathPoints = getPathPoints(wire);
  const orthoPoints = generateOrthogonalPoints(pathPoints);
  const segments: WireSegment[] = [];

  for (let i = 0; i < orthoPoints.length - 1; i++) {
    const start = orthoPoints[i];
    const end = orthoPoints[i + 1];

    // Skip zero-length segments
    if (start.x === end.x && start.y === end.y) continue;

    const orientation = start.y === end.y ? 'horizontal' : 'vertical';
    const length =
      orientation === 'horizontal'
        ? Math.abs(end.x - start.x)
        : Math.abs(end.y - start.y);

    segments.push({
      id: `${wire.id}-seg-${i}`,
      startPoint: start,
      endPoint: end,
      orientation,
      midPoint: {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      },
      length,
      startIndex: i,
      endIndex: i + 1,
    });
  }

  return segments;
}

/**
 * Find which segment is under the cursor
 */
export function findSegmentUnderCursor(
  segments: WireSegment[],
  mouseX: number,
  mouseY: number,
  threshold: number = 8 // 8px tolerance
): WireSegment | null {
  for (const segment of segments) {
    if (segment.orientation === 'horizontal') {
      const minX = Math.min(segment.startPoint.x, segment.endPoint.x);
      const maxX = Math.max(segment.startPoint.x, segment.endPoint.x);
      const lineY = segment.startPoint.y;

      if (
        mouseX >= minX &&
        mouseX <= maxX &&
        Math.abs(mouseY - lineY) <= threshold
      ) {
        return segment;
      }
    } else {
      const minY = Math.min(segment.startPoint.y, segment.endPoint.y);
      const maxY = Math.max(segment.startPoint.y, segment.endPoint.y);
      const lineX = segment.startPoint.x;

      if (
        mouseY >= minY &&
        mouseY <= maxY &&
        Math.abs(mouseX - lineX) <= threshold
      ) {
        return segment;
      }
    }
  }

  return null;
}

/**
 * Update orthogonal points when dragging a segment
 */
export function updateOrthogonalPointsForSegmentDrag(
  orthoPoints: Array<{ x: number; y: number }>,
  segment: WireSegment,
  offset: number
): Array<{ x: number; y: number }> {
  const newPoints = orthoPoints.map((p) => ({ ...p }));

  const { startIndex, endIndex, orientation } = segment;

  if (orientation === 'horizontal') {
    // Move horizontal segment up/down (change Y)
    newPoints[startIndex].y += offset;
    newPoints[endIndex].y += offset;
  } else {
    // Move vertical segment left/right (change X)
    newPoints[startIndex].x += offset;
    newPoints[endIndex].x += offset;
  }

  return newPoints;
}

/**
 * Convert orthogonal points back to control points
 * Removes start/end points and intermediate points that are redundant
 */
export function orthogonalPointsToControlPoints(
  orthoPoints: Array<{ x: number; y: number }>,
  start: { x: number; y: number },
  end: { x: number; y: number }
): WireControlPoint[] {
  // Remove first and last points (those are start/end endpoints)
  const innerPoints = orthoPoints.slice(1, -1);

  // Remove redundant points (those that are collinear with neighbors)
  const controlPoints: WireControlPoint[] = [];

  for (let i = 0; i < innerPoints.length; i++) {
    const current = innerPoints[i];
    const prev = i === 0 ? start : innerPoints[i - 1];
    const next = i === innerPoints.length - 1 ? end : innerPoints[i + 1];

    // Check if current point is a corner (changes direction)
    const isCorner =
      (prev.x === current.x && current.y === next.y) ||
      (prev.y === current.y && current.x === next.x);

    if (isCorner) {
      controlPoints.push({
        id: `cp-${Date.now()}-${i}`,
        x: current.x,
        y: current.y,
      });
    }
  }

  return controlPoints;
}
