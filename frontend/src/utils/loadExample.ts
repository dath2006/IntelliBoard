/**
 * Shared utility to load an example project into the editor and simulator stores.
 * Used by both ExamplesPage (gallery click) and ExampleLoaderPage (direct URL).
 */

import type { ExampleProject } from '../data/examples';
import type { BoardKind } from '../types/board';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore, DEFAULT_BOARD_POSITION } from '../store/useSimulatorStore';
import { useVfsStore } from '../store/useVfsStore';
import { isBoardComponent } from './boardPinMapping';
import { getInstalledLibraries, installLibrary } from '../services/libraryService';
import { trackOpenExample } from './analytics';

export interface LibraryInstallProgress {
  total: number;
  done: number;
  current: string;
}

/**
 * Install any missing Arduino libraries required by an example.
 * Calls onProgress for UI updates; silently continues on failure.
 */
export async function ensureLibraries(
  libs: string[],
  onProgress?: (progress: LibraryInstallProgress | null) => void,
): Promise<void> {
  if (libs.length === 0) return;
  try {
    const installed = await getInstalledLibraries();
    const installedNames = new Set(
      installed.map((l) => (l.library?.name ?? l.name ?? '').toLowerCase()),
    );
    const missing = libs.filter((l) => !installedNames.has(l.toLowerCase()));
    if (missing.length === 0) return;

    onProgress?.({ total: missing.length, done: 0, current: missing[0] });
    for (let i = 0; i < missing.length; i++) {
      onProgress?.({ total: missing.length, done: i, current: missing[i] });
      await installLibrary(missing[i]);
    }
    onProgress?.(null);
  } catch {
    onProgress?.(null);
  }
}

/**
 * Load an example project into the editor + simulator stores.
 * Does NOT navigate — the caller is responsible for navigation.
 */
export async function loadExample(
  example: ExampleProject,
  onLibraryProgress?: (progress: LibraryInstallProgress | null) => void,
): Promise<void> {
  trackOpenExample(example.title);

  // Auto-install required libraries
  if (example.libraries && example.libraries.length > 0) {
    await ensureLibraries(example.libraries, onLibraryProgress);
  }

  const {
    setComponents,
    setWires,
    boards,
    addBoard,
    removeBoard,
    setActiveBoardId,
    recalculateAllWirePositions,
  } = useSimulatorStore.getState();

  if (example.boards && example.boards.length > 0) {
    // ── Multi-board loading ───────────────────────────────────────────────
    const currentIds = boards.map((b) => b.id);
    currentIds.forEach((id) => removeBoard(id));

    example.boards.forEach((eb) => {
      addBoard(eb.boardKind as BoardKind, eb.x, eb.y);
    });

    const { boards: newBoards } = useSimulatorStore.getState();
    example.boards.forEach((eb) => {
      const boardId = eb.boardKind;
      const board = newBoards.find((b) => b.id === boardId);
      if (!board) return;

      if (eb.code) {
        const AVR_BOARDS = ['arduino-uno', 'arduino-nano', 'arduino-mega', 'attiny85'];
        const filename = AVR_BOARDS.includes(boardId) ? 'sketch.ino' : 'main.cpp';
        useEditorStore.getState().setActiveGroup(board.activeFileGroupId);
        useEditorStore.getState().loadFiles([{ name: filename, content: eb.code }]);
      }

      if (eb.vfsFiles && boardId === 'raspberry-pi-3') {
        const vfsState = useVfsStore.getState();
        const tree = vfsState.getTree(boardId);
        for (const [nodeId, node] of Object.entries(tree)) {
          if (node.type === 'file' && eb.vfsFiles[node.name] !== undefined) {
            vfsState.setContent(boardId, nodeId, eb.vfsFiles[node.name]);
          }
        }
      }
    });

    const firstArduino = example.boards.find(
      (eb) =>
        eb.boardKind !== 'raspberry-pi-3' &&
        eb.boardKind !== 'esp32' &&
        eb.boardKind !== 'esp32-s3' &&
        eb.boardKind !== 'esp32-c3',
    );
    if (firstArduino) {
      setActiveBoardId(firstArduino.boardKind);
    }

    const componentsWithoutBoard = example.components.filter(
      (comp) =>
        !comp.type.includes('arduino') &&
        !comp.type.includes('pico') &&
        !comp.type.includes('raspberry') &&
        !comp.type.includes('esp32'),
    );
    setComponents(
      componentsWithoutBoard.map((comp) => ({
        id: comp.id,
        metadataId: comp.type.replace(/^(wokwi|velxio)-/, ''),
        x: comp.x,
        y: comp.y,
        properties: comp.properties,
      })),
    );

    setWires(
      example.wires.map((wire) => ({
        id: wire.id,
        start: { componentId: wire.start.componentId, pinName: wire.start.pinName, x: 0, y: 0 },
        end: { componentId: wire.end.componentId, pinName: wire.end.pinName, x: 0, y: 0 },
        color: wire.color,
        waypoints: [],
      })),
    );
    recalculateAllWirePositions();
  } else {
    // ── Single-board loading ─────────────────────────────────────────────
    // Re-read the live boards list right now (not the stale destructured snapshot)
    // to ensure every existing board is actually removed.
    const isAnalogOnly = (example as any).boardFilter === 'analog';
    useSimulatorStore.getState().boards.map((b) => b.id).forEach((id) => removeBoard(id));

    let newBoardId: string | null = null;
    if (!isAnalogOnly) {
      const targetBoard = example.boardType || 'arduino-uno';
      newBoardId = addBoard(
        targetBoard as BoardKind,
        DEFAULT_BOARD_POSITION.x,
        DEFAULT_BOARD_POSITION.y,
      );
      setActiveBoardId(newBoardId);
    }
    useEditorStore.getState().setCode(example.code);

    const componentsWithoutBoard = example.components.filter(
      (comp) =>
        !comp.type.includes('arduino') &&
        !comp.type.includes('pico') &&
        !comp.type.includes('esp32'),
    );
    setComponents(
      componentsWithoutBoard.map((comp) => ({
        id: comp.id,
        metadataId: comp.type.replace(/^(wokwi|velxio)-/, ''),
        x: comp.x,
        y: comp.y,
        properties: comp.properties,
      })),
    );

    // Remap wire board-component references to the actual board instance id.
    // The example data uses the boardType string (e.g. "esp32", "arduino-uno")
    // as the componentId in wire endpoints. After addBoard() the instance id
    // equals boardKind for the first board (e.g. "esp32"), but we use the
    // returned newBoardId directly so there's no ambiguity.
    const boardType = (example.boardType || 'arduino-uno').toLowerCase();
    const remapBoardId = (id: string): string => {
      if (!newBoardId) return id; // analog-only: no board
      // Match the boardType string used in example wire data (e.g. "esp32")
      if (id.toLowerCase() === boardType) return newBoardId;
      // Match any other board-component id (generic fallback)
      if (isBoardComponent(id)) return newBoardId;
      return id;
    };

    setWires(
      example.wires.map((wire) => ({
        id: wire.id,
        start: {
          componentId: remapBoardId(wire.start.componentId),
          pinName: wire.start.pinName,
          x: 0,
          y: 0,
        },
        end: {
          componentId: remapBoardId(wire.end.componentId),
          pinName: wire.end.pinName,
          x: 0,
          y: 0,
        },
        color: wire.color,
        waypoints: [],
      })),
    );
    recalculateAllWirePositions();
  }

}
