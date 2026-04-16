/**
 * Floating SVG overlay that renders voltage labels at wire midpoints.
 * Only visible when electrical mode is active. Reads voltages from
 * `useElectricalStore.nodeVoltages` (updated by the scheduler) and maps
 * wires to nets via `buildWireNetMap`.
 *
 * This is a read-only, zero-interactivity layer — it sits ABOVE the wire
 * layer but below the component layer so labels remain legible without
 * blocking clicks.
 */
import { useMemo } from 'react';
import { useElectricalStore } from '../../store/useElectricalStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { buildWireNetMap } from '../../simulation/spice/NetlistBuilder';
import { BOARD_PIN_GROUPS } from '../../simulation/spice/boardPinGroups';

function formatV(v: number): string {
  const abs = Math.abs(v);
  if (abs < 1e-3) return `${(v * 1e6).toFixed(0)}uV`;
  if (abs < 1) return `${(v * 1e3).toFixed(1)}mV`;
  if (abs < 100) return `${v.toFixed(2)}V`;
  return `${v.toFixed(1)}V`;
}

export function ElectricalOverlay() {
  const mode = useElectricalStore((s) => s.mode);
  const nodeVoltages = useElectricalStore((s) => s.nodeVoltages);
  const converged = useElectricalStore((s) => s.converged);
  const error = useElectricalStore((s) => s.error);
  const solveMs = useElectricalStore((s) => s.lastSolveMs);

  const wires = useSimulatorStore((s) => s.wires);
  const components = useSimulatorStore((s) => s.components);
  const boards = useSimulatorStore((s) => s.boards);

  const labels = useMemo(() => {
    if (mode === 'off' || Object.keys(nodeVoltages).length === 0) return [];

    const boardsForSpice = boards.map((b) => {
      const pg = BOARD_PIN_GROUPS[b.boardKind] ?? BOARD_PIN_GROUPS.default;
      return {
        id: b.id,
        vcc: pg.vcc,
        groundPinNames: pg.gnd,
        vccPinNames: pg.vcc_pins,
        pins: {},
      };
    });
    const compsForSpice = components.map((c) => ({
      id: c.id,
      metadataId: c.metadataId,
      properties: c.properties ?? {},
    }));
    const wiresForSpice = wires.map((w) => ({
      id: w.id,
      start: { componentId: w.start.componentId, pinName: w.start.pinName },
      end: { componentId: w.end.componentId, pinName: w.end.pinName },
    }));

    const wireNetMap = buildWireNetMap({
      components: compsForSpice,
      wires: wiresForSpice,
      boards: boardsForSpice,
    });

    return wires.map((w) => {
      const mx = (w.start.x + w.end.x) / 2;
      const my = (w.start.y + w.end.y) / 2;
      const netName = wireNetMap.get(w.id);
      const v = netName ? nodeVoltages[netName] : undefined;
      return { id: w.id, x: mx, y: my, v, netName };
    }).filter((l) => l.v !== undefined && l.netName !== '0');
  }, [wires, components, boards, mode, nodeVoltages]);

  if (mode === 'off') return null;

  const summaryLines: string[] = [];
  if (error) summaryLines.push(`Warning: ${error}`);
  else if (!converged) summaryLines.push('Warning: did not converge');
  else {
    const n = Object.keys(nodeVoltages).length;
    summaryLines.push(`${n} nets | ${solveMs.toFixed(0)} ms`);
  }

  return (
    <svg
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 20,
      }}
    >
      {/* Summary pill */}
      <g transform="translate(12, 12)">
        <rect
          x={0}
          y={0}
          rx={4}
          ry={4}
          width={220}
          height={24}
          fill="rgba(26, 26, 26, 0.85)"
          stroke={error ? '#ff6666' : '#ffa500'}
        />
        <text x={8} y={17} fontSize={11} fill={error ? '#ff9999' : '#ffa500'} fontFamily="monospace">
          SPICE {summaryLines.join(' ')}
        </text>
      </g>

      {/* Per-wire voltage labels */}
      {labels.map((l) => (
        <g key={l.id} transform={`translate(${l.x}, ${l.y})`}>
          <rect
            x={-20}
            y={-9}
            rx={3}
            ry={3}
            width={40}
            height={16}
            fill="rgba(0, 0, 0, 0.75)"
          />
          <text
            x={0}
            y={4}
            textAnchor="middle"
            fontSize={10}
            fontFamily="monospace"
            fill="#ffd700"
          >
            {formatV(l.v!)}
          </text>
        </g>
      ))}
    </svg>
  );
}
