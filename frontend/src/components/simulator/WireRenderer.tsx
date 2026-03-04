/**
 * WireRenderer Component
 *
 * Renders wires with segment-based editing:
 * - Click to select wire
 * - Hover over segments to see drag handles
 * - Drag horizontal segments up/down
 * - Drag vertical segments left/right
 */

import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import type { Wire } from '../../types/wire';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { generateWirePath } from '../../utils/wirePathGenerator';
import {
  computeSegments,
  findSegmentUnderCursor,
  getPathPoints,
  generateOrthogonalPoints,
  updateOrthogonalPointsForSegmentDrag,
  orthogonalPointsToControlPoints,
  type WireSegment,
} from '../../utils/wireSegments';

interface WireRendererProps {
  wire: Wire;
  isSelected: boolean;
}

export const WireRenderer: React.FC<WireRendererProps> = ({ wire, isSelected }) => {
  const { setSelectedWire, updateWire } = useSimulatorStore();
  const [hoveredSegment, setHoveredSegment] = useState<WireSegment | null>(null);
  const [dragState, setDragState] = useState<{
    segment: WireSegment;
    startMousePos: { x: number; y: number };
    originalOrthoPoints: Array<{ x: number; y: number }>;
  } | null>(null);

  // Local preview path during drag (for smooth performance)
  const [previewOrthoPoints, setPreviewOrthoPoints] = useState<Array<{ x: number; y: number }> | null>(null);

  const svgRef = useRef<SVGGElement>(null);

  // Generate SVG path (memoized for performance)
  // Use preview points during drag, actual wire points otherwise
  const path = useMemo(() => {
    if (previewOrthoPoints) {
      // Generate path from preview points during drag
      let pathD = `M ${previewOrthoPoints[0].x} ${previewOrthoPoints[0].y}`;
      for (let i = 1; i < previewOrthoPoints.length; i++) {
        pathD += ` L ${previewOrthoPoints[i].x} ${previewOrthoPoints[i].y}`;
      }
      return pathD;
    }
    return generateWirePath(wire);
  }, [wire, previewOrthoPoints]);

  // Compute segments (memoized)
  const segments = useMemo(() => {
    return computeSegments(wire);
  }, [wire]);

  // Handle wire selection
  const handleWireClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setSelectedWire(wire.id);
    },
    [wire.id, setSelectedWire]
  );

  // Handle segment hover
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragState) {
        // Handle dragging - use local state for smooth updates
        const svg = svgRef.current?.ownerSVGElement;
        if (!svg) return;

        const svgRect = svg.getBoundingClientRect();
        const mouseX = e.clientX - svgRect.left;
        const mouseY = e.clientY - svgRect.top;

        const { segment, startMousePos, originalOrthoPoints } = dragState;

        // Calculate offset perpendicular to segment
        let offset = 0;
        if (segment.orientation === 'horizontal') {
          offset = mouseY - startMousePos.y;
        } else {
          offset = mouseX - startMousePos.x;
        }

        // No grid snapping during drag for smooth movement
        // Grid snapping will be applied on mouse up

        // Update orthogonal points (local preview)
        const newOrthoPoints = updateOrthogonalPointsForSegmentDrag(
          originalOrthoPoints,
          segment,
          offset
        );

        // Update preview state (doesn't touch the store)
        setPreviewOrthoPoints(newOrthoPoints);
      } else if (isSelected) {
        // Update hovered segment
        const svg = svgRef.current?.ownerSVGElement;
        if (!svg) return;

        const svgRect = svg.getBoundingClientRect();
        const mouseX = e.clientX - svgRect.left;
        const mouseY = e.clientY - svgRect.top;

        const segment = findSegmentUnderCursor(segments, mouseX, mouseY);
        setHoveredSegment(segment);
      }
    },
    [dragState, isSelected, segments, wire, updateWire]
  );

  const handleSegmentMouseDown = useCallback(
    (segment: WireSegment, e: React.MouseEvent) => {
      e.stopPropagation();

      const svg = svgRef.current?.ownerSVGElement;
      if (!svg) return;

      const svgRect = svg.getBoundingClientRect();
      const mouseX = e.clientX - svgRect.left;
      const mouseY = e.clientY - svgRect.top;

      // Get current orthogonal points
      const pathPoints = getPathPoints(wire);
      const orthoPoints = generateOrthogonalPoints(pathPoints);

      setDragState({
        segment,
        startMousePos: { x: mouseX, y: mouseY },
        originalOrthoPoints: orthoPoints,
      });
    },
    [wire]
  );

  const handleMouseUp = useCallback(() => {
    if (dragState && previewOrthoPoints) {
      // Apply grid snapping to final position
      const GRID_SIZE = 20;
      const snappedPoints = previewOrthoPoints.map((p) => ({
        x: Math.round(p.x / GRID_SIZE) * GRID_SIZE,
        y: Math.round(p.y / GRID_SIZE) * GRID_SIZE,
      }));

      // Convert back to control points
      const newControlPoints = orthogonalPointsToControlPoints(
        snappedPoints,
        wire.start,
        wire.end
      );

      // Update store only once at the end
      updateWire(wire.id, { controlPoints: newControlPoints });
    }

    // Clear drag state and preview
    setDragState(null);
    setPreviewOrthoPoints(null);
  }, [dragState, previewOrthoPoints, wire, updateWire]);

  const handleMouseLeave = useCallback(() => {
    if (!dragState) {
      setHoveredSegment(null);
    }
  }, [dragState]);

  // Update cursor based on hovered segment
  useEffect(() => {
    const svg = svgRef.current?.ownerSVGElement;
    if (!svg) return;

    if (dragState) {
      svg.style.cursor =
        dragState.segment.orientation === 'horizontal' ? 'ns-resize' : 'ew-resize';
    } else if (hoveredSegment) {
      svg.style.cursor =
        hoveredSegment.orientation === 'horizontal' ? 'ns-resize' : 'ew-resize';
    } else {
      svg.style.cursor = 'pointer';
    }
  }, [hoveredSegment, dragState]);

  return (
    <g
      ref={svgRef}
      className="wire-group"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    >
      {/* Invisible thick path for easier clicking */}
      <path
        d={path}
        stroke="transparent"
        strokeWidth="10"
        fill="none"
        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        onClick={handleWireClick}
      />

      {/* Visible wire path */}
      <path
        d={path}
        stroke={wire.isValid ? wire.color : '#ff4444'}
        strokeWidth={isSelected ? '3' : '2'}
        fill="none"
        strokeDasharray={wire.isValid ? undefined : '5,5'}
        style={{ pointerEvents: 'none' }}
        opacity={isSelected ? '1' : '0.8'}
      />

      {/* Endpoint markers */}
      <circle
        cx={wire.start.x}
        cy={wire.start.y}
        r="3"
        fill={wire.color}
        style={{ pointerEvents: 'none' }}
      />
      <circle cx={wire.end.x} cy={wire.end.y} r="3" fill={wire.color} style={{ pointerEvents: 'none' }} />

      {/* Selection indicator */}
      {isSelected && (
        <path
          d={path}
          stroke="#00ffff"
          strokeWidth="3"
          fill="none"
          strokeDasharray="10,5"
          opacity="0.6"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Segment interaction overlays - only when selected */}
      {isSelected &&
        segments.map((segment) => (
          <g key={segment.id}>
            {/* Invisible thick hitbox for easier interaction */}
            <line
              x1={segment.startPoint.x}
              y1={segment.startPoint.y}
              x2={segment.endPoint.x}
              y2={segment.endPoint.y}
              stroke="transparent"
              strokeWidth="16"
              style={{
                cursor:
                  segment.orientation === 'horizontal' ? 'ns-resize' : 'ew-resize',
                pointerEvents: 'stroke',
              }}
              onMouseDown={(e) => handleSegmentMouseDown(segment, e)}
            />

            {/* Visual drag handle at midpoint when hovering */}
            {(hoveredSegment?.id === segment.id || dragState?.segment.id === segment.id) && (
              <>
                {/* Highlight the segment */}
                <line
                  x1={segment.startPoint.x}
                  y1={segment.startPoint.y}
                  x2={segment.endPoint.x}
                  y2={segment.endPoint.y}
                  stroke="#a78bfa"
                  strokeWidth="4"
                  style={{ pointerEvents: 'none' }}
                  opacity="0.8"
                />

                {/* Drag handle circle */}
                <circle
                  cx={segment.midPoint.x}
                  cy={segment.midPoint.y}
                  r="5"
                  fill="#8b5cf6"
                  stroke="white"
                  strokeWidth="2"
                  style={{ pointerEvents: 'none' }}
                />
              </>
            )}
          </g>
        ))}
    </g>
  );
};
