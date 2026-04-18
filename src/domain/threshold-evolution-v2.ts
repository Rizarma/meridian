/**
 * Threshold Evolution V2 - Refactored with Approval Workflow
 *
 * Key changes from V1:
 * 1. Pure analysis - no direct config mutation
 * 2. Suggestions persisted to DB with approval workflow
 * 3. Audit trail in SQLite
 * 4. CLI/UI review before application
 */

import { config, reloadScreeningThresholds } from "../config/config.js";
import {
  approveSuggestion,
  expireOldSuggestions,
  getPendingSuggestions,
  getThresholdHistory,
  initThresholdEvolutionTables,
  rejectSuggestion,
  saveSuggestion,
} from "../infrastructure/db-threshold-evolution.js";
import { formatThresholdConsensusForAdvisory, syncToHive } from "../infrastructure/hive-mind.js";
import { log } from "../infrastructure/logger.js";
import type { PerformanceRecord, PositionPerformance } from "../types/lessons.js";
import { getErrorMessage } from "../utils/errors.js";
import { recordPoolDeploy } from "./pool-memory.js";
import { recalculateWeights } from "./signal-weights.js";
import {
  type ThresholdSuggestion as AnalysisSuggestion,
  analyzeThresholdEvolution,
} from "./threshold-analyzer.js";

const MIN_EVOLVE_POSITIONS = 5;

// Initialize tables on module load
initThresholdEvolutionTables();

// ─── Main Orchestrator ─────────────────────────────────────────────

/**
 * Run all post-position-close evolution tasks.
 * Called from recordPerformance() after saving the performance record.
 *
 * Flow:
 * 1. Update pool memory (SQLite) ✅
 * 2. Every 5 positions: Analyze & generate suggestions (pure) ✅
 * 3. Save suggestions to DB (pending approval) ✅
 * 4. Trigger Darwinian weight recalculation ✅
 * 5. Fetch HiveMind threshold advisory (advisory context) ✅
 * 6. Sync to hive mind ✅
 *
 * Note: Threshold changes are NOT applied automatically. They require
 * manual approval via CLI or admin interface.
 */
export async function runThresholdEvolution(
  perf: PositionPerformance,
  performanceHistory: PerformanceRecord[]
): Promise<void> {
  // 1. Update pool-level memory (operational data → SQLite)
  if (perf.pool) {
    const perfRecord = perf as unknown as import("../types/lessons.js").PerformanceRecord;
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: new Date().toISOString(),
      pnl_pct: perfRecord.pnl_pct ?? 0,
      pnl_usd: perfRecord.pnl_usd ?? 0,
      range_efficiency: perfRecord.range_efficiency ?? 0,
      minutes_held: perf.minutes_held,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
    });
  }

  // 2. Every N positions: Analyze and generate suggestions
  if (performanceHistory.length % MIN_EVOLVE_POSITIONS === 0) {
    // 5. Fetch hive threshold advisory as supplementary context (fire-and-forget, fail-open)
    let hiveAdvisory = "";
    try {
      hiveAdvisory = await formatThresholdConsensusForAdvisory();
    } catch {
      // Advisory fetch is non-critical — proceed without it
    }

    const result = await generateAndSaveSuggestions(performanceHistory, hiveAdvisory);

    if (result.suggestions.length > 0) {
      log(
        "evolution",
        `Generated ${result.suggestions.length} threshold suggestions ready for review. Run 'node cli.js review-suggestions' to view.`
      );
    }

    // 3. Darwinian signal weight recalculation (separate concern)
    if (config.features.darwinEvolution) {
      const wResult = recalculateWeights(performanceHistory, { darwin: config.darwin });
      if (wResult.changes.length > 0) {
        log("evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
      }
    }
  }

  // 6. Fire-and-forget sync to hive mind
  syncToHive().catch((e: unknown) => log("hive_error", getErrorMessage(e)));

  // Cleanup old suggestions periodically
  expireOldSuggestions(7);
}

// ─── Suggestion Generation ──────────────────────────────────────────

