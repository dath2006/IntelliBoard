import React, { useState } from 'react';

// ── Tool metadata ────────────────────────────────────────────────────────────

type ToolCategory = 'circuit' | 'code' | 'inspect' | 'compile' | 'library' | 'validate' | 'system';

interface ToolMeta {
  label: string;
  category: ToolCategory;
  icon: string;
  description: (input: Record<string, unknown>) => string;
}

const TOOL_META: Record<string, ToolMeta> = {
  // Circuit mutations
  add_board: {
    label: 'Add Board',
    category: 'circuit',
    icon: '🖥',
    description: (i) =>
      `${i.board_kind ?? i.boardKind ?? ''}${i.board_id ? ` (${i.board_id})` : ''}`,
  },
  change_board_kind: {
    label: 'Change Board',
    category: 'circuit',
    icon: '🔄',
    description: (i) => `${i.board_id} → ${i.board_kind ?? i.boardKind ?? ''}`,
  },
  remove_board: {
    label: 'Remove Board',
    category: 'circuit',
    icon: '🗑',
    description: (i) => String(i.board_id ?? ''),
  },
  add_component: {
    label: 'Add Component',
    category: 'circuit',
    icon: '➕',
    description: (i) =>
      `${i.metadata_id ?? i.metadataId ?? ''} → ${i.component_id ?? i.componentId ?? ''}`,
  },
  update_component: {
    label: 'Update Component',
    category: 'circuit',
    icon: '✏️',
    description: (i) => String(i.component_id ?? i.componentId ?? ''),
  },
  move_component: {
    label: 'Move Component',
    category: 'circuit',
    icon: '↔️',
    description: (i) => `${i.component_id ?? i.componentId ?? ''} → (${i.x}, ${i.y})`,
  },
  remove_component: {
    label: 'Remove Component',
    category: 'circuit',
    icon: '🗑',
    description: (i) => String(i.component_id ?? i.componentId ?? ''),
  },
  connect_pins: {
    label: 'Connect Pins',
    category: 'circuit',
    icon: '🔌',
    description: (i) =>
      `${i.start_component_id ?? ''}:${i.start_pin ?? ''} → ${i.end_component_id ?? ''}:${i.end_pin ?? ''}`,
  },
  disconnect_wire: {
    label: 'Disconnect Wire',
    category: 'circuit',
    icon: '✂️',
    description: (i) => String(i.wire_id ?? i.wireId ?? ''),
  },
  route_wire: {
    label: 'Route Wire',
    category: 'circuit',
    icon: '〰️',
    description: (i) =>
      `${i.wire_id ?? i.wireId ?? ''} (${Array.isArray(i.waypoints) ? i.waypoints.length : 0} waypoints)`,
  },
  // Code / file
  create_file: {
    label: 'Create File',
    category: 'code',
    icon: '📄',
    description: (i) => `${i.name ?? ''} in ${i.group_id ?? i.groupId ?? ''}`,
  },
  replace_file_range: {
    label: 'Edit File',
    category: 'code',
    icon: '✏️',
    description: (i) =>
      `${i.file_name ?? i.fileName ?? ''} L${i.start_line ?? i.startLine}–${i.end_line ?? i.endLine}`,
  },
  apply_file_patch: {
    label: 'Patch File',
    category: 'code',
    icon: '🩹',
    description: (i) => `${i.file_name ?? i.fileName ?? ''} in ${i.group_id ?? i.groupId ?? ''}`,
  },
  read_file: {
    label: 'Read File',
    category: 'code',
    icon: '📖',
    description: (i) => `${i.file_name ?? i.fileName ?? ''} in ${i.group_id ?? i.groupId ?? ''}`,
  },
  list_files: {
    label: 'List Files',
    category: 'code',
    icon: '📂',
    description: (i) => (i.group_id ? String(i.group_id) : 'all groups'),
  },
  // Inspection
  get_project_outline: {
    label: 'Project Outline',
    category: 'inspect',
    icon: '🗺',
    description: () => 'reading project structure',
  },
  get_component_detail: {
    label: 'Component Detail',
    category: 'inspect',
    icon: '🔍',
    description: (i) => String(i.component_id ?? i.componentId ?? ''),
  },
  search_component_catalog: {
    label: 'Search Catalog',
    category: 'inspect',
    icon: '🔎',
    description: (i) => `"${i.query ?? ''}"${i.category ? ` in ${i.category}` : ''}`,
  },
  get_component_schema: {
    label: 'Component Schema',
    category: 'inspect',
    icon: '📋',
    description: (i) => String(i.component_id ?? i.componentId ?? ''),
  },
  get_canvas_runtime_pins: {
    label: 'Get Pin Names',
    category: 'inspect',
    icon: '📍',
    description: (i) => String(i.instance_id ?? i.instanceId ?? ''),
  },
  list_component_schema_gaps: {
    label: 'Schema Gaps',
    category: 'inspect',
    icon: '⚠️',
    description: () => 'checking catalog coverage',
  },
  // Compile
  compile_board: {
    label: 'Compile',
    category: 'compile',
    icon: '⚙️',
    description: (i) => String(i.board_id ?? i.boardId ?? ''),
  },
  compile: {
    label: 'Compile (Frontend)',
    category: 'compile',
    icon: '⚙️',
    description: (i) => String(i.boardId ?? i.board_id ?? ''),
  },
  compile_in_frontend: {
    label: 'Compile (Frontend)',
    category: 'compile',
    icon: '⚙️',
    description: (i) => String(i.board_id ?? i.boardId ?? ''),
  },
  run_simulation: {
    label: 'Run Simulation',
    category: 'system',
    icon: '▶️',
    description: (i) => String(i.board_id ?? i.boardId ?? ''),
  },
  pause_simulation: {
    label: 'Pause Simulation',
    category: 'system',
    icon: '⏸️',
    description: (i) => String(i.board_id ?? i.boardId ?? ''),
  },
  reset_simulation: {
    label: 'Reset Simulation',
    category: 'system',
    icon: '⟲',
    description: (i) => String(i.board_id ?? i.boardId ?? ''),
  },
  open_serial_monitor: {
    label: 'Open Serial Monitor',
    category: 'system',
    icon: '📟',
    description: (i) => String(i.board_id ?? i.boardId ?? ''),
  },
  close_serial_monitor: {
    label: 'Close Serial Monitor',
    category: 'system',
    icon: '📟',
    description: (i) => String(i.board_id ?? i.boardId ?? ''),
  },
  get_serial_monitor_status: {
    label: 'Serial Monitor Status',
    category: 'system',
    icon: '📟',
    description: (i) => String(i.board_id ?? i.boardId ?? ''),
  },
  set_serial_baud_rate: {
    label: 'Set Baud Rate',
    category: 'system',
    icon: '📟',
    description: (i) => String(i.baud_rate ?? i.baudRate ?? ''),
  },
  send_serial_message: {
    label: 'Send Serial',
    category: 'system',
    icon: '📤',
    description: (i) =>
      `${String(i.board_id ?? i.boardId ?? '')}${i.text ? ` · ${String(i.text).slice(0, 18)}…` : ''}`,
  },
  clear_serial_monitor: {
    label: 'Clear Serial',
    category: 'system',
    icon: '🧹',
    description: (i) => String(i.board_id ?? i.boardId ?? ''),
  },
  capture_serial_monitor: {
    label: 'Capture Serial',
    category: 'system',
    icon: '🗂️',
    description: (i) =>
      `${String(i.board_id ?? i.boardId ?? '')}${i.max_lines ? ` · ${i.max_lines} lines` : ''}`,
  },
  wait_seconds: {
    label: 'Wait',
    category: 'system',
    icon: '⏳',
    description: (i) => `${i.seconds ?? ''}s`,
  },
  'sim.run': {
    label: 'Run Simulation',
    category: 'system',
    icon: '▶️',
    description: (i) => String(i.boardId ?? i.board_id ?? ''),
  },
  'sim.pause': {
    label: 'Pause Simulation',
    category: 'system',
    icon: '⏸️',
    description: (i) => String(i.boardId ?? i.board_id ?? ''),
  },
  'sim.reset': {
    label: 'Reset Simulation',
    category: 'system',
    icon: '⟲',
    description: (i) => String(i.boardId ?? i.board_id ?? ''),
  },
  'serial.monitor.open': {
    label: 'Open Serial Monitor',
    category: 'system',
    icon: '📟',
    description: (i) => String(i.boardId ?? i.board_id ?? ''),
  },
  'serial.monitor.close': {
    label: 'Close Serial Monitor',
    category: 'system',
    icon: '📟',
    description: (i) => String(i.boardId ?? i.board_id ?? ''),
  },
  'serial.monitor.status': {
    label: 'Serial Monitor Status',
    category: 'system',
    icon: '📟',
    description: (i) => String(i.boardId ?? i.board_id ?? ''),
  },
  'serial.set_baud_rate': {
    label: 'Set Baud Rate',
    category: 'system',
    icon: '📟',
    description: (i) => String(i.baudRate ?? i.baud_rate ?? ''),
  },
  'serial.send': {
    label: 'Send Serial',
    category: 'system',
    icon: '📤',
    description: (i) =>
      `${String(i.boardId ?? i.board_id ?? '')}${i.text ? ` · ${String(i.text).slice(0, 18)}…` : ''}`,
  },
  'serial.clear': {
    label: 'Clear Serial',
    category: 'system',
    icon: '🧹',
    description: (i) => String(i.boardId ?? i.board_id ?? ''),
  },
  'serial.capture': {
    label: 'Capture Serial',
    category: 'system',
    icon: '🗂️',
    description: (i) =>
      `${String(i.boardId ?? i.board_id ?? '')}${i.maxLines ? ` · ${i.maxLines} lines` : ''}`,
  },
  // Libraries
  search_libraries: {
    label: 'Search Libraries',
    category: 'library',
    icon: '📦',
    description: (i) => `"${i.query ?? ''}"`,
  },
  install_library: {
    label: 'Install Library',
    category: 'library',
    icon: '⬇️',
    description: (i) => String(i.name ?? ''),
  },
  list_installed_libraries: {
    label: 'Installed Libraries',
    category: 'library',
    icon: '📦',
    description: () => 'listing installed',
  },
  // Validation
  validate_snapshot_state: {
    label: 'Validate Snapshot',
    category: 'validate',
    icon: '✅',
    description: () => 'checking snapshot integrity',
  },
  validate_pin_mapping_state: {
    label: 'Validate Pins',
    category: 'validate',
    icon: '✅',
    description: () => 'checking pin mappings',
  },
  validate_compile_readiness_state: {
    label: 'Compile Readiness',
    category: 'validate',
    icon: '✅',
    description: (i) => String(i.board_id ?? i.boardId ?? ''),
  },
};

