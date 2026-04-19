/**
 * Persistent agent state — stored in SQLite database.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "node:fs";
import path from "node:path";
import { registerTool } from "../../tools/registry.js";
import {
  MAX_INSTRUCTION_LENGTH,
  MAX_RECENT_EVENTS,
  SYNC_GRACE_PERIOD_MS,
  TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
  TRAILING_EXIT_COOLDOWN_MS,
  TRAILING_PEAK_CONFIRM_TOLERANCE,
} from "../config/constants.js";
import { PROJECT_ROOT } from "../config/paths.js";
import { evaluateExitConditions, shouldActivateTrailingTP } from "../domain/exit-rules.js";
import {
  getStrategy,
  getStrategyByLpStrategy,
  isLegacyLpStrategy,
} from "../domain/strategy-library.js";
import type { SetPositionNoteArgs } from "../types/executor.js";
import type { SignalSnapshot } from "../types/signals.js";
import type {
  BinRange,
  ExitAction,
  ManagementConfig,
  PeakConfirmation,
  PositionData,
  PositionState,
  StateEvent,
  StateSummary,
  TrackedPosition,
  TrailingConfirmation,
} from "../types/state.js";
import type { LPStrategyType, Strategy } from "../types/strategy.js";
import { getErrorMessage } from "../utils/errors.js";
import { clearAllConfirmationTimers } from "./confirmation-timers.js";
import { get, parseJson, query, run, stringifyJson, transaction } from "./db.js";
import { log } from "./logger.js";

// Legacy JSON export path for debugging
const STATE_FILE = path.join(PROJECT_ROOT, "state.json");

/** Parameters for tracking a new position */
export interface TrackPositionParams {
  position: string;
  pool: string;
  pool_name: string;
  strategy: string;
  bin_range?: BinRange;
  amount_sol: number;
  amount_x?: number;
  active_bin: number;
  bin_step: number;
  volatility: number;
  fee_tvl_ratio: number;
  organic_score: number;
  initial_value_usd: number;
  signal_snapshot?: SignalSnapshot | null;
  strategy_config?: Strategy | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Database Schema
// ═══════════════════════════════════════════════════════════════════════════

/**
 * NOTE: Tables are created by initSchema() in db-migrations.ts:
 * - position_state: Active position metadata for management
 * - position_state_events: Events for active positions
 * - state_metadata: Singleton values (last briefing date, etc.)
 *
 * These are separate from the positions/position_events tables which store
 * historical records with a different schema.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Row Mapping Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve a strategy value that might be either a strategy ID or a legacy lp_strategy.
 * Returns a Strategy object if resolution succeeds, or null.
 *
 * Resolution order:
 * 1. If strategy_config is already present, use it (trust the snapshot).
 * 2. Try resolving by strategy id via getStrategy().
 * 3. If strategy is a legacy lp_strategy value, map to a sensible default Strategy object.
 */
export function resolveStrategy(
  strategy: string,
  strategyConfig: Strategy | null | undefined
): { resolved: Strategy | null; strategyId: string; legacy: boolean } {
  // 1. Prefer existing strategy_config snapshot
  if (strategyConfig && typeof strategyConfig === "object" && strategyConfig.id) {
    return { resolved: strategyConfig, strategyId: strategyConfig.id, legacy: false };
  }

  // 2. Try resolving by strategy id
  if (strategy && !isLegacyLpStrategy(strategy)) {
    const result = getStrategy({ id: strategy });
    if (!result.error && result.id) {
      return { resolved: result as Strategy, strategyId: result.id, legacy: false };
    }
  }

  // 3. Legacy lp_strategy fallback — prefer a real strategy definition for that lp_strategy
  if (strategy && isLegacyLpStrategy(strategy)) {
    const mapped = getStrategyByLpStrategy(strategy);
    if (mapped) {
      log(
        "state_warn",
        `Legacy lp_strategy "${strategy}" found — mapped to strategy id "${mapped.id}". Backfill recommended.`
      );
      return { resolved: mapped, strategyId: mapped.id, legacy: true };
    }

    log(
      "state_warn",
      `Legacy lp_strategy "${strategy}" found with no matching strategy definition — using synthetic fallback. Backfill recommended.`
    );
    const syntheticId = `__legacy_${strategy}__`;
    const legacyStrategy: Strategy = {
      id: syntheticId,
      name: `Legacy ${strategy}`,
      author: "legacy",
      lp_strategy: strategy as LPStrategyType,
      token_criteria: {},
      entry: {},
      range: {},
      exit: {},
      best_for: `Legacy ${strategy} strategy`,
    };
    return { resolved: legacyStrategy, strategyId: syntheticId, legacy: true };
  }

  return { resolved: null, strategyId: strategy || "unknown", legacy: false };
}

function rowToTrackedPosition(row: Record<string, unknown>): TrackedPosition {
  const rawStrategy = row.strategy as string;
  const rawStrategyConfig = parseJson<Strategy>(row.strategy_config as string | null);

  // Resolve strategy with backward compatibility for legacy rows
  const { resolved: resolvedStrategyConfig } = resolveStrategy(rawStrategy, rawStrategyConfig);

  return {
    position: row.position as string,
    pool: row.pool as string,
    pool_name: row.pool_name as string,
    strategy: resolvedStrategyConfig?.id ?? rawStrategy,
    strategy_config: resolvedStrategyConfig,
    bin_range: parseJson<BinRange>(row.bin_range as string | null) ?? {},
    amount_sol: row.amount_sol as number,
    amount_x: (row.amount_x as number) ?? 0,
    active_bin_at_deploy: row.active_bin_at_deploy as number,
    bin_step: row.bin_step as number,
    volatility: row.volatility as number,
    fee_tvl_ratio: row.fee_tvl_ratio as number,
    initial_fee_tvl_24h: row.initial_fee_tvl_24h as number,
    organic_score: row.organic_score as number,
    initial_value_usd: row.initial_value_usd as number,
    signal_snapshot: parseJson<SignalSnapshot>(row.signal_snapshot as string | null),
    deployed_at: row.deployed_at as string,
    out_of_range_since: (row.out_of_range_since as string | null) ?? null,
    last_claim_at: (row.last_claim_at as string | null) ?? null,
    total_fees_claimed_usd: (row.total_fees_claimed_usd as number) ?? 0,
    rebalance_count: (row.rebalance_count as number) ?? 0,
    closed: Boolean(row.closed),
    closed_at: (row.closed_at as string | null) ?? null,
    notes: parseJson<string[]>(row.notes as string | null) ?? [],
    peak_pnl_pct: (row.peak_pnl_pct as number) ?? 0,
    pending_peak_pnl_pct: (row.pending_peak_pnl_pct as number | null) ?? null,
    pending_peak_started_at: (row.pending_peak_started_at as string | null) ?? null,
    trailing_active: Boolean(row.trailing_active),
    instruction: (row.instruction as string | null) ?? null,
    pending_trailing_current_pnl_pct:
      (row.pending_trailing_current_pnl_pct as number | null) ?? null,
    pending_trailing_peak_pnl_pct: (row.pending_trailing_peak_pnl_pct as number | null) ?? null,
    pending_trailing_drop_pct: (row.pending_trailing_drop_pct as number | null) ?? null,
    pending_trailing_started_at: (row.pending_trailing_started_at as string | null) ?? null,
    confirmed_trailing_exit_reason: (row.confirmed_trailing_exit_reason as string | null) ?? null,
    confirmed_trailing_exit_until: (row.confirmed_trailing_exit_until as string | null) ?? null,
  };
}

function trackedPositionToRow(pos: TrackedPosition): Record<string, unknown> {
  return {
    position: pos.position,
    pool: pos.pool,
    pool_name: pos.pool_name,
    strategy: pos.strategy,
    strategy_config: pos.strategy_config ? stringifyJson(pos.strategy_config) : null,
    bin_range: stringifyJson(pos.bin_range),
    amount_sol: pos.amount_sol,
    amount_x: pos.amount_x ?? 0,
    active_bin_at_deploy: pos.active_bin_at_deploy,
    bin_step: pos.bin_step,
    volatility: pos.volatility,
    fee_tvl_ratio: pos.fee_tvl_ratio,
    initial_fee_tvl_24h: pos.initial_fee_tvl_24h,
    organic_score: pos.organic_score,
    initial_value_usd: pos.initial_value_usd,
    signal_snapshot: pos.signal_snapshot ? stringifyJson(pos.signal_snapshot) : null,
    deployed_at: pos.deployed_at,
    out_of_range_since: pos.out_of_range_since,
    last_claim_at: pos.last_claim_at,
    total_fees_claimed_usd: pos.total_fees_claimed_usd ?? 0,
    rebalance_count: pos.rebalance_count ?? 0,
    closed: pos.closed ? 1 : 0,
    closed_at: pos.closed_at,
    notes: stringifyJson(pos.notes ?? []),
    peak_pnl_pct: pos.peak_pnl_pct ?? 0,
    pending_peak_pnl_pct: pos.pending_peak_pnl_pct,
    pending_peak_started_at: pos.pending_peak_started_at,
    trailing_active: pos.trailing_active ? 1 : 0,
    instruction: pos.instruction ?? null,
    pending_trailing_current_pnl_pct: pos.pending_trailing_current_pnl_pct,
    pending_trailing_peak_pnl_pct: pos.pending_trailing_peak_pnl_pct,
    pending_trailing_drop_pct: pos.pending_trailing_drop_pct,
    pending_trailing_started_at: pos.pending_trailing_started_at,
    confirmed_trailing_exit_reason: pos.confirmed_trailing_exit_reason,
    confirmed_trailing_exit_until: pos.confirmed_trailing_exit_until,
    last_updated: new Date().toISOString(),
  };
}

function rowToStateEvent(row: Record<string, unknown>): StateEvent {
  return {
    ts: row.ts as string,
    action: row.action as string,
    position: row.position as string | undefined,
    pool_name: row.pool_name as string | undefined,
    reason: row.reason as string | undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Legacy JSON Support
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load state from SQLite (for compatibility with old API signature).
 * Note: This loads all data into memory - for large datasets, prefer direct queries.
 */
function load(): PositionState {
  try {
    const positions: Record<string, TrackedPosition> = {};
    const positionRows = query<Record<string, unknown>>("SELECT * FROM position_state");
    for (const row of positionRows) {
      const pos = rowToTrackedPosition(row);
      positions[pos.position] = pos;
    }

    const recentEvents = query<Record<string, unknown>>(
      "SELECT * FROM position_state_events ORDER BY ts DESC LIMIT ?",
      MAX_RECENT_EVENTS
    ).map(rowToStateEvent);

    // Reverse to get chronological order
    recentEvents.reverse();

    return {
      positions,
      recentEvents,
      lastUpdated: new Date().toISOString(),
    };
  } catch (err) {
    log("state_error", `Failed to load from database: ${getErrorMessage(err)}`);
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
}

/**
 * Export current state to JSON file for debugging/backup purposes.
 */
function exportToJson(): void {
  try {
    const state = load();
    const tmpFile = `${STATE_FILE}.tmp`;
    const data = JSON.stringify(state, null, 2);

    fs.writeFileSync(tmpFile, data);
    fs.renameSync(tmpFile, STATE_FILE);
  } catch (err) {
    log("state_warn", `Failed to export state to JSON: ${getErrorMessage(err)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Event Management
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Append to the recent events log.
 */
function pushEvent(event: Omit<StateEvent, "ts">): void {
  transaction(() => {
    run(
      "INSERT INTO position_state_events (ts, action, position, pool_name, reason) VALUES (?, ?, ?, ?, ?)",
      new Date().toISOString(),
      event.action,
      event.position ?? null,
      event.pool_name ?? null,
      event.reason ?? null
    );

    // Prune old events to maintain limit
    run(
      `DELETE FROM position_state_events WHERE id NOT IN (
        SELECT id FROM position_state_events ORDER BY ts DESC LIMIT ?
      )`,
      MAX_RECENT_EVENTS
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Text Sanitization
// ═══════════════════════════════════════════════════════════════════════════

function sanitizeStoredText(text: unknown, maxLen: number = MAX_INSTRUCTION_LENGTH): string | null {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Position Registry
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Clear all positions from state (useful for testing).
 */
export function clearPositions(): void {
  transaction(() => {
    run("DELETE FROM position_state");
    run("DELETE FROM position_state_events");
  });
  log("state", "Cleared all positions");
}

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  strategy_config,
}: TrackPositionParams): void {
  // Resolve strategy using canonical resolution (handles both IDs and legacy lp_strategy values)
  const { resolved: strategyConfig, strategyId } = resolveStrategy(strategy, strategy_config);

  // Warn if strategy id in row differs from strategy_config.id (inconsistent state)
  if (strategyConfig && strategyConfig.id && strategy && strategy !== strategyConfig.id) {
    log(
      "state_warn",
      `Strategy id mismatch for position ${position.slice(0, 8)}: strategy="${strategy}" but strategy_config.id="${strategyConfig.id}" — using config snapshot`
    );
  }

  const now = new Date().toISOString();
  const pos: TrackedPosition = {
    position,
    pool,
    pool_name,
    strategy: strategyId,
    strategy_config: strategyConfig || null,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    signal_snapshot: signal_snapshot || null,
    deployed_at: now,
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_started_at: null,
    trailing_active: false,
    pending_trailing_current_pnl_pct: null,
    pending_trailing_peak_pnl_pct: null,
    pending_trailing_drop_pct: null,
    pending_trailing_started_at: null,
    confirmed_trailing_exit_reason: null,
    confirmed_trailing_exit_until: null,
  };

  const row = trackedPositionToRow(pos);

  transaction(() => {
    run(
      `INSERT INTO position_state (
        position, pool, pool_name, strategy, strategy_config, bin_range, amount_sol, amount_x,
        active_bin_at_deploy, bin_step, volatility, fee_tvl_ratio, initial_fee_tvl_24h,
        organic_score, initial_value_usd, signal_snapshot, deployed_at, out_of_range_since,
        last_claim_at, total_fees_claimed_usd, rebalance_count, closed, closed_at, notes,
        peak_pnl_pct, pending_peak_pnl_pct, pending_peak_started_at, trailing_active, instruction,
        pending_trailing_current_pnl_pct, pending_trailing_peak_pnl_pct, pending_trailing_drop_pct,
        pending_trailing_started_at, confirmed_trailing_exit_reason, confirmed_trailing_exit_until, last_updated
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
      row.position,
      row.pool,
      row.pool_name,
      row.strategy,
      row.strategy_config,
      row.bin_range,
      row.amount_sol,
      row.amount_x,
      row.active_bin_at_deploy,
      row.bin_step,
      row.volatility,
      row.fee_tvl_ratio,
      row.initial_fee_tvl_24h,
      row.organic_score,
      row.initial_value_usd,
      row.signal_snapshot,
      row.deployed_at,
      row.out_of_range_since,
      row.last_claim_at,
      row.total_fees_claimed_usd,
      row.rebalance_count,
      row.closed,
      row.closed_at,
      row.notes,
      row.peak_pnl_pct,
      row.pending_peak_pnl_pct,
      row.pending_peak_started_at,
      row.trailing_active,
      row.instruction,
      row.pending_trailing_current_pnl_pct,
      row.pending_trailing_peak_pnl_pct,
      row.pending_trailing_drop_pct,
      row.pending_trailing_started_at,
      row.confirmed_trailing_exit_reason,
      row.confirmed_trailing_exit_until,
      row.last_updated
    );

    pushEvent({ action: "deploy", position, pool_name: pool_name || pool });
  });

  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 * Returns the effective out_of_range_since timestamp (or null if no row).
 */
export function markOutOfRange(position_address: string): string | null {
  const pos = get<{ out_of_range_since: string | null }>(
    "SELECT out_of_range_since FROM position_state WHERE position = ?",
    position_address
  );
  if (!pos) return null;

  if (!pos.out_of_range_since) {
    const now = new Date().toISOString();
    run(
      "UPDATE position_state SET out_of_range_since = ?, last_updated = ? WHERE position = ?",
      now,
      now,
      position_address
    );
    log("state", `Position ${position_address} marked out of range`);
    return now;
  }
  return pos.out_of_range_since;
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 * Returns the effective out_of_range_since (always null after clearing, or null if no row).
 */
export function markInRange(position_address: string): null {
  const pos = get<{ out_of_range_since: string | null }>(
    "SELECT out_of_range_since FROM position_state WHERE position = ?",
    position_address
  );
  if (!pos) return null;

  if (pos.out_of_range_since) {
    const now = new Date().toISOString();
    run(
      "UPDATE position_state SET out_of_range_since = NULL, last_updated = ? WHERE position = ?",
      now,
      position_address
    );
    log("state", `Position ${position_address} back in range`);
  }
  return null;
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 * Accepts an optional preloaded out_of_range_since timestamp to avoid a redundant DB read.
 */
export function minutesOutOfRange(
  position_address: string,
  preloadedSince?: string | null
): number {
  const oorSince =
    preloadedSince !== undefined
      ? preloadedSince
      : (get<{ out_of_range_since: string | null }>(
          "SELECT out_of_range_since FROM position_state WHERE position = ?",
          position_address
        )?.out_of_range_since ?? null);
  if (!oorSince) return 0;
  const ms = Date.now() - new Date(oorSince).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address: string, fees_usd: number): void {
  const pos = getTrackedPosition(position_address);
  if (!pos) return;

  const now = new Date().toISOString();
  const note = `Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${now}`;
  const newNotes = [...pos.notes, note];
  const newTotalFees = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);

  run(
    "UPDATE position_state SET last_claim_at = ?, total_fees_claimed_usd = ?, notes = ?, last_updated = ? WHERE position = ?",
    now,
    newTotalFees,
    stringifyJson(newNotes),
    now,
    position_address
  );
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address: string, reason: string): void {
  const pos = getTrackedPosition(position_address);
  if (!pos) return;

  const now = new Date().toISOString();
  const note = `Closed at ${now}: ${reason}`;
  const newNotes = [...pos.notes, note];

  transaction(() => {
    run(
      "UPDATE position_state SET closed = 1, closed_at = ?, notes = ?, last_updated = ? WHERE position = ?",
      now,
      stringifyJson(newNotes),
      now,
      position_address
    );

    pushEvent({
      action: "close",
      position: position_address,
      pool_name: pos.pool_name || pos.pool,
      reason,
    });
  });

  // Clear any pending confirmation timers to prevent memory leaks
  clearAllConfirmationTimers(position_address);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Record a rebalance (close + redeploy).
 */
export function recordRebalance(old_position: string, new_position: string): void {
  const oldPos = getTrackedPosition(old_position);
  const newPos = getTrackedPosition(new_position);

  if (!oldPos && !newPos) return;

  const now = new Date().toISOString();

  transaction(() => {
    if (oldPos) {
      const oldNote = `Rebalanced into ${new_position} at ${now}`;
      run(
        "UPDATE position_state SET closed = 1, closed_at = ?, notes = ?, last_updated = ? WHERE position = ?",
        now,
        stringifyJson([...oldPos.notes, oldNote]),
        now,
        old_position
      );
      clearAllConfirmationTimers(old_position);
    }

    if (newPos) {
      const newRebalanceCount = (oldPos?.rebalance_count || 0) + 1;
      const newNote = `Rebalanced from ${old_position}`;
      run(
        "UPDATE position_state SET rebalance_count = ?, notes = ?, last_updated = ? WHERE position = ?",
        newRebalanceCount,
        stringifyJson([...newPos.notes, newNote]),
        now,
        new_position
      );
    }
  });
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(
  position_address: string,
  instruction: string | null
): boolean {
  const pos = getTrackedPosition(position_address);
  if (!pos) return false;

  const sanitized = sanitizeStoredText(instruction);
  const now = new Date().toISOString();

  run(
    "UPDATE position_state SET instruction = ?, last_updated = ? WHERE position = ?",
    sanitized,
    now,
    position_address
  );

  log("state", `Position ${position_address} instruction set: ${sanitized}`);
  return true;
}

/**
 * Queue a peak PnL confirmation for trailing take-profit.
 */
export function queuePeakConfirmation(
  position_address: string,
  candidatePnlPct: number | null,
  preloaded?: TrackedPosition | null
): boolean {
  if (candidatePnlPct == null) return false;

  const pos = preloaded ?? getTrackedPosition(position_address);
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) return false;

  const changed = pos.pending_peak_pnl_pct == null || candidatePnlPct > pos.pending_peak_pnl_pct;
  if (!changed) return false;

  const now = new Date().toISOString();
  run(
    "UPDATE position_state SET pending_peak_pnl_pct = ?, pending_peak_started_at = ?, last_updated = ? WHERE position = ?",
    candidatePnlPct,
    now,
    now,
    position_address
  );

  log(
    "state",
    `Position ${position_address} peak candidate ${candidatePnlPct.toFixed(2)}% queued for 15s confirmation`
  );
  return true;
}

/**
 * Resolve a pending peak confirmation after recheck delay.
 */
export function resolvePendingPeak(
  position_address: string,
  currentPnlPct: number | null,
  toleranceRatio: number = TRAILING_PEAK_CONFIRM_TOLERANCE
): PeakConfirmation {
  const pos = getTrackedPosition(position_address);
  if (!pos || pos.closed || pos.pending_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingPeak = pos.pending_peak_pnl_pct;
  const now = new Date().toISOString();

  if (currentPnlPct != null && currentPnlPct >= pendingPeak * toleranceRatio) {
    const newPeak = Math.max(pos.peak_pnl_pct ?? 0, pendingPeak, currentPnlPct);
    run(
      "UPDATE position_state SET peak_pnl_pct = ?, pending_peak_pnl_pct = NULL, pending_peak_started_at = NULL, last_updated = ? WHERE position = ?",
      newPeak,
      now,
      position_address
    );
    log(
      "state",
      `Position ${position_address} peak PnL confirmed at ${newPeak.toFixed(2)}% after recheck`
    );
    return { confirmed: true, peak: newPeak, pending: false };
  }

  // Rejected - clear pending
  run(
    "UPDATE position_state SET pending_peak_pnl_pct = NULL, pending_peak_started_at = NULL, last_updated = ? WHERE position = ?",
    now,
    position_address
  );

  log(
    "state",
    `Position ${position_address} rejected pending peak ${pendingPeak.toFixed(2)}% after 15s recheck (current: ${currentPnlPct ?? "?"}%)`
  );
  return { confirmed: false, rejected: true, pendingPeak, pending: false };
}

/**
 * Queue a trailing drop confirmation for trailing take-profit exit.
 */
export function queueTrailingDropConfirmation(
  position_address: string,
  peakPnlPct: number | null,
  currentPnlPct: number | null,
  trailingDropPct: number | null
): boolean {
  if (peakPnlPct == null || currentPnlPct == null || trailingDropPct == null) return false;

  const pos = getTrackedPosition(position_address);
  if (!pos || pos.closed) return false;

  const changed =
    pos.pending_trailing_peak_pnl_pct == null ||
    peakPnlPct !== pos.pending_trailing_peak_pnl_pct ||
    currentPnlPct !== pos.pending_trailing_current_pnl_pct;

  if (!changed) return false;

  const now = new Date().toISOString();
  run(
    "UPDATE position_state SET pending_trailing_peak_pnl_pct = ?, pending_trailing_current_pnl_pct = ?, pending_trailing_drop_pct = ?, pending_trailing_started_at = ?, last_updated = ? WHERE position = ?",
    peakPnlPct,
    currentPnlPct,
    trailingDropPct,
    now,
    now,
    position_address
  );

  log(
    "state",
    `Position ${position_address} trailing drop queued for 15s confirmation (peak: ${peakPnlPct.toFixed(2)}%, current: ${currentPnlPct.toFixed(2)}%)`
  );
  return true;
}

/**
 * Resolve a pending trailing drop confirmation after recheck delay.
 */
export function resolvePendingTrailingDrop(
  position_address: string,
  currentPnlPct: number | null,
  trailingDropPct: number | null,
  tolerancePct: number = TRAILING_DROP_CONFIRM_TOLERANCE_PCT
): TrailingConfirmation {
  const pos = getTrackedPosition(position_address);
  if (!pos || pos.closed || pos.pending_trailing_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingPeak = pos.pending_trailing_peak_pnl_pct;
  const pendingCurrent = pos.pending_trailing_current_pnl_pct;
  const pendingDrop = pos.pending_trailing_drop_pct ?? trailingDropPct ?? 0;
  const now = new Date().toISOString();

  if (currentPnlPct == null) {
    // Clear pending state
    run(
      "UPDATE position_state SET pending_trailing_peak_pnl_pct = NULL, pending_trailing_current_pnl_pct = NULL, pending_trailing_drop_pct = NULL, pending_trailing_started_at = NULL, last_updated = ? WHERE position = ?",
      now,
      position_address
    );
    return { confirmed: false, rejected: true, pending: false };
  }

  // Recalculate drop with current PnL
  const dropFromPeak = pendingPeak - currentPnlPct;
  const expectedDrop = pendingCurrent != null ? pendingPeak - pendingCurrent : pendingDrop;

  // Confirm if drop is still within tolerance of what was detected
  const dropDiff = Math.abs(dropFromPeak - expectedDrop);
  if (dropDiff <= tolerancePct && dropFromPeak >= (trailingDropPct ?? 0) * 0.9) {
    // Set confirmed exit with 5-minute cooldown
    const exitReason = `Trailing TP: peak ${pendingPeak.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}%)`;
    const exitUntil = new Date(Date.now() + TRAILING_EXIT_COOLDOWN_MS).toISOString();

    run(
      "UPDATE position_state SET confirmed_trailing_exit_reason = ?, confirmed_trailing_exit_until = ?, pending_trailing_peak_pnl_pct = NULL, pending_trailing_current_pnl_pct = NULL, pending_trailing_drop_pct = NULL, pending_trailing_started_at = NULL, last_updated = ? WHERE position = ?",
      exitReason,
      exitUntil,
      now,
      position_address
    );

    log(
      "state",
      `Position ${position_address} trailing drop confirmed after recheck (drop: ${dropFromPeak.toFixed(2)}%)`
    );
    return { confirmed: true, pending: false };
  }

  // Rejected - clear pending
  run(
    "UPDATE position_state SET pending_trailing_peak_pnl_pct = NULL, pending_trailing_current_pnl_pct = NULL, pending_trailing_drop_pct = NULL, pending_trailing_started_at = NULL, last_updated = ? WHERE position = ?",
    now,
    position_address
  );

  log(
    "state",
    `Position ${position_address} trailing drop rejected after recheck (detected drop: ${expectedDrop.toFixed(2)}%, current drop: ${dropFromPeak.toFixed(2)}%)`
  );
  return { confirmed: false, rejected: true, pending: false };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly: boolean = false): TrackedPosition[] {
  let sql = "SELECT * FROM position_state";
  const params: unknown[] = [];

  if (openOnly) {
    sql += " WHERE closed = 0";
  }

  const rows = query<Record<string, unknown>>(sql, ...params);
  return rows.map(rowToTrackedPosition);
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address: string): TrackedPosition | null {
  const row = get<Record<string, unknown>>(
    "SELECT * FROM position_state WHERE position = ?",
    position_address
  );
  if (!row) return null;
  return rowToTrackedPosition(row);
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary(): StateSummary {
  const counts = get<{ open_count: number; closed_count: number; total_fees: number }>(`
    SELECT 
      SUM(CASE WHEN closed = 0 THEN 1 ELSE 0 END) as open_count,
      SUM(CASE WHEN closed = 1 THEN 1 ELSE 0 END) as closed_count,
      COALESCE(SUM(total_fees_claimed_usd), 0) as total_fees
    FROM position_state
  `);

  const openPositions = query<Record<string, unknown>>(
    "SELECT * FROM position_state WHERE closed = 0 ORDER BY deployed_at DESC"
  );

  const recentEvents = query<Record<string, unknown>>(
    "SELECT * FROM position_state_events ORDER BY ts DESC LIMIT 10"
  ).map(rowToStateEvent);

  // Reverse to get chronological order
  recentEvents.reverse();

  return {
    open_positions: counts?.open_count ?? 0,
    closed_positions: counts?.closed_count ?? 0,
    total_fees_claimed_usd: Math.round((counts?.total_fees ?? 0) * 100) / 100,
    positions: openPositions.map((row) => {
      const pos = rowToTrackedPosition(row);
      return {
        position: pos.position,
        pool: pos.pool,
        strategy: pos.strategy,
        deployed_at: pos.deployed_at,
        out_of_range_since: pos.out_of_range_since,
        minutes_out_of_range: minutesOutOfRange(pos.position),
        total_fees_claimed_usd: pos.total_fees_claimed_usd,
        initial_fee_tvl_24h: pos.initial_fee_tvl_24h,
        rebalance_count: pos.rebalance_count,
        instruction: pos.instruction || null,
      };
    }),
    last_updated: new Date().toISOString(),
    recent_events: recentEvents,
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * Delegates exit condition evaluation to exit-rules module.
 */
export function updatePnlAndCheckExits(
  position_address: string,
  positionData: PositionData,
  mgmtConfig: ManagementConfig,
  strategyConfig?: import("../types/strategy.js").Strategy | null,
  preloaded?: TrackedPosition | null
): ExitAction | null {
  const { in_range } = positionData;
  const pos = preloaded ?? getTrackedPosition(position_address);
  if (!pos || pos.closed) return null;

  // Check if we're in a confirmed trailing exit cooldown period
  if (pos.confirmed_trailing_exit_until) {
    const until = new Date(pos.confirmed_trailing_exit_until).getTime();
    if (Date.now() < until) {
      return {
        action: "TRAILING_TP",
        reason: pos.confirmed_trailing_exit_reason || "Trailing TP (confirmed)",
        needs_confirmation: false,
      };
    }
    // Clear expired cooldown
    const now = new Date().toISOString();
    run(
      "UPDATE position_state SET confirmed_trailing_exit_until = NULL, confirmed_trailing_exit_reason = NULL, last_updated = ? WHERE position = ?",
      now,
      position_address
    );
  }

  let changed = false;
  const now = new Date().toISOString();

  // Activate trailing TP once trigger threshold is reached
  if (shouldActivateTrailingTP(pos, mgmtConfig)) {
    run(
      "UPDATE position_state SET trailing_active = 1, last_updated = ? WHERE position = ?",
      now,
      position_address
    );
    changed = true;
    log(
      "state",
      `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`
    );
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    run(
      "UPDATE position_state SET out_of_range_since = ?, last_updated = ? WHERE position = ?",
      now,
      now,
      position_address
    );
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    run(
      "UPDATE position_state SET out_of_range_since = NULL, last_updated = ? WHERE position = ?",
      now,
      position_address
    );
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  // Reload position if changed
  const currentPos = changed ? getTrackedPosition(position_address)! : pos;

  // Delegate exit condition evaluation to exit-rules module
  // If no strategyConfig was passed, try loading from the tracked position
  const resolvedStrategyConfig = strategyConfig ?? currentPos.strategy_config ?? null;
  return evaluateExitConditions(currentPos, positionData, mgmtConfig, resolvedStrategyConfig);
}

// ═══════════════════════════════════════════════════════════════════════════
// Briefing Tracking
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate(): string | null {
  const row = get<{ value: string }>(
    "SELECT value FROM state_metadata WHERE key = 'last_briefing_date'"
  );
  return row?.value ?? null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate(): void {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  run(
    `INSERT INTO state_metadata (key, value) VALUES ('last_briefing_date', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    today
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// State Sync
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
export function syncOpenPositions(active_addresses: string[]): void {
  const activeSet = new Set(active_addresses);
  const openPositions = getTrackedPositions(true);

  const now = new Date().toISOString();

  for (const pos of openPositions) {
    if (activeSet.has(pos.position)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_PERIOD_MS) {
      log(
        "state",
        `Position ${pos.position} not on-chain yet — within grace period, skipping auto-close`
      );
      continue;
    }

    const note = `Auto-closed during state sync (not found on-chain)`;
    run(
      "UPDATE position_state SET closed = 1, closed_at = ?, notes = ?, last_updated = ? WHERE position = ?",
      now,
      stringifyJson([...pos.notes, note]),
      now,
      pos.position
    );

    // Clear any pending confirmation timers to prevent memory leaks
    clearAllConfirmationTimers(pos.position);
    log("state", `Position ${pos.position} auto-closed (missing from on-chain data)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON Export for Debugging
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Export current state to JSON file for debugging/backup.
 * This is a one-way export - data is read from SQLite and written to state.json.
 */
export function exportStateToJson(): void {
  exportToJson();
  log("state", "State exported to state.json for debugging");
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Registrations
// ═══════════════════════════════════════════════════════════════════════════

registerTool({
  name: "set_position_note",
  handler: (args: unknown) => {
    const { position_address, instruction } = args as SetPositionNoteArgs;
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  roles: ["GENERAL"],
});
