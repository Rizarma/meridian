/**
 * Darwinian signal weighting system.
 *
 * Tracks which screening signals actually predict profitable positions
 * and adjusts their weights over time. Signals that consistently appear
 * in winners get boosted; those associated with losers get decayed.
 *
 * Weights are persisted in SQLite (signal_weights and signal_weight_history
 * tables) and injected into the LLM prompt so the agent can prioritize
 * the right screening criteria.
 */

import { get, query, run, transaction } from "../infrastructure/db.js";
import { log } from "../infrastructure/logger.js";
import type {
  PerformanceRecord,
  SignalWeights,
  WeightChange,
  WeightConfig,
  WeightHistoryEntry,
} from "../types/weights.js";

// ─── Signal Definitions ─────────────────────────────────────────

const SIGNAL_NAMES: string[] = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
];

const DEFAULT_WEIGHTS: Record<string, number> = Object.fromEntries(
  SIGNAL_NAMES.map((s) => [s, 1.0])
);

// Signals where higher values generally indicate better candidates
const HIGHER_IS_BETTER: Set<string> = new Set([
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "holder_count",
  "study_win_rate",
  "hive_consensus",
]);

// Boolean signals — compared by win rate when present vs absent
const BOOLEAN_SIGNALS: Set<string> = new Set(["smart_wallets_present"]);

// Categorical signals — compared by win rate across categories
const CATEGORICAL_SIGNALS: Set<string> = new Set(["narrative_quality"]);

// ─── Database Types ──────────────────────────────────────────────

interface SignalWeightRow {
  signal: string;
  weight: number;
  updated_at: string;
}

interface SignalWeightHistoryRow {
  id: number;
  signal: string;
  weight_from: number | null;
  weight_to: number;
  lift: number | null;
  action: string | null;
  window_size: number | null;
  win_count: number | null;
  loss_count: number | null;
  changed_at: string;
}

// ─── Persistence ─────────────────────────────────────────────────

