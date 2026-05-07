/**
 * Memoized Component Renderer
 * Prevents unnecessary re-renders of individual components during simulation
 */

import React from 'react';
import { DynamicComponent } from '../DynamicComponent';
import { InstrumentComponent } from '../components-instruments/InstrumentComponent';
import { PinOverlay } from './PinOverlay';
import type { ComponentMetadata } from '../../types/component-metadata';

interface MemoizedComponentRendererProps {
  component: {
    id: string;
    metadataId: string;
    x: number;
    y: number;
    properties: Record<string, any>;
  };
  metadata: ComponentMetadata | null;
  isSelected: boolean;
  running: boolean;
  zoom: number;
  onMouseDown: (e: React.MouseEvent) => void;
  onPinClick: (componentId: string, pinName: string, x: number, y: number) => void;
}

const ComponentRendererInner: React.FC<MemoizedComponentRendererProps> = ({
  component,
  metadata,
  isSelected,
  running,
  zoom,
  onMouseDown,
  onPinClick,
}) => {
  // SPICE probes are React components, not web components
  if (component.metadataId === 'instr-voltmeter' || component.metadataId === 'instr-ammeter') {
    return (
      <React.Fragment key={component.id}>
        <InstrumentComponent
          id={component.id}
          metadataId={component.metadataId}
          x={component.x}
          y={component.y}
          isSelected={isSelected}
          onMouseDown={onMouseDown}
        />
        {!running && (
          <PinOverlay
            componentId={component.id}
            componentX={component.x}
            componentY={component.y}
            onPinClick={onPinClick}
            showPins={true}
            zoom={zoom}
            wrapperOffsetX={0}
            wrapperOffsetY={0}
          />
        )}
      </React.Fragment>
    );
  }

  if (!metadata) {
    console.warn(`Metadata not found for component: ${component.metadataId}`);
    return null;
  }

  return (
    <React.Fragment key={component.id}>
      <DynamicComponent
        id={component.id}
        metadata={metadata}
        properties={component.properties}
        x={component.x}
        y={component.y}
        isSelected={isSelected}
        onMouseDown={onMouseDown}
      />

      {/* Pin overlay for wire creation - hide when running */}
      {!running && (
        <PinOverlay
          componentId={component.id}
          componentX={component.x}
          componentY={component.y}
          onPinClick={onPinClick}
          showPins={true}
          zoom={zoom}
        />
      )}
    </React.Fragment>
  );
};

// Memoize to prevent re-renders when props haven't changed
export const MemoizedComponentRenderer = React.memo(
  ComponentRendererInner,
  (prev, next) => {
    // Only re-render if these specific props change
    return (
      prev.component.id === next.component.id &&
      prev.component.x === next.component.x &&
      prev.component.y === next.component.y &&
      prev.component.properties === next.component.properties &&
      prev.isSelected === next.isSelected &&
      prev.running === next.running &&
      prev.zoom === next.zoom &&
      prev.metadata?.id === next.metadata?.id
    );
  }
);
