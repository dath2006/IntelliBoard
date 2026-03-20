/**
 * Dynamic Component Renderer
 *
 * Generic component that renders any wokwi-element web component dynamically.
 * Replaces individual React wrapper components (LED.tsx, Resistor.tsx, etc.)
 *
 * Features:
 * - Creates web component from metadata
 * - Syncs React props to web component properties
 * - Extracts pinInfo from DOM for wire connections
 * - Handles component lifecycle
 */

import React, { useRef, useEffect, useCallback } from 'react';
import type { ComponentMetadata } from '../types/component-metadata';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { PartSimulationRegistry } from '../simulation/parts';
import { isBoardComponent, boardPinToNumber } from '../utils/boardPinMapping';

interface DynamicComponentProps {
  id: string;
  metadata: ComponentMetadata;
  properties: Record<string, any>;
  x?: number;
  y?: number;
  isSelected?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onPinInfoReady?: (pinInfo: any[]) => void;
}

export const DynamicComponent: React.FC<DynamicComponentProps> = ({
  id,
  metadata,
  properties,
  x = 0,
  y = 0,
  isSelected = false,
  onMouseDown,
  onDoubleClick,
  onMouseEnter,
  onMouseLeave,
  onPinInfoReady,
}) => {
  const elementRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);

  const handleComponentEvent = useSimulatorStore((s) => s.handleComponentEvent);
  const running = useSimulatorStore((s) => s.running);
  const simulator = useSimulatorStore((s) => s.simulator);
  // hexEpoch increments each time a new hex is loaded, triggering a fresh
  // attachEvents call (and re-registration of I2C devices on the new bus).
  // We intentionally do NOT depend on `running` so that I2C displays and
  // other protocol parts (SSD1306, DS1307 …) are NOT torn down and
  // re-created on every stop/play cycle — which previously caused the
  // display to flash blank and lose its frame buffer.
  const hexEpoch = useSimulatorStore((s) => s.hexEpoch);

  // Check if component is interactive (has simulation logic with attachEvents)
  const logic = PartSimulationRegistry.get(metadata.id || id.split('-')[0]);
  const isInteractive = logic?.attachEvents !== undefined;

  /**
   * Sync React properties to Web Component
   */
  useEffect(() => {
    if (!elementRef.current) return;

    Object.entries(properties).forEach(([key, value]) => {
      try {
        (elementRef.current as any)[key] = value;
      } catch (error) {
        console.warn(`Failed to set property ${key} on ${metadata.tagName}:`, error);
      }
    });
  }, [properties, metadata.tagName]);

  /**
   * Extract pinInfo from web component after it initializes
   */
  useEffect(() => {
    if (!elementRef.current || !onPinInfoReady) return;

    // Wait for web component to fully initialize
    const checkPinInfo = () => {
      try {
        const pinInfo = (elementRef.current as any)?.pinInfo;
        if (pinInfo && Array.isArray(pinInfo) && pinInfo.length > 0) {
          onPinInfoReady(pinInfo);
          return true;
        }
      } catch {
        // Element not ready yet
      }
      return false;
    };

    // Try immediately
    if (checkPinInfo()) return;

    // Otherwise poll every 100ms for up to 2 seconds
    const interval = setInterval(() => {
      if (checkPinInfo()) {
        clearInterval(interval);
      }
    }, 100);

    const timeout = setTimeout(() => {
      clearInterval(interval);
    }, 2000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [onPinInfoReady]);

  /**
   * Handle mouse events
   */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (onMouseDown) {
        e.stopPropagation();
        onMouseDown(e);
      }
    },
    [onMouseDown]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (onDoubleClick) {
        e.stopPropagation();
        onDoubleClick(e);
      }
    },
    [onDoubleClick]
  );

  /**
   * Mount web component (only once)
   */
  useEffect(() => {
    if (!containerRef.current) return;

    // Prevent double-mount in React StrictMode
    if (mountedRef.current) {
      return;
    }

    const element = document.createElement(metadata.tagName);
    element.id = id;

    // Set initial properties
    Object.entries(properties).forEach(([key, value]) => {
      try {
        (element as any)[key] = value;
      } catch (error) {
        console.warn(`Failed to set initial property ${key}:`, error);
      }
    });

    containerRef.current.appendChild(element);
    elementRef.current = element;
    mountedRef.current = true;

    return () => {
      if (containerRef.current && element.parentNode === containerRef.current) {
        containerRef.current.removeChild(element);
      }
      elementRef.current = null;
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadata.tagName, id]); // Only re-create if tagName or id changes

  /**
   * Attach component-specific DOM events (like button presses)
   */
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    const onButtonPress = (e: Event) => handleComponentEvent(id, 'button-press', e);
    const onButtonRelease = (e: Event) => handleComponentEvent(id, 'button-release', e);

    el.addEventListener('button-press', onButtonPress);
    el.addEventListener('button-release', onButtonRelease);

    const logic = PartSimulationRegistry.get(metadata.id || id.split('-')[0]);

    let cleanupSimulationEvents: (() => void) | undefined;
    if (logic && logic.attachEvents && simulator) {
      // Helper to find Arduino pin connected to a component pin
      const getArduinoPin = (componentPinName: string): number | null => {
        const state = useSimulatorStore.getState();
        const wires = state.wires.filter(
          w => (w.start.componentId === id && w.start.pinName === componentPinName) ||
            (w.end.componentId === id && w.end.pinName === componentPinName)
        );

        for (const w of wires) {
          // Find which endpoint connects to a board component
          const boardEndpoint = isBoardComponent(w.start.componentId) ? w.start :
            isBoardComponent(w.end.componentId) ? w.end : null;
          if (boardEndpoint) {
            // Use the board's actual kind for pin mapping (instance ID may differ from kind,
            // e.g. board ID 'arduino-uno' after switching to 'raspberry-pi-pico')
            const boardKind = state.boards.find((b) => b.id === boardEndpoint.componentId)?.boardKind
              ?? boardEndpoint.componentId;
            const pin = boardPinToNumber(boardKind, boardEndpoint.pinName);
            if (pin !== null) return pin;
          }
        }
        return null;
      };

      cleanupSimulationEvents = logic.attachEvents(el, simulator, getArduinoPin, id);
    }

    return () => {
      if (cleanupSimulationEvents) cleanupSimulationEvents();

      el.removeEventListener('button-press', onButtonPress);
      el.removeEventListener('button-release', onButtonRelease);
    };
  }, [id, handleComponentEvent, metadata.id, simulator, hexEpoch]);

  return (
    <div
      className="dynamic-component-wrapper"
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        cursor: running && isInteractive ? 'pointer' : 'move',
        border: isSelected ? '2px dashed #007acc' : '2px solid transparent',
        borderRadius: '4px',
        padding: '4px',
        userSelect: 'none',
        zIndex: isSelected ? 5 : 1,
        pointerEvents: 'auto',
        transform: properties.rotation ? `rotate(${properties.rotation}deg)` : undefined,
        transformOrigin: 'center center',
      }}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-component-id={id}
      data-component-type={metadata.id}
    >
      {/* Container for web component */}
      <div ref={containerRef} className="web-component-container" />

      {/* Component label */}
      <div
        className="component-label"
        style={{
          fontSize: '11px',
          textAlign: 'center',
          marginTop: '4px',
          color: '#666',
          pointerEvents: 'none',
        }}
      >
        {properties.pin !== undefined
          ? `Pin ${properties.pin}`
          : metadata.name}
      </div>
    </div>
  );
};

/**
 * Helper function to create a component instance from metadata
 */
export function createComponentFromMetadata(
  metadata: ComponentMetadata,
  x: number,
  y: number
): {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, any>;
} {
  return {
    id: `${metadata.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    metadataId: metadata.id,
    x,
    y,
    properties: { ...metadata.defaultValues },
  };
}
