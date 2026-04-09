/**
 * PinOverlay Component
 *
 * Renders clickable pin indicators over components to enable wire creation.
 * Shows when hovering over a component or when creating a wire.
 *
 * Pin markers remain compact and anchored to the real pin area at any zoom level.
 */

import React, { useEffect, useState } from "react";

/** Compact pin size in world pixels. Keep this small to avoid oversized overlays. */
const PIN_VISUAL = 8;

interface PinInfo {
  name: string;
  x: number; // CSS pixels
  y: number; // CSS pixels
  signals?: Array<{ type: string; signal?: string }>;
}

interface PinOverlayProps {
  componentId: string;
  componentX: number;
  componentY: number;
  onPinClick: (
    componentId: string,
    pinName: string,
    x: number,
    y: number,
  ) => void;
  showPins: boolean;
  /** Extra offset to compensate for wrapper padding/border. Default: 4 (x), 6 (y) for component wrappers. Pass 0 when the element has no wrapper. */
  wrapperOffsetX?: number;
  wrapperOffsetY?: number;
  /** Current canvas zoom level (kept for API compatibility). */
  zoom?: number;
}

export const PinOverlay: React.FC<PinOverlayProps> = ({
  componentId,
  componentX,
  componentY,
  onPinClick,
  showPins,
  wrapperOffsetX = 4,
  wrapperOffsetY = 6,
  zoom: _zoom = 1,
}) => {
  const [pins, setPins] = useState<PinInfo[]>([]);

  useEffect(() => {
    const tryRead = () => {
      const element = document.getElementById(componentId);
      if (element && (element as any).pinInfo) {
        setPins((element as any).pinInfo);
        return true;
      }
      return false;
    };
    if (!tryRead()) {
      // Retry once after a tick in case the element sets pinInfo asynchronously (e.g. via useEffect)
      const t = setTimeout(tryRead, 50);
      return () => clearTimeout(t);
    }
  }, [componentId]);

  if (!showPins || pins.length === 0) {
    return null;
  }

  const pinSize = PIN_VISUAL;
  const pinHalf = pinSize / 2;

  return (
    <div
      style={{
        position: "absolute",
        left: `${componentX + wrapperOffsetX}px`,
        top: `${componentY + wrapperOffsetY}px`,
        pointerEvents: "none",
        zIndex: 30, // Above wires (20) and components, below modals/dialogs (1000+)
      }}
    >
      {pins.map((pin, index) => {
        const pinX = pin.x;
        const pinY = pin.y;

        return (
          <div
            key={`${pin.name}-${index}`}
            data-pin-overlay="true"
            onClick={(e) => {
              e.stopPropagation();
              onPinClick(
                componentId,
                pin.name,
                componentX + wrapperOffsetX + pinX,
                componentY + wrapperOffsetY + pinY,
              );
            }}
            onTouchEnd={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onPinClick(
                componentId,
                pin.name,
                componentX + wrapperOffsetX + pinX,
                componentY + wrapperOffsetY + pinY,
              );
            }}
            style={{
              position: "absolute",
              left: `${pinX - pinHalf}px`,
              top: `${pinY - pinHalf}px`,
              width: `${pinSize}px`,
              height: `${pinSize}px`,
              borderRadius: "2px",
              backgroundColor: "rgba(0, 200, 255, 0.8)",
              border: "1px solid white",
              cursor: "crosshair",
              pointerEvents: "all",
              transition: "all 0.15s",
              touchAction: "none",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(0, 255, 100, 1)";
              e.currentTarget.style.transform = "scale(1.4)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "rgba(0, 200, 255, 0.8)";
              e.currentTarget.style.transform = "scale(1)";
            }}
            title={pin.name}
          />
        );
      })}
    </div>
  );
};