const CATEGORY_COLORS: Record<
  ToolCategory,
  { bg: string; border: string; text: string; dot: string }
> = {
  circuit: {
    bg: 'rgba(56,189,248,0.07)',
    border: 'rgba(56,189,248,0.25)',
    text: '#7dd3fc',
    dot: '#38bdf8',
  },
  code: {
    bg: 'rgba(167,139,250,0.07)',
    border: 'rgba(167,139,250,0.25)',
    text: '#c4b5fd',
    dot: '#a78bfa',
  },
  inspect: {
    bg: 'rgba(251,191,36,0.07)',
    border: 'rgba(251,191,36,0.2)',
    text: '#fcd34d',
    dot: '#fbbf24',
  },
  compile: {
    bg: 'rgba(52,211,153,0.07)',
    border: 'rgba(52,211,153,0.25)',
    text: '#6ee7b7',
    dot: '#34d399',
  },
  library: {
    bg: 'rgba(251,146,60,0.07)',
    border: 'rgba(251,146,60,0.2)',
    text: '#fdba74',
    dot: '#fb923c',
  },
  validate: {
    bg: 'rgba(74,222,128,0.07)',
    border: 'rgba(74,222,128,0.2)',
    text: '#86efac',
    dot: '#4ade80',
  },
  system: {
    bg: 'rgba(148,163,184,0.07)',
    border: 'rgba(148,163,184,0.2)',
    text: '#94a3b8',
    dot: '#64748b',
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMeta(toolName: string | null | undefined): ToolMeta {
  if (toolName && TOOL_META[toolName]) return TOOL_META[toolName];
  return { label: toolName ?? 'Tool', category: 'system', icon: '🔧', description: () => '' };
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function safeJson(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'bigint') return `${val}n`;
        if (val && typeof val === 'object') {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      },
      2,
    );
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  }
}

