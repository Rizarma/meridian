/**
 * Threshold Evolution Domain Module
 *
 * Handles post-position-close evolution of screening thresholds and
 * related cross-module updates. Extracted from lessons.ts to break
 * circular dependencies.
 *
 * This module imports from lessons, pool-memory, signal-weights, hive-mind,
 * and config — all one-directional, no circular risk.
 */

import fs from "fs";
import { config, reloadScreeningThresholds } from "../config/config.js";
import { USER_CONFIG_PATH } from "../config/paths.js";
import { syncToHive } from "../infrastructure/hive-mind.js";
import { log } from "../infrastructure/logger.js";
import type { Config } from "../types/config.js";
import type {
  EvolutionResult,
  PerformanceRecord,
  PositionPerformance,
  ThresholdEvolution,
} from "../types/lessons.js";
import { recordPoolDeploy } from "./pool-memory.js";
import { recalculateWeights } from "./signal-weights.js";

const MIN_EVOLVE_POSITIONS = 5;
const MAX_CHANGE_PER_STEP = 0.2;

// ─── Post-Close Evolution Orchestrator ─────────────────────────

/**
 * Run all post-position-close evolution tasks.
 * Called from recordPerformance() after saving the performance record.
 */
export async function runThresholdEvolution(
  perf: PositionPerformance,
  performanceHistory: PerformanceRecord[]
): Promise<void> {
  // Calculate derived metrics
  const pnl_usd = perf.final_value_usd + perf.fees_earned_usd - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0 ? (pnl_usd / perf.initial_value_usd) * 100 : 0;
  const range_efficiency =
    perf.minutes_held > 0 ? (perf.minutes_in_range / perf.minutes_held) * 100 : 0;

  // 1. Update pool-level memory
  if (perf.pool) {
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: new Date().toISOString(),
      pnl_pct,
      pnl_usd,
      range_efficiency,
      minutes_held: perf.minutes_held,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
    });
  }

  // 2. Evolve thresholds every 5 closed positions
  if (performanceHistory.length % MIN_EVOLVE_POSITIONS === 0) {
    const result = evolveThresholds(performanceHistory, config as Config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadScreeningThresholds();
      log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    }

    // 3. Darwinian signal weight recalculation
    if (config.darwin?.enabled) {
      const wResult = recalculateWeights(performanceHistory, { darwin: config.darwin });
      if (wResult.changes.length > 0) {
        log("evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
      }
    }
  }

  // 4. Fire-and-forget sync to hive mind (if enabled)
  syncToHive().catch(() => {});
}

// ─── Threshold Evolution Algorithm ──────────────────────────────

/**
 * Analyze closed position performance and evolve screening thresholds.
 * Writes changes to user-config.json and returns a summary.
 */
export function evolveThresholds(
  perfData: PerformanceRecord[],
  cfg: Config
): EvolutionResult | null {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  const winners = perfData.filter((p) => p.pnl_pct > 0);
  const losers = perfData.filter((p) => p.pnl_pct < -5);

  // Need at least some signal in both directions before adjusting
  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) return null;

  const changes: ThresholdEvolution = {};
  const rationale: Record<string, string> = {};

  // ── 1. maxVolatility ─────────────────────────────────────────
  {
    const winnerVols = winners.map((p) => p.volatility).filter(isFiniteNum);
    const loserVols = losers.map((p) => p.volatility).filter(isFiniteNum);
    const current = cfg.screening.maxVolatility;

    if (loserVols.length >= 2 && current !== null && current !== undefined) {
      const loserP25 = percentile(loserVols, 25);
      if (loserP25 < current) {
        const target = loserP25 * 1.15;
        const newVal = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 1.0, 20.0);
        const rounded = Number(newVal.toFixed(1));
        if (rounded < current) {
          changes.maxVolatility = rounded;
          rationale.maxVolatility = `Losers clustered at volatility ~${loserP25.toFixed(1)} — tightened from ${current} → ${rounded}`;
        }
      }
    } else if (
      winnerVols.length >= 3 &&
      losers.length === 0 &&
      current !== null &&
      current !== undefined
    ) {
      const winnerP75 = percentile(winnerVols, 75);
      if (winnerP75 > current * 1.1) {
        const target = winnerP75 * 1.1;
        const newVal = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 1.0, 20.0);
        const rounded = Number(newVal.toFixed(1));
        if (rounded > current) {
          changes.maxVolatility = rounded;
          rationale.maxVolatility = `All ${winners.length} positions profitable — loosened from ${current} → ${rounded}`;
        }
      }
    }
  }

  // ── 2. minFeeActiveTvlRatio ─────────────────────────────────────────
  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current = cfg.screening.minFeeActiveTvlRatio;

    if (winnerFees.length >= 2 && current !== undefined) {
      const minWinnerFee = Math.min(...winnerFees);
      if (minWinnerFee > current * 1.2) {
        const target = minWinnerFee * 0.85;
        const newVal = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Lowest winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor from ${current} → ${rounded}`;
        }
      }
    }

    if (loserFees.length >= 2 && current !== undefined) {
      const maxLoserFee = Math.max(...loserFees);
      if (maxLoserFee < current * 1.5 && winnerFees.length > 0) {
        const minWinnerFee = Math.min(...winnerFees);
        if (minWinnerFee > maxLoserFee) {
          const target = maxLoserFee * 1.2;
          const newVal = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
          const rounded = Number(newVal.toFixed(2));
          if (rounded > current && !changes.minFeeActiveTvlRatio) {
            changes.minFeeActiveTvlRatio = rounded;
            rationale.minFeeActiveTvlRatio = `Losers had fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised floor from ${current} → ${rounded}`;
          }
        }
      }
    }
  }

  // ── 3. minOrganic ─────────────────────────────────────────────
  {
    const loserOrganics = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current = cfg.screening.minOrganic;

    if (loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
      const avgLoserOrganic = avg(loserOrganics);
      const avgWinnerOrganic = avg(winnerOrganics);
      if (avgWinnerOrganic - avgLoserOrganic >= 10) {
        const minWinnerOrganic = Math.min(...winnerOrganics);
        const target = Math.max(minWinnerOrganic - 3, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 60, 90);
        if (newVal > current) {
          changes.minOrganic = newVal;
          rationale.minOrganic = `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // ── Persist changes to user-config.json ───────────────────────
  let userConfig: Record<string, unknown> = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    } catch {
      /* ignore */
    }
  }

  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = perfData.length;

  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  // Apply to live config object immediately
  const s = cfg.screening;
  if (changes.maxVolatility != null)
    (s as unknown as Record<string, number>).maxVolatility = changes.maxVolatility;
  if (changes.minFeeActiveTvlRatio != null)
    (s as unknown as Record<string, number>).minFeeActiveTvlRatio = changes.minFeeActiveTvlRatio;
  if (changes.minOrganic != null) s.minOrganic = changes.minOrganic;

  return { changes, rationale };
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && isFinite(n);
}

function avg(arr: number[]): number {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/** Move current toward target by at most maxChange fraction. */
function nudge(current: number, target: number, maxChange: number): number {
  const delta = target - current;
  const maxDelta = current * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}
