import React from 'react';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { WireRenderer } from './WireRenderer';
import { WireInProgressRenderer } from './WireInProgressRenderer';
import type { Wire } from '../../types/wire';

const isTouchDevice =
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

export interface SegmentHandle {
  segIndex: number;
  axis: 'horizontal' | 'vertical';
  mx: number; // midpoint X
  my: number; // midpoint Y
}

interface WireLayerProps {
  wires: Wire[];
  hoveredWireId: string | null;
  /** Segment drag preview: overrides the path of a specific wire */
  segmentDragPreview: { wireId: string; overridePath: string } | null;
  /** Handles to render for the selected wire */
  segmentHandles: SegmentHandle[];
  /** Called when user starts dragging a handle (passes segIndex) */
  onHandleMouseDown: (e: React.MouseEvent, segIndex: number) => void;
  /** Called when user starts dragging a handle via touch (passes segIndex) */
  onHandleTouchStart?: (e: React.TouchEvent, segIndex: number) => void;
}

// Memoize WireRenderer to prevent unnecessary re-renders
const MemoizedWireRenderer = React.memo(WireRenderer, (prev, next) => {
  // Only re-render if these specific props change
  return (
    prev.wire.id === next.wire.id &&
    prev.wire.start.x === next.wire.start.x &&
    prev.wire.start.y === next.wire.start.y &&
    prev.wire.end.x === next.wire.end.x &&
    prev.wire.end.y === next.wire.end.y &&
    prev.wire.color === next.wire.color &&
    prev.wire.waypoints === next.wire.waypoints &&
    prev.isSelected === next.isSelected &&
    prev.isHovered === next.isHovered &&
    prev.overridePath === next.overridePath
  );
});

export const WireLayer: React.FC<WireLayerProps> = React.memo(({
  wires,
  hoveredWireId,
  segmentDragPreview,
  segmentHandles,
  onHandleMouseDown,
  onHandleTouchStart,
}) => {
  const wireInProgress = useSimulatorStore((s) => s.wireInProgress);
  const selectedWireId = useSimulatorStore((s) => s.selectedWireId);

  return (
    <svg
      className="wire-layer"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: 35,
      }}
    >
      {wires.map((wire) => (
        <MemoizedWireRenderer
          key={wire.id}
          wire={wire}
          isSelected={wire.id === selectedWireId}
          isHovered={wire.id === hoveredWireId}
          overridePath={
            segmentDragPreview?.wireId === wire.id ? segmentDragPreview.overridePath : undefined
          }
        />
      ))}

      {/* Segment handles for the selected wire */}
      {segmentHandles.map((handle) => (
        <circle
          key={handle.segIndex}
          cx={handle.mx}
          cy={handle.my}
          r={isTouchDevice ? 14 : 7}
          fill="white"
          stroke="#007acc"
          strokeWidth={2}
          style={{
            pointerEvents: 'all',
            cursor: handle.axis === 'horizontal' ? 'ns-resize' : 'ew-resize',
            touchAction: 'none',
          }}
          onMouseDown={(e) => onHandleMouseDown(e, handle.segIndex)}
          onTouchStart={(e) => onHandleTouchStart?.(e, handle.segIndex)}
        />
      ))}

      {wireInProgress && <WireInProgressRenderer wireInProgress={wireInProgress} />}
    </svg>
  );
}, (prev, next) => {
  // Only re-render WireLayer if wires array or selection changes
  return (
    prev.wires === next.wires &&
    prev.hoveredWireId === next.hoveredWireId &&
    prev.segmentDragPreview === next.segmentDragPreview &&
    prev.segmentHandles === next.segmentHandles
  );
});