function OutputSummary({ output }: { output: unknown }) {
  if (output === null || output === undefined) return null;
  if (typeof output === 'object' && !Array.isArray(output)) {
    const obj = output as Record<string, unknown>;
    // Show ok status prominently
    const ok = 'ok' in obj ? obj.ok : undefined;
    const message = typeof obj.message === 'string' && obj.message ? obj.message : null;
    const error = typeof obj.error === 'string' && obj.error ? obj.error : null;
    const pinNames = Array.isArray(obj.pinNames) ? (obj.pinNames as string[]) : null;
    const available = 'available' in obj ? Boolean(obj.available) : null;

    return (
      <div className="tool-trace__output-summary">
        {ok !== undefined && (
          <span
            className={`tool-trace__ok-badge ${ok ? 'tool-trace__ok-badge--ok' : 'tool-trace__ok-badge--fail'}`}
          >
            {ok ? '✓ ok' : '✗ failed'}
          </span>
        )}
        {error && <span className="tool-trace__output-error">{error}</span>}
        {message && !error && <span className="tool-trace__output-msg">{message}</span>}
        {pinNames && (
          <span className="tool-trace__pin-list">
            {available === false
              ? 'not available yet'
              : pinNames.slice(0, 8).join(', ') +
                (pinNames.length > 8 ? ` +${pinNames.length - 8}` : '')}
          </span>
        )}
      </div>
    );
  }
  if (Array.isArray(output)) {
    return (
      <span className="tool-trace__output-msg">
        {output.length} item{output.length !== 1 ? 's' : ''}
      </span>
    );
  }
  return <span className="tool-trace__output-msg">{String(output).slice(0, 120)}</span>;
}