export function loadWeights(): SignalWeights {
  try {
    // Query all signal weights from database
    const rows = query<SignalWeightRow>("SELECT signal, weight, updated_at FROM signal_weights");

    // Build weights record from database rows
    const weights: Record<string, number> = { ...DEFAULT_WEIGHTS };
    for (const row of rows) {
      weights[row.signal] = row.weight;
    }

    // Ensure all signals exist (handles new signals added after initial creation)
    for (const name of SIGNAL_NAMES) {
      if (weights[name] == null) weights[name] = 1.0;
    }

    // Get metadata from most recent history entry
    const latestHistory = get<{ changed_at: string }>(
      "SELECT changed_at FROM signal_weight_history ORDER BY changed_at DESC LIMIT 1"
    );

    // Get recalc count from history entries with window_size (recalc events)
    const recalcRow = get<{ count: number }>(
      "SELECT COUNT(DISTINCT changed_at) as count FROM signal_weight_history WHERE window_size IS NOT NULL"
    );

    // Load recent history entries (last 20 recalc events)
    const historyRows = query<SignalWeightHistoryRow>(
      `SELECT DISTINCT changed_at, window_size, win_count, loss_count
       FROM signal_weight_history
       WHERE window_size IS NOT NULL
       ORDER BY changed_at DESC
       LIMIT 20`
    );

    // Build history entries from database
    const history: WeightHistoryEntry[] = historyRows.map((row) => {
      // Get all changes for this recalc event
      const changeRows = query<SignalWeightHistoryRow>(
        `SELECT signal, weight_from, weight_to, lift, action
         FROM signal_weight_history
         WHERE changed_at = ? AND action IS NOT NULL`,
        row.changed_at
      );

      const changes: WeightChange[] = changeRows.map((c) => ({
        signal: c.signal,
        from: c.weight_from ?? 1.0,
        to: c.weight_to,
        lift: c.lift ?? 0,
        action: (c.action as "boosted" | "decayed") || "boosted",
      }));

      return {
        timestamp: row.changed_at,
        changes,
        window_size: row.window_size ?? 0,
        win_count: row.win_count ?? 0,
        loss_count: row.loss_count ?? 0,
      };
    });

    // Reverse to get chronological order
    history.reverse();

    return {
      weights,
      last_recalc: latestHistory?.changed_at || null,
      recalc_count: recalcRow?.count ?? 0,
      history,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("signal_weights_error", `Failed to load weights from database: ${errorMsg}`);

    // Return defaults on error
    return {
      weights: { ...DEFAULT_WEIGHTS },
      last_recalc: null,
      recalc_count: 0,
      history: [],
    };
  }
}

export function saveWeights(data: SignalWeights): void {
  try {
    transaction(() => {
      // Save each signal weight using INSERT OR REPLACE
      for (const [signal, weight] of Object.entries(data.weights)) {
        run(
          `INSERT OR REPLACE INTO signal_weights (signal, weight, updated_at)
           VALUES (?, ?, datetime('now'))`,
          signal,
          weight
        );
      }
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("signal_weights_error", `Failed to save weights to database: ${errorMsg}`);
  }
}

// ─── Core Algorithm ──────────────────────────────────────────────

interface RecalculateResult {
  changes: WeightChange[];
  weights: Record<string, number>;
  persisted: boolean;
}

interface RecalculateConfig {
  darwin?: WeightConfig;
}

/**
 * Recalculate signal weights based on actual position performance.
 *
 * @param perfData - Array of performance records (from lessons.json)
 * @param cfg - Live config object (reads cfg.darwin for tuning)
 * @returns Object containing changes and weights
 */
export function recalculateWeights(
  perfData: PerformanceRecord[],
  cfg: RecalculateConfig = {}
): RecalculateResult {
  const darwin = cfg.darwin || {};
  const windowDays = darwin.windowDays ?? 60;
  const minSamples = darwin.minSamples ?? 10;
  const boostFactor = darwin.boostFactor ?? 1.05;
  const decayFactor = darwin.decayFactor ?? 0.95;
  const weightFloor = darwin.weightFloor ?? 0.3;
  const weightCeiling = darwin.weightCeiling ?? 2.5;

  const data = loadWeights();
  const weights: Record<string, number> = data.weights || { ...DEFAULT_WEIGHTS };

  // Ensure all signals exist (handles new signals added after initial creation)
  for (const name of SIGNAL_NAMES) {
    if (weights[name] == null) weights[name] = 1.0;
  }

  // Filter to rolling window
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffISO = cutoff.toISOString();

  const recent = perfData.filter((p) => {
    const ts = p.recorded_at || p.closed_at || p.deployed_at;
    return ts && ts >= cutoffISO;
  });

  if (recent.length < minSamples) {
    log(
      "signal_weights",
      `Only ${recent.length} records in ${windowDays}d window (need ${minSamples}), skipping recalc`
    );
    return { changes: [], weights, persisted: false };
  }

  // Classify wins and losses
  const wins = recent.filter((p) => (p.pnl_usd ?? 0) > 0);
  const losses = recent.filter((p) => (p.pnl_usd ?? 0) <= 0);

  if (wins.length === 0 || losses.length === 0) {
    log(
      "signal_weights",
      `Need both wins (${wins.length}) and losses (${losses.length}) to compute lift, skipping`
    );
    return { changes: [], weights, persisted: false };
  }

  // Compute predictive lift for each signal
  const lifts: Record<string, number> = {};
  for (const signal of SIGNAL_NAMES) {
    const lift = computeLift(signal, wins, losses, minSamples);
    if (lift !== null) lifts[signal] = lift;
  }

  const ranked = Object.entries(lifts).sort((a, b) => b[1] - a[1]);

  if (ranked.length === 0) {
    log("signal_weights", "No signals had enough samples for lift calculation");
    return { changes: [], weights, persisted: false };
  }

  // Split into quartiles
  const q1End = Math.ceil(ranked.length * 0.25);
  const q3Start = Math.floor(ranked.length * 0.75);
  const topQuartile = new Set(ranked.slice(0, q1End).map(([name]) => name));
  const bottomQuartile = new Set(ranked.slice(q3Start).map(([name]) => name));

  // Apply boosts and decays
  const changes: WeightChange[] = [];
  for (const [signal, lift] of ranked) {
    const prev = weights[signal];
    let next = prev;

    if (topQuartile.has(signal)) {
      next = Math.min(prev * boostFactor, weightCeiling);
    } else if (bottomQuartile.has(signal)) {
      next = Math.max(prev * decayFactor, weightFloor);
    }

    next = Math.round(next * 1000) / 1000;

    if (next !== prev) {
      const dir: "boosted" | "decayed" = next > prev ? "boosted" : "decayed";
      changes.push({
        signal,
        from: prev,
        to: next,
        lift: Math.round(lift * 1000) / 1000,
        action: dir,
      });
      weights[signal] = next;
      log("signal_weights", `${signal}: ${prev} -> ${next} (${dir}, lift=${lift.toFixed(3)})`);
    }
  }

  // Persist to database
  const now = new Date().toISOString();

  try {
    transaction(() => {
      // Save updated weights
      for (const [signal, weight] of Object.entries(weights)) {
        run(
          `INSERT OR REPLACE INTO signal_weights (signal, weight, updated_at)
           VALUES (?, ?, ?)`,
          signal,
          weight,
          now
        );
      }

      // Save history entries for each change
      if (changes.length > 0) {
        for (const change of changes) {
          run(
            `INSERT INTO signal_weight_history
             (signal, weight_from, weight_to, lift, action, window_size, win_count, loss_count, changed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            change.signal,
            change.from,
            change.to,
            change.lift,
            change.action,
            recent.length,
            wins.length,
            losses.length,
            now
          );
        }
      }
    });

    log(
      "signal_weights",
      changes.length > 0
        ? `Recalculated: ${changes.length} weight(s) adjusted from ${recent.length} records`
        : `Recalculated: no changes needed (${recent.length} records, ${ranked.length} signals evaluated)`
    );

    return { changes, weights, persisted: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("signal_weights_error", `Failed to persist weights to database: ${errorMsg}`);
    // Return with persisted: false so caller knows persistence failed
    return { changes, weights, persisted: false };
  }
}

// ─── Lift Computation ────────────────────────────────────────────

interface WinLossEntry {
  w: boolean;
  snap: PerformanceRecord;
}

interface CategoricalBucket {
  wins: number;
  total: number;
}

function computeLift(
  signal: string,
  wins: PerformanceRecord[],
  losses: PerformanceRecord[],
  minSamples: number
): number | null {
  if (BOOLEAN_SIGNALS.has(signal)) return computeBooleanLift(signal, wins, losses, minSamples);
  if (CATEGORICAL_SIGNALS.has(signal))
    return computeCategoricalLift(signal, wins, losses, minSamples);
  return computeNumericLift(signal, wins, losses, minSamples);
}

function computeNumericLift(
  signal: string,
  wins: PerformanceRecord[],
  losses: PerformanceRecord[],
  minSamples: number
): number | null {
  const winVals = extractNumeric(signal, wins);
  const lossVals = extractNumeric(signal, losses);
  if (winVals.length + lossVals.length < minSamples) return null;
  if (winVals.length === 0 || lossVals.length === 0) return null;

  const all = [...winVals, ...lossVals];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min;
  if (range === 0) return 0;

  const normalize = (v: number): number => (v - min) / range;
  const winMean = mean(winVals.map(normalize));
  const lossMean = mean(lossVals.map(normalize));

  return HIGHER_IS_BETTER.has(signal) ? winMean - lossMean : Math.abs(winMean - lossMean);
}

function computeBooleanLift(
  signal: string,
  wins: PerformanceRecord[],
  losses: PerformanceRecord[],
  minSamples: number
): number | null {
  const allEntries: WinLossEntry[] = [
    ...wins.map((w) => ({ w: true, snap: w })),
    ...losses.map((l) => ({ w: false, snap: l })),
  ];
  let trueWins = 0,
    trueTotal = 0,
    falseWins = 0,
    falseTotal = 0;

  for (const { w, snap } of allEntries) {
    const val = snap.signal_snapshot?.[signal];
    if (val === undefined || val === null) continue;
    if (val) {
      trueTotal++;
      if (w) trueWins++;
    } else {
      falseTotal++;
      if (w) falseWins++;
    }
  }

  if (trueTotal + falseTotal < minSamples) return null;
  if (trueTotal === 0 || falseTotal === 0) return null;
  return trueWins / trueTotal - falseWins / falseTotal;
}

function computeCategoricalLift(
  signal: string,
  wins: PerformanceRecord[],
  losses: PerformanceRecord[],
  minSamples: number
): number | null {
  const allEntries: WinLossEntry[] = [
    ...wins.map((w) => ({ w: true, snap: w })),
    ...losses.map((l) => ({ w: false, snap: l })),
  ];
  const buckets: Record<string, CategoricalBucket> = {};

  for (const { w, snap } of allEntries) {
    const val = snap.signal_snapshot?.[signal];
    if (val === undefined || val === null) continue;
    const key = String(val);
    if (!buckets[key]) buckets[key] = { wins: 0, total: 0 };
    buckets[key].total++;
    if (w) buckets[key].wins++;
  }

  const totalSamples = Object.values(buckets).reduce((s, b) => s + b.total, 0);
  if (totalSamples < minSamples) return null;

  const rates = Object.values(buckets)
    .filter((b) => b.total >= 2)
    .map((b) => b.wins / b.total);
  if (rates.length < 2) return null;
  return Math.max(...rates) - Math.min(...rates);
}

// ─── Helpers ─────────────────────────────────────────────────────

function extractNumeric(signal: string, entries: PerformanceRecord[]): number[] {
  const vals: number[] = [];
  for (const entry of entries) {
    const snap = entry.signal_snapshot;
    if (!snap) continue;
    const v = snap[signal];
    if (v != null && typeof v === "number" && Number.isFinite(v)) vals.push(v);
  }
  return vals;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ─── Summary for LLM Prompt Injection ────────────────────────────

export function getWeightsSummary(): string {
  const data = loadWeights();
  const w = data.weights || {};

  const lines: string[] = ["Signal Weights (Darwinian — learned from past positions):"];
  const sorted = SIGNAL_NAMES.filter((s) => w[s] != null).sort((a, b) => (w[b] ?? 1) - (w[a] ?? 1));

  for (const signal of sorted) {
    const val = w[signal] ?? 1.0;
    const label = interpretWeight(val);
    const bar = weightBar(val);
    lines.push(`  ${signal.padEnd(24)} ${val.toFixed(2)}  ${bar}  ${label}`);
  }

  if (data.last_recalc) {
    lines.push(`\nLast recalculated: ${data.last_recalc} (${data.recalc_count || 0} total)`);
  } else {
    lines.push("\nWeights have not been recalculated yet (using defaults).");
  }

  return lines.join("\n");
}

function interpretWeight(val: number): string {
  if (val >= 1.8) return "[STRONG]";
  if (val >= 1.2) return "[above avg]";
  if (val >= 0.8) return "[neutral]";
  if (val >= 0.5) return "[below avg]";
  return "[weak]";
}

function weightBar(val: number): string {
  const filled = Math.round(((val - 0.3) / (2.5 - 0.3)) * 10);
  const clamped = Math.max(0, Math.min(10, filled));
  return "#".repeat(clamped) + ".".repeat(10 - clamped);
}
