/**
 * Editor Page — main editor + simulator with resizable panels
 */

import React, { useRef, useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { wireElectricalSolver } from '../simulation/spice/subscribeToStore';
import { useSEO } from '../utils/useSEO';
import { CodeEditor } from '../components/editor/CodeEditor';
import { EditorToolbar } from '../components/editor/EditorToolbar';
import { FileTabs } from '../components/editor/FileTabs';
import { FileExplorer } from '../components/editor/FileExplorer';
import { AgentPanel } from '../components/agent/AgentPanel';
import { AgentPanelToggle } from '../components/agent/AgentPanelToggle';

// Lazy-load Pi workspace so xterm.js isn't in the main bundle
const RaspberryPiWorkspace = lazy(() =>
  import('../components/raspberry-pi/RaspberryPiWorkspace').then((m) => ({
    default: m.RaspberryPiWorkspace,
  })),
);
import { CompilationConsole } from '../components/editor/CompilationConsole';
import { SimulatorCanvas } from '../components/simulator/SimulatorCanvas';
import { SerialMonitor } from '../components/simulator/SerialMonitor';
import { Oscilloscope } from '../components/simulator/Oscilloscope';
import { AppHeader } from '../components/layout/AppHeader';
import { SaveProjectModal } from '../components/layout/SaveProjectModal';
import { LoginPromptModal } from '../components/layout/LoginPromptModal';
import { GitHubStarBanner } from '../components/layout/GitHubStarBanner';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useOscilloscopeStore } from '../store/useOscilloscopeStore';
import { useAuthStore } from '../store/useAuthStore';
import { agentPanelBounds, useAgentStore } from '../store/useAgentStore';
import { scanAndReportCanvasPins, clearPinObservationCache } from '../utils/canvasPinScanner';
import { useAutoSave } from '../hooks/useAutoSave';
import type { CompilationLog } from '../utils/compilationLogger';
import '../App.css';

const MOBILE_BREAKPOINT = 768;

const BOTTOM_PANEL_MIN = 80;
const BOTTOM_PANEL_MAX = 600;
const BOTTOM_PANEL_DEFAULT = 200;

const EXPLORER_MIN = 120;
const EXPLORER_MAX = 500;
const EXPLORER_DEFAULT = 210;

const resizeHandleStyle: React.CSSProperties = {
  height: 5,
  flexShrink: 0,
  cursor: 'row-resize',
  background: '#2a2d2e',
  borderTop: '1px solid #3c3c3c',
  borderBottom: '1px solid #3c3c3c',
};

