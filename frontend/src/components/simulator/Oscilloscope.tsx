/**
 * Oscilloscope / Logic Analyzer panel.
 *
 * Captures digital pin HIGH/LOW transitions (with timestamps from the CPU
 * cycle counter) and renders them as step waveforms on a <canvas>.
 *
 * Usage:
 *  - Click "+ Add Channel" to pick pins to monitor.
 *  - Adjust Time/div to zoom in or out.
 *  - Click Run / Pause to freeze the display without stopping the simulation.
 *  - Click Clear to wipe all captured samples.
 */

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  useLayoutEffect,
} from 'react';
import { useOscilloscopeStore, type OscChannel, type OscSample } from '../../store/useOscilloscopeStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import './Oscilloscope.css';

// Horizontal divisions shown at once
const NUM_DIVS = 10;

/** Time/div options shown in the selector */
const TIME_DIV_OPTIONS: { label: string; ms: number }[] = [
  { label: '0.1 ms', ms: 0.1 },
  { label: '0.5 ms', ms: 0.5 },
  { label: '1 ms',   ms: 1 },
  { label: '5 ms',   ms: 5 },
  { label: '10 ms',  ms: 10 },
  { label: '50 ms',  ms: 50 },
  { label: '100 ms', ms: 100 },
  { label: '500 ms', ms: 500 },
];

/** Possible digital pins to monitor (Uno/Nano layout) */
const AVAILABLE_PINS = [
  { pin: 0,  label: 'D0'  },
  { pin: 1,  label: 'D1'  },
  { pin: 2,  label: 'D2'  },
  { pin: 3,  label: 'D3'  },
  { pin: 4,  label: 'D4'  },
  { pin: 5,  label: 'D5'  },
  { pin: 6,  label: 'D6'  },
  { pin: 7,  label: 'D7'  },
  { pin: 8,  label: 'D8'  },
  { pin: 9,  label: 'D9'  },
  { pin: 10, label: 'D10' },
  { pin: 11, label: 'D11' },
  { pin: 12, label: 'D12' },
  { pin: 13, label: 'D13' },
  { pin: 14, label: 'A0'  },
  { pin: 15, label: 'A1'  },
  { pin: 16, label: 'A2'  },
  { pin: 17, label: 'A3'  },
  { pin: 18, label: 'A4'  },
  { pin: 19, label: 'A5'  },
];

// ── Canvas rendering helpers ────────────────────────────────────────────────

/**
 * Draw a single channel's waveform onto `canvas`.
 * @param samples  The sample ring-buffer for this channel.
 * @param color    Stroke color (CSS string).
 * @param windowEndMs  Right edge of the time window.
 * @param windowMs     Total time window width (NUM_DIVS * timeDivMs).
 */
function drawWaveform(
  canvas: HTMLCanvasElement,
  samples: OscSample[],
  color: string,
  windowEndMs: number,
  windowMs: number,
): void {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);

  // Background grid lines
  ctx.strokeStyle = '#1e1e1e';
  ctx.lineWidth = 1;
  for (let d = 0; d <= NUM_DIVS; d++) {
    const x = Math.round((d / NUM_DIVS) * width);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // Horizontal center guide
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  if (samples.length === 0) return;

  const windowStartMs = windowEndMs - windowMs;

  // Convert timeMs → canvas x pixel
  const toX = (t: number) => ((t - windowStartMs) / windowMs) * width;

  const HIGH_Y = Math.round(height * 0.15);
  const LOW_Y  = Math.round(height * 0.85);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  // Find the last sample before the window to establish the initial state
  let initState = false;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].timeMs <= windowStartMs) {
      initState = samples[i].state;
      break;
    }
  }

  let currentY = initState ? HIGH_Y : LOW_Y;
  ctx.moveTo(0, currentY);

  for (const s of samples) {
    if (s.timeMs < windowStartMs) continue;
    if (s.timeMs > windowEndMs) break;

    const x = Math.max(0, Math.min(width, toX(s.timeMs)));
    const nextY = s.state ? HIGH_Y : LOW_Y;

    // Vertical step
    ctx.lineTo(x, currentY);
    ctx.lineTo(x, nextY);
    currentY = nextY;
  }

  // Extend to the right edge
  ctx.lineTo(width, currentY);
  ctx.stroke();

  // HIGH / LOW labels at the right margin
  ctx.fillStyle = color;
  ctx.font = '9px monospace';
  ctx.fillText('H', width - 12, HIGH_Y + 3);
  ctx.fillText('L', width - 12, LOW_Y + 3);
}

