/**
 * canvasPinScanner.ts
 *
 * Imperative utility that reads live `pinInfo` from wokwi custom elements
 * already mounted in the DOM and POSTs observations to the backend's runtime
 * pin catalog via reportPinObservation().
 *
 * Call `scanAndReportCanvasPins()` any time you know the canvas may have just
 * rendered new components — particularly right after applySnapshotToStores()
 * inside AgentPanel so the agent's next `get_canvas_runtime_pins` call finds
 * fresh data instead of returning `available: false`.
 *
 * The function is safe to call concurrently / repeatedly; a module-level
 * deduplication set prevents sending the same (metadataId, pinNames[]) pair
 * twice in the same session.
 */

import { reportPinObservation } from '../services/agentSessions';

// Module-level dedup set — shared across all callers within the same browser tab.
const _sentObservationKeys = new Set<string>();

export interface CanvasScanOptions {
  /**
   * Boards to scan: array of { id, boardKind } objects.
   * Typically from useSimulatorStore.getState().boards.
   */
  boards: Array<{ id: string; boardKind: string }>;

  /**
   * Components to scan: array of { id, metadataId } objects.
   * Typically from useSimulatorStore.getState().components.
   */
  components: Array<{ id: string; metadataId: string }>;

  /**
   * Extra delay (ms) after a rAF tick before reading pinInfo.
   * Wokwi custom elements need to upgrade before `pinInfo` is present on the
   * element. Default: 200 ms.
   */
  upgradeDelayMs?: number;
}

/**
 * Scan the live DOM for wokwi element pinInfo and POST observations.
 *
 * Returns the number of new observations successfully reported.
 * Resolves after the HTTP requests fire (fire-and-forget internally).
 */
export async function scanAndReportCanvasPins(opts: CanvasScanOptions): Promise<number> {
  const { boards, components, upgradeDelayMs = 200 } = opts;

  // Wait one animation frame so React has committed the new DOM nodes, then
  // wait the upgrade delay for wokwi custom elements to hydrate their pinInfo.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, upgradeDelayMs);
    });
  });

  // Collect unique observations keyed by metadataId.
  const byMetadataId = new Map<string, { tagName: string | null; pinNames: string[] }>();

  for (const board of boards) {
    const element = document.getElementById(board.id);
    const pinInfo = (element as any)?.pinInfo as Array<{ name?: string }> | undefined;
    if (!pinInfo) continue;

    const pinNames = pinInfo
      .map((p) => String(p?.name ?? '').trim())
      .filter((n) => n.length > 0);
    if (pinNames.length === 0) continue;

    const metadataId = board.boardKind;
    const tagName = `wokwi-${board.boardKind}`;
    const existing = byMetadataId.get(metadataId);
    if (!existing) {
      byMetadataId.set(metadataId, { tagName, pinNames });
    } else {
      byMetadataId.set(metadataId, {
        tagName: existing.tagName ?? tagName,
        pinNames: Array.from(new Set([...existing.pinNames, ...pinNames])),
      });
    }
  }

  for (const comp of components) {
    const element = document.getElementById(comp.id);
    const pinInfo = (element as any)?.pinInfo as Array<{ name?: string }> | undefined;
    if (!pinInfo) continue;

    const pinNames = pinInfo
      .map((p) => String(p?.name ?? '').trim())
      .filter((n) => n.length > 0);
    if (pinNames.length === 0) continue;

    const metadataId = comp.metadataId;
    const tagName = (element as any)?.tagName?.toLowerCase?.() ?? null;
    const existing = byMetadataId.get(metadataId);
    if (!existing) {
      byMetadataId.set(metadataId, { tagName, pinNames });
    } else {
      byMetadataId.set(metadataId, {
        tagName: existing.tagName ?? tagName,
        pinNames: Array.from(new Set([...existing.pinNames, ...pinNames])),
      });
    }
  }

  if (byMetadataId.size === 0) return 0;

  // POST only observations whose pin set has changed since the last send.
  const promises: Promise<void>[] = [];
  for (const [metadataId, { tagName, pinNames }] of byMetadataId) {
    const cacheKey = `${metadataId}:${pinNames.slice().sort().join(',')}`;
    if (_sentObservationKeys.has(cacheKey)) continue;
    _sentObservationKeys.add(cacheKey);

    promises.push(
      reportPinObservation({ metadataId, tagName, pinNames }).catch(() => {
        // Remove the key so the next scan can retry on failure.
        _sentObservationKeys.delete(cacheKey);
      }),
    );
  }

  await Promise.allSettled(promises);
  return promises.length;
}

/**
 * Invalidate the dedup cache for a specific metadataId so the next scan will
 * re-POST its observations. Call this after add_component / change_board_kind
 * so newly-added elements are always reported fresh.
 */
export function invalidatePinObservationCache(metadataId: string): void {
  const prefix = `${metadataId}:`;
  for (const key of _sentObservationKeys) {
    if (key.startsWith(prefix)) _sentObservationKeys.delete(key);
  }
}

/**
 * Clear the entire dedup cache — useful when the project is reset.
 */
export function clearPinObservationCache(): void {
  _sentObservationKeys.clear();
}