// ── Main component ───────────────────────────────────────────────────────────

interface ToolTraceRowProps {
  toolName: string | null | undefined;
  input: unknown;
  output: unknown;
  createdAt: string;
  failed?: boolean;
}

export const ToolTraceRow: React.FC<ToolTraceRowProps> = ({
  toolName,
  input,
  output,
  createdAt,
  failed,
}) => {
  const [expanded, setExpanded] = useState(false);
  const meta = getMeta(toolName);
  const colors = CATEGORY_COLORS[meta.category];
  const desc =
    input && typeof input === 'object' ? meta.description(input as Record<string, unknown>) : '';
  const isPending = output === undefined;

  return (
    <div
      className={`tool-trace${isPending ? ' tool-trace--pending' : ''}`}
      style={
        {
          '--tool-bg': colors.bg,
          '--tool-border': colors.border,
          '--tool-text': colors.text,
          '--tool-dot': colors.dot,
        } as React.CSSProperties
      }
    >
      <div className="tool-trace__header" onClick={() => !isPending && setExpanded((v) => !v)}>
        <span className={`tool-trace__dot${isPending ? ' tool-trace__dot--pulse' : ''}`} />
        <span className="tool-trace__icon">{meta.icon}</span>
        <div className="tool-trace__title-group">
          <span className="tool-trace__label">{meta.label}</span>
          {desc && <span className="tool-trace__desc">{desc}</span>}
        </div>
        <div className="tool-trace__right">
          {isPending && <span className="tool-trace__pending-label">running…</span>}
          {!isPending && failed && <span className="tool-trace__failed-badge">failed</span>}
          <span className="tool-trace__time">{formatTime(createdAt)}</span>
          {!isPending && <span className="tool-trace__chevron">{expanded ? '▲' : '▼'}</span>}
        </div>
      </div>

      {!expanded && output !== undefined && output !== null && (
        <div className="tool-trace__inline-output">
          <OutputSummary output={output} />
        </div>
      )}

      {expanded && (
        <div className="tool-trace__body">
          {input !== undefined && input !== null && (
            <div className="tool-trace__section">
              <div className="tool-trace__section-label">Input</div>
              <pre className="tool-trace__pre">{safeJson(input)}</pre>
            </div>
          )}
          {output !== undefined && output !== null && (
            <div className="tool-trace__section">
              <div className="tool-trace__section-label">Output</div>
              <pre className="tool-trace__pre">{safeJson(output)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