export const EditorPage: React.FC = () => {
  useSEO({
    title: 'Multi-Board Simulator Editor — Arduino, ESP32, RP2040, RISC-V | Velxio',
    description:
      'Write, compile and simulate Arduino, ESP32, Raspberry Pi Pico, ESP32-C3, and Raspberry Pi 3 code in your browser. 19 boards, 5 CPU architectures, 48+ components. Free and open-source.',
    url: 'https://velxio.dev/editor',
  });

  const [editorWidthPct, setEditorWidthPct] = useState(45);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const serialMonitorOpen = useSimulatorStore((s) => s.serialMonitorOpen);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const boards = useSimulatorStore((s) => s.boards);
  const components = useSimulatorStore((s) => s.components);
  const wires = useSimulatorStore((s) => s.wires);
  const activeBoardKind = useSimulatorStore(
    (s) => s.boards.find((b) => b.id === s.activeBoardId)?.boardKind,
  );
  const isRaspberryPi3 = activeBoardKind === 'raspberry-pi-3';
  const oscilloscopeOpen = useOscilloscopeStore((s) => s.open);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [compileLogs, setCompileLogs] = useState<CompilationLog[]>([]);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(BOTTOM_PANEL_DEFAULT);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [loginPromptOpen, setLoginPromptOpen] = useState(false);
  const [showStarBanner, setShowStarBanner] = useState(false);

  // ── Electrical simulation subscriber (one-time, idempotent) ───────────────
  useEffect(() => {
    const unsub = wireElectricalSolver();
    return unsub;
  }, []);

  // ── Auto-save canvas + code to DB on every change (2s debounce) ──────────
  useAutoSave();

  // ── Debug: log full enriched canvas snapshot ──────────────────────────────
  const logSnapshot = useCallback(() => {
    const enrichedBoards = boards.map((board) => {
      const el = document.getElementById(board.id);
      const pinInfo = (el as any)?.pinInfo as Array<{ name?: string }> | undefined;
      const pinNames = pinInfo
        ? pinInfo.map((p) => String(p?.name ?? '').trim()).filter((n) => n.length > 0)
        : [];
      return { ...board, pinNames };
    });
    const enrichedComponents = components.map((comp) => {
      const el = document.getElementById(comp.id);
      const pinInfo = (el as any)?.pinInfo as Array<{ name?: string }> | undefined;
      const pinNames = pinInfo
        ? pinInfo.map((p) => String(p?.name ?? '').trim()).filter((n) => n.length > 0)
        : [];
      return { ...comp, pinNames };
    });
    const snapshot = { activeBoardId, boards: enrichedBoards, components: enrichedComponents, wires };
    console.log('[DEBUG] Canvas Snapshot', JSON.stringify(snapshot, null, 2));
  }, [activeBoardId, boards, components, wires]);

  // ── Runtime pin observation reporter ─────────────────────────────────────
  // Reads live `pinInfo` from DOM-rendered wokwi custom elements and POSTs
  // them to the backend's in-memory pin catalog so the agent gets accurate
  // pin names instead of potentially stale data from components-metadata.json.
  //
  // The actual scan logic lives in canvasPinScanner.ts so AgentPanel can also
  // call it eagerly right after applySnapshotToStores() — ensuring that a
  // freshly-added component's pins are observable before the agent's next
  // get_canvas_runtime_pins call fires.
  useEffect(() => {
    // Clear the dedup cache on project reset so new elements are always
    // reported, even if their metadataId was seen in a previous project.
    clearPinObservationCache();
  }, []);

  useEffect(() => {
    // Reactive scan: fires whenever boards/components change in the store.
    // Uses a 300 ms delay so wokwi custom elements have time to upgrade.
    const timer = setTimeout(() => {
      void scanAndReportCanvasPins({ boards, components, upgradeDelayMs: 0 });
    }, 300);
    return () => clearTimeout(timer);
  }, [boards, components]);


  // ── GitHub star prompt (show once: 2nd visit OR after 3 min) ──────────────
  useEffect(() => {
    const STAR_KEY = 'velxio_star_prompted';
    const VISITS_KEY = 'velxio_editor_visits';
    const FIRST_VISIT_KEY = 'velxio_editor_first_visit';
    const THREE_MIN = 3 * 60 * 1000;

    if (localStorage.getItem(STAR_KEY)) return;

    // Increment visit counter
    const visits = parseInt(localStorage.getItem(VISITS_KEY) ?? '0', 10) + 1;
    localStorage.setItem(VISITS_KEY, String(visits));

    // Record timestamp of first visit
    if (!localStorage.getItem(FIRST_VISIT_KEY)) {
      localStorage.setItem(FIRST_VISIT_KEY, String(Date.now()));
    }
    const firstVisit = parseInt(localStorage.getItem(FIRST_VISIT_KEY)!, 10);

    // Show immediately on second+ visit
    if (visits >= 2) {
      setShowStarBanner(true);
      return;
    }

    // Otherwise schedule after the 3-minute mark
    const elapsed = Date.now() - firstVisit;
    const delay = Math.max(0, THREE_MIN - elapsed);
    const timer = setTimeout(() => {
      if (!localStorage.getItem(STAR_KEY)) setShowStarBanner(true);
    }, delay);
    return () => clearTimeout(timer);
  }, []);

  const handleDismissStarBanner = () => {
    localStorage.setItem('velxio_star_prompted', '1');
    setShowStarBanner(false);
  };
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT);
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches,
  );
  // Default to 'code' on mobile — show the editor so users can write/view code
  const [mobileView, setMobileView] = useState<'code' | 'circuit'>('code');
  const user = useAuthStore((s) => s.user);
  const agentPanelOpen = useAgentStore((s) => s.panelOpen);
  const agentPanelWidth = useAgentStore((s) => s.panelWidth);
  const setAgentPanelWidth = useAgentStore((s) => s.setPanelWidth);
  const toggleAgentPanel = useAgentStore((s) => s.togglePanel);

  const handleSaveClick = useCallback(() => {
    if (!user) {
      setLoginPromptOpen(true);
    } else {
      setSaveModalOpen(true);
    }
  }, [user]);

  // Track mobile breakpoint
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const update = (e: MediaQueryListEvent | MediaQueryList) => {
      const mobile = e.matches;
      setIsMobile(mobile);
      if (mobile) setExplorerOpen(false);
    };
    update(mq);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Ctrl+S shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSaveClick();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSaveClick]);

  // Prevent body scroll on the editor page
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    window.scrollTo(0, 0);
    return () => {
      html.style.overflow = '';
      body.style.overflow = '';
    };
  }, []);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setEditorWidthPct(Math.max(20, Math.min(80, pct)));
    };

    const handleMouseUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleBottomPanelResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = bottomPanelHeight;

      const onMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY;
        setBottomPanelHeight(
          Math.max(BOTTOM_PANEL_MIN, Math.min(BOTTOM_PANEL_MAX, startHeight + delta)),
        );
      };
      const onUp = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [bottomPanelHeight],
  );

  const handleExplorerResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = explorerWidth;

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        setExplorerWidth(Math.max(EXPLORER_MIN, Math.min(EXPLORER_MAX, startWidth + delta)));
      };
      const onUp = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [explorerWidth],
  );

  const handleAgentPanelResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = agentPanelWidth;

      const onMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX;
        const next = Math.max(
          agentPanelBounds.min,
          Math.min(agentPanelBounds.max, startWidth + delta),
        );
        setAgentPanelWidth(next);
      };
      const onUp = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [agentPanelWidth, setAgentPanelWidth],
  );

  return (
    <div className="app">
      <AppHeader />

      {/* ── Mobile tab bar (top, above panels) ── */}
      {isMobile && (
        <nav className="mobile-tab-bar">
          <button
            className={`mobile-tab-btn${mobileView === 'code' ? ' mobile-tab-btn--active' : ''}`}
            onClick={() => setMobileView('code')}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
            <span>&lt;/&gt; Code</span>
          </button>
          <button
            className={`mobile-tab-btn${mobileView === 'circuit' ? ' mobile-tab-btn--active' : ''}`}
            onClick={() => setMobileView('circuit')}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="7" width="20" height="14" rx="2" />
              <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
              <line x1="12" y1="12" x2="12" y2="16" />
              <line x1="10" y1="14" x2="14" y2="14" />
            </svg>
            <span>Circuit</span>
          </button>
        </nav>
      )}

      <div className="app-container" ref={containerRef}>
        {/* ── Editor side ── */}
        <div
          className="editor-panel"
          style={{
            width: isMobile ? '100%' : `${editorWidthPct}%`,
            display: isMobile && mobileView !== 'code' ? 'none' : 'flex',
            flexDirection: 'row',
          }}
        >
          {/* File explorer sidebar + resize handle */}
          {explorerOpen && (
            <>
              <div
                style={{ width: explorerWidth, flexShrink: 0, display: 'flex', overflow: 'hidden' }}
              >
                <FileExplorer onSaveClick={handleSaveClick} />
              </div>
              {!isMobile && (
                <div
                  className="explorer-resize-handle"
                  onMouseDown={handleExplorerResizeMouseDown}
                />
              )}
            </>
          )}

          {/* Editor main area */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              minWidth: 0,
            }}
          >
            {/* Explorer toggle + toolbar */}
            <div style={{ display: 'flex', alignItems: 'stretch', flexShrink: 0 }}>
              <button
                className="explorer-toggle-btn"
                onClick={() => setExplorerOpen((v) => !v)}
                title={explorerOpen ? 'Hide file explorer' : 'Show file explorer'}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </button>
              <AgentPanelToggle open={agentPanelOpen} onToggle={toggleAgentPanel} />
              <div style={{ flex: 1 }}>
                <EditorToolbar
                  consoleOpen={consoleOpen}
                  setConsoleOpen={setConsoleOpen}
                  compileLogs={compileLogs}
                  setCompileLogs={setCompileLogs}
                />
              </div>
            </div>

            {/* File tabs — hidden when Pi workspace is active */}
            {!isRaspberryPi3 && <FileTabs />}

            {/* Editor area: Pi workspace or Monaco editor */}
            <div className="editor-wrapper" style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
              {isRaspberryPi3 && activeBoardId ? (
                <Suspense
                  fallback={
                    <div style={{ color: '#666', padding: 16, fontSize: 12 }}>
                      Loading Pi workspace…
                    </div>
                  }
                >
                  <RaspberryPiWorkspace boardId={activeBoardId} />
                </Suspense>
              ) : (
                <CodeEditor />
              )}
            </div>

            {/* Console */}
            {consoleOpen && (
              <>
                <div
                  onMouseDown={handleBottomPanelResizeMouseDown}
                  style={resizeHandleStyle}
                  title="Drag to resize"
                />
                <div style={{ height: bottomPanelHeight, flexShrink: 0 }}>
                  <CompilationConsole
                    isOpen={consoleOpen}
                    onClose={() => setConsoleOpen(false)}
                    logs={compileLogs}
                    onClear={() => setCompileLogs([])}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Resize handle (desktop only) */}
        {!isMobile && (
          <div className="resize-handle" onMouseDown={handleResizeMouseDown}>
            <div className="resize-handle-grip" />
          </div>
        )}

        {/* ── Simulator side ── */}
        <div
          className="simulator-panel"
          style={{
            width: isMobile ? '100%' : `${100 - editorWidthPct}%`,
            display: isMobile && mobileView !== 'circuit' ? 'none' : 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
            <SimulatorCanvas />
            {/* ── Debug snapshot button ── */}
            <button
              onClick={logSnapshot}
              title="Log canvas snapshot to console"
              style={{
                position: 'absolute',
                bottom: 8,
                left: 8,
                zIndex: 999,
                padding: '2px 7px',
                fontSize: 10,
                fontFamily: 'monospace',
                background: 'rgba(30,30,30,0.82)',
                color: '#7dd3fc',
                border: '1px solid #334155',
                borderRadius: 4,
                cursor: 'pointer',
                opacity: 0.7,
                lineHeight: '16px',
              }}
            >
              dbg
            </button>
          </div>
          {serialMonitorOpen && (
            <>
              <div
                onMouseDown={handleBottomPanelResizeMouseDown}
                style={resizeHandleStyle}
                title="Drag to resize"
              />
              <div style={{ height: bottomPanelHeight, flexShrink: 0 }}>
                <SerialMonitor />
              </div>
            </>
          )}
          {oscilloscopeOpen && (
            <>
              <div
                onMouseDown={handleBottomPanelResizeMouseDown}
                style={resizeHandleStyle}
                title="Drag to resize"
              />
              <div style={{ height: bottomPanelHeight, flexShrink: 0 }}>
                <Oscilloscope />
              </div>
            </>
          )}
        </div>

        {!isMobile && agentPanelOpen && (
          <>
            <div
              className="agent-panel-resize-handle"
              onMouseDown={handleAgentPanelResizeMouseDown}
            >
              <div className="resize-handle-grip" />
            </div>
            <div className="agent-panel-shell" style={{ width: agentPanelWidth }}>
              <AgentPanel />
            </div>
          </>
        )}
      </div>

      {saveModalOpen && <SaveProjectModal onClose={() => setSaveModalOpen(false)} />}
      {loginPromptOpen && <LoginPromptModal onClose={() => setLoginPromptOpen(false)} />}
      {showStarBanner && <GitHubStarBanner onClose={handleDismissStarBanner} />}
    </div>
  );
};