async function generateAndSaveSuggestions(
  performanceHistory: PerformanceRecord[],
  hiveAdvisory = ""
): Promise<{
  suggestions: AnalysisSuggestion[];
  analysis: ReturnType<typeof analyzeThresholdEvolution>["analysis"];
}> {
  const currentConfig = {
    maxVolatility: config.screening.maxVolatility ?? 10,
    minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio ?? 0.5,
    minOrganic: config.screening.minOrganic ?? 75,
  };

  // Pure analysis - no side effects
  const { suggestions, analysis } = analyzeThresholdEvolution(performanceHistory, currentConfig);

  // Save suggestions to DB (still side effect, but isolated and auditable)
  // If hive advisory is available, append it to the rationale as context
  for (const suggestion of suggestions) {
    const rationale = hiveAdvisory
      ? `${suggestion.rationale} [Hive advisory: ${hiveAdvisory.replace(/\n/g, " ")}]`
      : suggestion.rationale;

    saveSuggestion({
      field: suggestion.field,
      currentValue: suggestion.currentValue,
      suggestedValue: suggestion.suggestedValue,
      confidence: suggestion.confidence,
      rationale,
      sampleSize: suggestion.stats.totalSample,
      winnerCount: suggestion.stats.winnerCount,
      loserCount: suggestion.stats.loserCount,
      createdAt: new Date().toISOString(),
      status: "pending",
    });
  }

  return { suggestions, analysis };
}

// ─── CLI / Admin Interface ──────────────────────────────────────────

export interface ReviewableSuggestion extends AnalysisSuggestion {
  id: number;
  createdAt: string;
}

/**
 * Get all pending suggestions for review.
 * Called by CLI or admin interface.
 */
export function getSuggestionsForReview(): ReviewableSuggestion[] {
  return getPendingSuggestions().map(
    (s: {
      id?: number;
      field: string;
      currentValue: number;
      suggestedValue: number;
      confidence: number;
      rationale: string;
      winnerCount: number;
      loserCount: number;
      sampleSize: number;
      createdAt: string;
    }) => ({
      id: s.id ?? 0,
      field: s.field,
      currentValue: s.currentValue,
      suggestedValue: s.suggestedValue,
      confidence: s.confidence,
      rationale: s.rationale,
      stats: {
        winnerCount: s.winnerCount,
        loserCount: s.loserCount,
        totalSample: s.sampleSize,
      },
      createdAt: s.createdAt,
    })
  );
}

/**
 * Apply an approved suggestion.
 * This is the ONLY place where config is mutated.
 */
export function applySuggestion(
  suggestionId: number,
  reviewer: string
): { success: boolean; message: string } {
  const result = approveSuggestion(suggestionId, reviewer);

  if (!result.success || !result.suggestion) {
    return { success: false, message: result.error || "Failed to approve suggestion" };
  }

  const s = result.suggestion;

  // Apply to live config
  type MutableScreening = {
    maxVolatility: number | null;
    minFeeActiveTvlRatio: number;
    minOrganic: number;
  };
  const cfg = config.screening as MutableScreening;
  if (s.field === "maxVolatility") cfg.maxVolatility = s.suggestedValue;
  if (s.field === "minFeeActiveTvlRatio") cfg.minFeeActiveTvlRatio = s.suggestedValue;
  if (s.field === "minOrganic") cfg.minOrganic = s.suggestedValue;

  // Reload and persist
  reloadScreeningThresholds();

  const message = `Applied: ${s.field} ${s.currentValue} → ${s.suggestedValue} (${s.confidence}% confidence)`;
  log("evolution", message);

  return { success: true, message };
}

/**
 * Reject a suggestion.
 */
export function dismissSuggestion(
  suggestionId: number,
  reviewer: string,
  reason?: string
): { success: boolean; message: string } {
  const result = rejectSuggestion(suggestionId, reviewer, reason);

  if (!result.success) {
    return { success: false, message: result.error || "Failed to reject suggestion" };
  }

  return {
    success: true,
    message: `Suggestion #${suggestionId} rejected${reason ? `: ${reason}` : ""}`,
  };
}

// ─── History & Reporting ────────────────────────────────────────────

export function getEvolutionHistory(field?: string, limit?: number) {
  return getThresholdHistory(field, limit);
}

export function getEvolutionReport(): {
  pendingSuggestions: number;
  totalApplied: number;
  recentChanges: ReturnType<typeof getThresholdHistory>;
} {
  const pending = getPendingSuggestions();
  const history = getThresholdHistory(undefined, 10);

  return {
    pendingSuggestions: pending.length,
    totalApplied: history.length,
    recentChanges: history,
  };
}