/**
 * Draw the time-axis ruler below all the channels.
 */
function drawRuler(
  canvas: HTMLCanvasElement,
  windowEndMs: number,
  windowMs: number,
  timeDivMs: number,
): void {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#444';
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  ctx.lineWidth = 1;

  const windowStartMs = windowEndMs - windowMs;

  for (let d = 0; d <= NUM_DIVS; d++) {
    const timeAtDiv = windowStartMs + d * timeDivMs;
    const x = Math.round((d / NUM_DIVS) * width);

    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 5);
    ctx.stroke();

    // Format the label
    const absMs = Math.abs(timeAtDiv);
    const label = absMs >= 1000
      ? `${(timeAtDiv / 1000).toFixed(1)}s`
      : `${timeAtDiv.toFixed(absMs < 1 ? 2 : 1)}ms`;

    if (d < NUM_DIVS) {
      ctx.fillText(label, x + 2, height - 3);
    }
  }
}

// ── Channel canvas hook ─────────────────────────────────────────────────────

interface ChannelCanvasProps {
  channel: OscChannel;
  samples: OscSample[];
  windowEndMs: number;
  windowMs: number;
}

const ChannelCanvas: React.FC<ChannelCanvasProps> = ({
  channel,
  samples,
  windowEndMs,
  windowMs,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef  = useRef<HTMLDivElement>(null);

  // Re-draw whenever data or sizing changes
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const { width, height } = wrap.getBoundingClientRect();
    if (width === 0 || height === 0) return;

    canvas.width = Math.floor(width) * window.devicePixelRatio;
    canvas.height = Math.floor(height) * window.devicePixelRatio;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    drawWaveform(canvas, samples, channel.color, windowEndMs, windowMs);
    // Intentionally exclude canvasRef/wrapRef (stable refs) and the
    // module-level drawWaveform function from the dependency array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, channel.color, windowEndMs, windowMs]);

  return (
    <div ref={wrapRef} className="osc-channel-canvas-wrap">
      <canvas ref={canvasRef} className="osc-channel-canvas" />
    </div>
  );
};

// ── Ruler canvas ─────────────────────────────────────────────────────────────

interface RulerCanvasProps {
  windowEndMs: number;
  windowMs: number;
  timeDivMs: number;
}

const RulerCanvas: React.FC<RulerCanvasProps> = ({ windowEndMs, windowMs, timeDivMs }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const { width, height } = wrap.getBoundingClientRect();
    if (width === 0 || height === 0) return;

    canvas.width = Math.floor(width) * window.devicePixelRatio;
    canvas.height = Math.floor(height) * window.devicePixelRatio;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    drawRuler(canvas, windowEndMs, windowMs, timeDivMs);
    // Intentionally exclude stable canvasRef/wrapRef and module-level drawRuler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowEndMs, windowMs, timeDivMs]);

  return (
    <div ref={wrapRef} className="osc-ruler">
      <canvas ref={canvasRef} className="osc-ruler-canvas" />
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────

export const Oscilloscope: React.FC = () => {
  const {
    running: capturing,
    timeDivMs,
    channels,
    samples,
    setCapturing,
    setTimeDivMs,
    addChannel,
    removeChannel,
    clearSamples,
  } = useOscilloscopeStore();

  const simRunning = useSimulatorStore((s) => s.running);

  const [showPicker, setShowPicker] = useState(false);
  const pickerRef  = useRef<HTMLDivElement>(null);

  // Close picker when clicking outside
  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPicker]);

  // ── Compute the display window ──────────────────────────────────────────
  //
  // We show the last (NUM_DIVS * timeDivMs) ms of captured data.
  // windowEndMs = latest sample time across all channels (or 0 if none).

  const [, forceRedraw] = useState(0);

  // Poll at 60 fps while simulation + capture are running
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (simRunning && capturing) {
      const tick = () => {
        forceRedraw((n) => n + 1);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      };
    }
  }, [simRunning, capturing]);

  const windowMs = NUM_DIVS * timeDivMs;

  // Find the latest sample time to anchor the right edge of the window
  let windowEndMs = 0;
  for (const ch of channels) {
    const buf = samples[ch.id] ?? [];
    if (buf.length > 0) {
      windowEndMs = Math.max(windowEndMs, buf[buf.length - 1].timeMs);
    }
  }
  // Always advance at least one window ahead so the display isn't stale
  windowEndMs = Math.max(windowEndMs, windowMs);

  const handleAddChannel = useCallback((pin: number) => {
    addChannel(pin);
    setShowPicker(false);
  }, [addChannel]);

  const activePins = new Set(channels.map((c) => c.pin));

  return (
    <div className="osc-container">
      {/* ── Header ── */}
      <div className="osc-header">
        <span className="osc-title">Oscilloscope</span>

        {/* Add Channel button + dropdown */}
        <div className="osc-picker-wrap" ref={pickerRef}>
          <button
            className="osc-btn"
            onClick={() => setShowPicker((v) => !v)}
            title="Add a pin channel"
          >
            + Add Channel
          </button>

          {showPicker && (
            <div className="osc-picker-dropdown">
              {AVAILABLE_PINS.map(({ pin, label }) => (
                <button
                  key={pin}
                  className={`osc-pin-btn${activePins.has(pin) ? ' osc-pin-btn-active' : ''}`}
                  onClick={() => !activePins.has(pin) && handleAddChannel(pin)}
                  title={activePins.has(pin) ? 'Already added' : `Monitor ${label}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Time / div */}
        <span className="osc-label">Time/div:</span>
        <select
          className="osc-select"
          value={timeDivMs}
          onChange={(e) => setTimeDivMs(Number(e.target.value))}
        >
          {TIME_DIV_OPTIONS.map(({ label, ms }) => (
            <option key={ms} value={ms}>{label}</option>
          ))}
        </select>

        {/* Run / Pause */}
        <button
          className={`osc-btn${capturing ? '' : ' osc-btn-active'}`}
          onClick={() => setCapturing(!capturing)}
          title={capturing ? 'Pause capture' : 'Resume capture'}
        >
          {capturing ? '⏸ Pause' : '▶ Run'}
        </button>

        {/* Clear */}
        <button
          className="osc-btn osc-btn-danger"
          onClick={clearSamples}
          title="Clear all captured samples"
        >
          Clear
        </button>
      </div>

      {/* ── Waveforms ── */}
      {channels.length === 0 ? (
        <div className="osc-empty">
          <span>No channels added.</span>
          <span style={{ color: '#777' }}>Click &quot;+ Add Channel&quot; to monitor a pin.</span>
        </div>
      ) : (
        <>
          <div className="osc-waveforms">
            {channels.map((ch) => (
              <div key={ch.id} className="osc-channel-row">
                {/* Label + remove button */}
                <div className="osc-channel-label">
                  <span className="osc-channel-name" style={{ color: ch.color }}>
                    {ch.label}
                  </span>
                  <button
                    className="osc-channel-remove"
                    onClick={() => removeChannel(ch.id)}
                    title={`Remove ${ch.label}`}
                  >
                    ×
                  </button>
                </div>

                {/* Waveform canvas */}
                <ChannelCanvas
                  channel={ch}
                  samples={samples[ch.id] ?? []}
                  windowEndMs={windowEndMs}
                  windowMs={windowMs}
                />
              </div>
            ))}
          </div>

          {/* Time ruler */}
          <RulerCanvas
            windowEndMs={windowEndMs}
            windowMs={windowMs}
            timeDivMs={timeDivMs}
          />
        </>
      )}
    </div>
  );
};
