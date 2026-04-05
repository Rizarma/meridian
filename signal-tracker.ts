/**
 * signal-tracker.ts — Captures screening signals at deploy time for Darwinian weighting.
 *
 * During screening, signals are "staged" for each candidate pool.
 * When deploy_position fires, the staged signals are retrieved and stored
 * in state.json alongside the position, so we know exactly what signals
 * were present when the decision was made.
 *
 * This enables post-hoc analysis: which signals actually predicted wins?
 */

import { log } from "./logger.js";
import type { SignalSnapshot, StagedSignals } from "./types/signals.d.ts";

// In-memory staging area — cleared after retrieval or after 10 minutes
const _staged: Map<string, StagedSignals> = new Map();
const STAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Stage signals for a pool during screening.
 * Called after candidate data is loaded, before the LLM decides.
 * @param poolAddress - The pool address to stage signals for
 * @param signals - The signal snapshot to stage
 */
export function stageSignals(poolAddress: string, signals: SignalSnapshot): void {
  _staged.set(poolAddress, {
    ...signals,
    staged_at: Date.now(),
  });
  // Clean up stale entries
  for (const [addr, data] of _staged) {
    if (Date.now() - data.staged_at > STAGE_TTL_MS) {
      _staged.delete(addr);
    }
  }
}

/**
 * Retrieve and clear staged signals for a pool.
 * Called from deployPosition after the position is created.
 * @param poolAddress - The pool address to retrieve signals for
 * @returns Signal snapshot or null if not staged
 */
export function getAndClearStagedSignals(poolAddress: string): SignalSnapshot | null {
  const data = _staged.get(poolAddress);
  if (!data) return null;
  _staged.delete(poolAddress);
  const { staged_at, ...signals } = data;
  log(
    "signals",
    `Retrieved staged signals for ${poolAddress.slice(0, 8)}: ${Object.keys(signals).filter((k) => signals[k as keyof typeof signals] != null).length} signals`
  );
  return signals;
}

/**
 * Get all currently staged pool addresses (for debugging).
 * @returns Array of staged pool addresses
 */
export function getStagedPools(): string[] {
  return [..._staged.keys()];
}
