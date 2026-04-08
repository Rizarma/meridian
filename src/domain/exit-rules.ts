/**
 * Exit Rules — Single source of truth for all position exit logic.
 *
 * This module consolidates exit condition evaluation from:
 * - index.ts runManagementCycle() (deterministic rule checks)
 * - state.ts updatePnlAndCheckExits() (trailing TP, OOR tracking)
 *
 * Pattern: Domain-Driven Structure + Single Responsibility Principle
 */

import { config } from "../config/config.js";
import type { EnrichedPosition } from "../types/dlmm.js";
import type { ActionDecision } from "../types/orchestrator.js";
import type {
  ExitAction,
  ManagementConfig,
  PositionData,
  TrackedPosition,
} from "../types/state.js";
import type { Strategy } from "../types/strategy.js";

/**
 * Evaluate all exit conditions for a position and return an exit action if triggered.
 * This is the main entry point used by state.ts updatePnlAndCheckExits().
 */
export function evaluateExitConditions(
  position: TrackedPosition,
  positionData: PositionData,
  mgmtConfig: ManagementConfig,
  _strategyConfig?: Strategy | null
): ExitAction | null {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, fee_per_tvl_24h, age_minutes } = positionData;

  // Check if we're in a confirmed trailing exit cooldown period
  if (position.confirmed_trailing_exit_until) {
    const until = new Date(position.confirmed_trailing_exit_until).getTime();
    if (Date.now() < until) {
      return {
        action: "TRAILING_TP",
        reason: position.confirmed_trailing_exit_reason || "Trailing TP (confirmed)",
        needs_confirmation: false,
      };
    }
  }

  // ── Stop loss ──────────────────────────────────────────────────
  if (shouldStopLoss(currentPnlPct, pnl_pct_suspicious, mgmtConfig)) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct?.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── Trailing TP ────────────────────────────────────────────────
  const trailingExit = evaluateTrailingTP(position, currentPnlPct, pnl_pct_suspicious, mgmtConfig);
  if (trailingExit) return trailingExit;

  // ── Out of range too long ──────────────────────────────────────
  if (shouldCloseOOR(position, mgmtConfig)) {
    const minutesOOR = calculateMinutesOOR(position);
    return {
      action: "OUT_OF_RANGE",
      reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
    };
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  if (shouldCloseLowYield(fee_per_tvl_24h, age_minutes, mgmtConfig)) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h?.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

/**
 * Evaluate deterministic exit rules for the management cycle.
 * This is used by index.ts runManagementCycle() for the actionMap construction.
 * Returns an ActionDecision or null if no exit rule triggers.
 */
export function evaluateManagementExitRules(
  position: EnrichedPosition,
  mgmtConfig: ManagementConfig,
  pnlSuspect: boolean,
  strategyConfig?: Strategy | null
): ActionDecision | null {
  // Rule 1: stop loss
  const stopLossPct = mgmtConfig.stopLossPct ?? -0.05; // Default 5% loss
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }

  // Rule 2: take profit
  // Use strategy-specific take_profit_pct if available, otherwise fall back to global config
  const takeProfitPct =
    strategyConfig?.exit?.take_profit_pct ?? mgmtConfig.takeProfitFeePct ?? 0.02; // Default 2% profit

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }

  // Rule 3: pumped far above range
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + (mgmtConfig.outOfRangeBinsToClose ?? 10)
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }

  // Rule 4: stale above range (OOR)
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= (mgmtConfig.outOfRangeWaitMinutes ?? 30)
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }

  // Rule 5: fee yield too low
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < (mgmtConfig.minFeePerTvl24h ?? 7) &&
    (position.age_minutes ?? 0) >= (mgmtConfig.minAgeBeforeYieldCheck ?? 60)
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }

  // Claim rule
  if ((position.unclaimed_fees_usd ?? 0) >= (mgmtConfig.minClaimAmount ?? 5)) {
    return { action: "CLAIM" };
  }

  return null;
}

/**
 * Check if stop loss should trigger.
 */
export function shouldStopLoss(
  pnlPct: number | null | undefined,
  pnlSuspicious: boolean | undefined,
  config: ManagementConfig
): boolean {
  if (pnlSuspicious) return false;
  if (pnlPct == null) return false;
  if (config.stopLossPct == null) return false;
  return pnlPct <= config.stopLossPct;
}

