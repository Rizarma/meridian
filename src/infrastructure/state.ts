/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { registerTool } from "../../tools/registry.js";
import {
  MAX_INSTRUCTION_LENGTH,
  MAX_RECENT_EVENTS,
  SYNC_GRACE_PERIOD_MS,
  TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
  TRAILING_EXIT_COOLDOWN_MS,
  TRAILING_PEAK_CONFIRM_TOLERANCE,
} from "../config/constants.js";
import { evaluateExitConditions, shouldActivateTrailingTP } from "../domain/exit-rules.js";
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
import { log } from "./logger.js";

const STATE_FILE = "./state.json";

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
}

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

function load(): PositionState {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as PositionState;
  } catch (err) {
    log("state_error", `Failed to read state.json: ${(err as Error).message}`);
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
}

function save(state: PositionState): void {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${(err as Error).message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

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
}: TrackPositionParams): void {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
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
    deployed_at: new Date().toISOString(),
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
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address: string): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address: string): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address: string): number {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address: string, fees_usd: number): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state: PositionState, event: Omit<StateEvent, "ts">): void {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address: string, reason: string): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, {
    action: "close",
    position: position_address,
    pool_name: pos.pool_name || pos.pool,
    reason,
  });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Record a rebalance (close + redeploy).
 */
export function recordRebalance(old_position: string, new_position: string): void {
  const state = load();
  const old = state.positions[old_position];
  if (old) {
    old.closed = true;
    old.closed_at = new Date().toISOString();
    old.notes.push(`Rebalanced into ${new_position} at ${old.closed_at}`);
  }
  const newPos = state.positions[new_position];
  if (newPos) {
    newPos.rebalance_count = (old?.rebalance_count || 0) + 1;
    newPos.notes.push(`Rebalanced from ${old_position}`);
  }
  save(state);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(
  position_address: string,
  instruction: string | null
): boolean {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

/**
 * Queue a peak PnL confirmation for trailing take-profit.
 */
export function queuePeakConfirmation(
  position_address: string,
  candidatePnlPct: number | null
): boolean {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) return false;

  const changed = pos.pending_peak_pnl_pct == null || candidatePnlPct > pos.pending_peak_pnl_pct;

  if (!changed) return false;

  pos.pending_peak_pnl_pct = candidatePnlPct;
  pos.pending_peak_started_at = new Date().toISOString();
  save(state);
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
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingPeak = pos.pending_peak_pnl_pct;
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_started_at = null;

  if (currentPnlPct != null && currentPnlPct >= pendingPeak * toleranceRatio) {
    pos.peak_pnl_pct = Math.max(pos.peak_pnl_pct ?? 0, pendingPeak, currentPnlPct);
    save(state);
    log(
      "state",
      `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% after recheck`
    );
    return { confirmed: true, peak: pos.peak_pnl_pct, pending: false };
  }

  save(state);
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
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const changed =
    pos.pending_trailing_peak_pnl_pct == null ||
    peakPnlPct !== pos.pending_trailing_peak_pnl_pct ||
    currentPnlPct !== pos.pending_trailing_current_pnl_pct;

  if (!changed) return false;

  pos.pending_trailing_peak_pnl_pct = peakPnlPct;
  pos.pending_trailing_current_pnl_pct = currentPnlPct;
  pos.pending_trailing_drop_pct = trailingDropPct;
  pos.pending_trailing_started_at = new Date().toISOString();
  save(state);
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
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_trailing_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingPeak = pos.pending_trailing_peak_pnl_pct;
  const pendingCurrent = pos.pending_trailing_current_pnl_pct;
  const pendingDrop = pos.pending_trailing_drop_pct ?? trailingDropPct ?? 0;

  // Clear pending state
  pos.pending_trailing_peak_pnl_pct = null;
  pos.pending_trailing_current_pnl_pct = null;
  pos.pending_trailing_drop_pct = null;
  pos.pending_trailing_started_at = null;

  if (currentPnlPct == null) {
    save(state);
    return { confirmed: false, rejected: true, pending: false };
  }

  // Recalculate drop with current PnL
  const dropFromPeak = pendingPeak - currentPnlPct;
  const expectedDrop = pendingCurrent != null ? pendingPeak - pendingCurrent : pendingDrop;

  // Confirm if drop is still within tolerance of what was detected
  const dropDiff = Math.abs(dropFromPeak - expectedDrop);
  if (dropDiff <= tolerancePct && dropFromPeak >= (trailingDropPct ?? 0) * 0.9) {
    // Set confirmed exit with 5-minute cooldown
    pos.confirmed_trailing_exit_reason = `Trailing TP: peak ${pendingPeak.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}%)`;
    pos.confirmed_trailing_exit_until = new Date(
      Date.now() + TRAILING_EXIT_COOLDOWN_MS
    ).toISOString();
    save(state);
    log(
      "state",
      `Position ${position_address} trailing drop confirmed after recheck (drop: ${dropFromPeak.toFixed(2)}%)`
    );
    return { confirmed: true, pending: false };
  }

  save(state);
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
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address: string): TrackedPosition | null {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary(): StateSummary {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions).reduce(
    (sum, p) => sum + (p.total_fees_claimed_usd || 0),
    0
  );

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
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
  mgmtConfig: ManagementConfig
): ExitAction | null {
  const { in_range } = positionData;
  const state = load();
  const pos = state.positions[position_address];
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
    pos.confirmed_trailing_exit_until = null;
    pos.confirmed_trailing_exit_reason = null;
    save(state);
  }

  let changed = false;

  // Activate trailing TP once trigger threshold is reached
  if (shouldActivateTrailingTP(pos, mgmtConfig)) {
    pos.trailing_active = true;
    changed = true;
    log(
      "state",
      `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`
    );
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  // Delegate exit condition evaluation to exit-rules module
  return evaluateExitConditions(pos, positionData, mgmtConfig);
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate(): string | null {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate(): void {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
export function syncOpenPositions(active_addresses: string[]): void {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_PERIOD_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
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