/**
 * Check if take profit should trigger.
 */
export function shouldTakeProfit(
  pnlPct: number | null | undefined,
  pnlSuspicious: boolean | undefined,
  config: ManagementConfig
): boolean {
  if (pnlSuspicious) return false;
  if (pnlPct == null) return false;
  if (config.takeProfitFeePct == null) return false;
  return pnlPct >= config.takeProfitFeePct;
}

/**
 * Check if position should close due to being out of range too long.
 */
export function shouldCloseOOR(position: TrackedPosition, config: ManagementConfig): boolean {
  if (!position.out_of_range_since) return false;
  const minutesOOR = calculateMinutesOOR(position);
  return minutesOOR >= (config.outOfRangeWaitMinutes ?? 30);
}

/**
 * Check if position should close due to low yield.
 */
export function shouldCloseLowYield(
  feePerTvl24h: number | null | undefined,
  ageMinutes: number | null | undefined,
  config: ManagementConfig
): boolean {
  if (feePerTvl24h == null) return false;
  if (config.minFeePerTvl24h == null) return false;
  if (feePerTvl24h >= config.minFeePerTvl24h) return false;

  const minAge = config.minAgeBeforeYieldCheck ?? 60;
  if (ageMinutes == null || ageMinutes < minAge) return false;

  return true;
}

/**
 * Evaluate trailing take-profit conditions.
 * Returns ExitAction if trailing TP should trigger, null otherwise.
 */
export function evaluateTrailingTP(
  position: TrackedPosition,
  currentPnlPct: number | null,
  pnlSuspicious: boolean | undefined,
  mgmtConfig: ManagementConfig
): ExitAction | null {
  if (!config.features.trailingTakeProfit) return null;
  if (pnlSuspicious) return null;
  if (currentPnlPct == null) return null;

  // Check if trailing is active (peak has reached trigger threshold)
  if (!position.trailing_active) return null;

  const dropFromPeak = (position.peak_pnl_pct ?? 0) - currentPnlPct;
  const trailingDropPct = mgmtConfig.trailingDropPct ?? 1.5;

  if (dropFromPeak >= trailingDropPct) {
    return {
      action: "TRAILING_TP",
      reason: `Trailing TP: peak ${position.peak_pnl_pct?.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${trailingDropPct}%)`,
      needs_confirmation: true,
      peak_pnl_pct: position.peak_pnl_pct,
      current_pnl_pct: currentPnlPct,
    };
  }

  return null;
}

/**
 * Check if trailing take-profit should be activated.
 * Call this when peak PnL is confirmed to potentially activate trailing mode.
 */
export function shouldActivateTrailingTP(
  position: TrackedPosition,
  mgmtConfig: ManagementConfig
): boolean {
  if (!config.features.trailingTakeProfit) return false;
  if (position.trailing_active) return false;

  const triggerPct = mgmtConfig.trailingTriggerPct ?? 3;
  return (position.peak_pnl_pct ?? 0) >= triggerPct;
}

/**
 * Calculate minutes a position has been out of range.
 */
export function calculateMinutesOOR(position: TrackedPosition): number {
  if (!position.out_of_range_since) return 0;
  const ms = Date.now() - new Date(position.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Check if position is pumped far above its range (active bin > upper bin + threshold).
 */
export function isPumpedFarAboveRange(
  activeBin: number | null | undefined,
  upperBin: number | null | undefined,
  outOfRangeBinsToClose: number = 10
): boolean {
  if (activeBin == null || upperBin == null) return false;
  return activeBin > upperBin + outOfRangeBinsToClose;
}

/**
 * Check if position is above its range (active bin > upper bin).
 */
export function isAboveRange(
  activeBin: number | null | undefined,
  upperBin: number | null | undefined
): boolean {
  if (activeBin == null || upperBin == null) return false;
  return activeBin > upperBin;
}

/**
 * Check if position is below its range (active bin < lower bin).
 */
export function isBelowRange(
  activeBin: number | null | undefined,
  lowerBin: number | null | undefined
): boolean {
  if (activeBin == null || lowerBin == null) return false;
  return activeBin < lowerBin;
}
