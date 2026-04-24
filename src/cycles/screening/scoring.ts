import { getActiveBin } from "../../../tools/dlmm.js";
import { loadWeights } from "../../domain/signal-weights.js";
import { log } from "../../infrastructure/logger.js";
import type { FilteredExample, ReconCandidate } from "../../types/index.js";
import {
  isValidNarrativeResponse,
  isValidSmartWalletResponse,
} from "../../utils/validation-args.js";

// ═══════════════════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════════════════

export interface ScoredCandidate {
  candidate: ReconCandidate;
  score: number;
  activeBin: number | null;
}

/** Edge proximity filter constants */
export const EDGE_PROXIMITY = {
  /** Minimum bins_above to ensure adequate upside buffer */
  MIN_BINS_ABOVE: 10,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Weighted Candidate Scoring
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute a weighted composite score for a candidate based on signal weights.
 * Higher score = better candidate based on historical performance.
 */
function computeCandidateScore(candidate: ReconCandidate, weights: Record<string, number>): number {
  const { pool, sw, n } = candidate;
  let score = 0;

  // Normalize and weight numeric signals (0-1 scale * weight)
  // organic_score: 0-100 scale
  if (pool.organic_score != null) {
    score += (pool.organic_score / 100) * (weights.organic_score ?? 1.0);
  }

  // fee_tvl_ratio: typically 0-5%, normalize to 0-1 (cap at 5%)
  if (pool.fee_active_tvl_ratio != null) {
    const normalizedFeeTvl = Math.min(pool.fee_active_tvl_ratio / 5, 1);
    score += normalizedFeeTvl * (weights.fee_tvl_ratio ?? 1.0);
  }

  // volume: log scale, normalize (cap at $1M)
  if (pool.volume_window != null && pool.volume_window > 0) {
    const normalizedVol = Math.min(Math.log10(pool.volume_window) / 6, 1);
    score += normalizedVol * (weights.volume ?? 1.0);
  }

  // mcap: log scale, normalize (sweet spot $100K-$10M)
  if (pool.mcap != null && pool.mcap > 0) {
    const normalizedMcap = Math.min(Math.max(Math.log10(pool.mcap) / 8, 0), 1);
    score += normalizedMcap * (weights.mcap ?? 1.0);
  }

  // holders: normalize (cap at 10K)
  if (pool.holders != null) {
    const normalizedHolders = Math.min(pool.holders / 10000, 1);
    score += normalizedHolders * (weights.holder_count ?? 1.0);
  }

  // volatility: inverted — moderate volatility is good (2-5 range)
  if (pool.volatility != null) {
    // Ideal volatility: 2-5, score peaks at 3.5
    const volScore = Math.max(0, 1 - Math.abs(pool.volatility - 3.5) / 5);
    score += volScore * (weights.volatility ?? 1.0);
  }

  // Boolean signals - validate before using
  const smartWalletResult = isValidSmartWalletResponse(sw) ? sw : null;
  if (smartWalletResult?.in_pool?.length) {
    score += (weights.smart_wallets_present ?? 1.0) * 0.5; // bonus for smart wallets
  }

  // Hive Mind consensus — weighted win rate (0-100 scale, normalize to 0-1)
  if (candidate.hive_consensus != null) {
    const normalizedHive = Math.min(candidate.hive_consensus / 100, 1);
    score += normalizedHive * (weights.hive_consensus ?? 1.0);
  }

  // Narrative quality (categorical) - validate before using
  const narrativeResult = isValidNarrativeResponse(n) ? n : null;
  const narrative = narrativeResult?.narrative;
  if (narrative && narrative.length > 50) {
    // Simple heuristic: longer, specific narrative = better
    score += (weights.narrative_quality ?? 1.0) * 0.3;
  }

  // Risk penalties (multiplicative)
  if (pool.is_rugpull) score *= 0.3;
  if (pool.is_wash) score *= 0.1;
  if (pool.risk_level != null && pool.risk_level >= 4) score *= 0.7;
  if (pool.bundle_pct != null && pool.bundle_pct > 40) score *= 0.8;

  // OKX bullish tags bonus
  if (pool.smart_money_buy) score *= 1.1;
  if (pool.dev_sold_all) score *= 1.05;

  return Math.round(score * 1000) / 1000;
}

/**
 * Score and rank candidates by weighted composite score.
 * Also fetches active bin for each passing candidate.
 *
 * @param candidates - Candidates to score
 * @returns Scored and sorted candidates (highest score first)
 */
export async function scoreAndRankCandidates(
  candidates: ReconCandidate[]
): Promise<ScoredCandidate[]> {
  // Pre-fetch active_bin for all candidates in parallel
  const activeBinResults = await Promise.allSettled(
    candidates.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
  );

  const weights = (await loadWeights()).weights;

  const scoredCandidates: ScoredCandidate[] = candidates.map((candidate, i) => ({
    candidate,
    score: computeCandidateScore(candidate, weights),
    activeBin:
      activeBinResults[i]?.status === "fulfilled"
        ? ((activeBinResults[i].value as { binId?: number } | null)?.binId ?? null)
        : null,
  }));

  // Sort by score descending (highest first)
  scoredCandidates.sort((a, b) => b.score - a.score);

  // Log ranking for debugging
  log(
    "screening",
    `Candidate ranking: ${scoredCandidates
      .map((s) => `${s.candidate.pool.name}(${s.score})`)
      .join(", ")}`
  );

  return scoredCandidates;
}

// ═══════════════════════════════════════════════════════════════════════════
// Edge Proximity Filter
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply edge proximity filter to scored candidates.
 * Prevents deploying positions where active_bin is at or near the edge
 * of the proposed range, which leaves zero upside buffer.
 *
 * Rejects candidates where:
 * - active_bin is null (can't determine position safety)
 * - Strategy's bins_above is below the minimum threshold (insufficient upside buffer)
 *
 * @param scoredCandidates - Scored candidates with active_bin data
 * @param binsAbove - Strategy's bins_above value (from active strategy config)
 * @returns Passing candidates and filtered examples with reasons
 */
export function applyEdgeProximityFilter(
  scoredCandidates: ScoredCandidate[],
  binsAbove: number
): { passing: ScoredCandidate[]; edgeFiltered: FilteredExample[] } {
  const edgeFiltered: FilteredExample[] = [];

  const passing = scoredCandidates.filter(({ candidate, activeBin }) => {
    const poolName = candidate.pool.name || "Unknown";
    const poolAddress = candidate.pool.pool;

    // Reject if active_bin is unavailable — can't determine position safety
    if (activeBin == null) {
      log(
        "screening",
        `Edge proximity: rejected ${poolName} (${poolAddress}) — active_bin unavailable, can't verify position`
      );
      edgeFiltered.push({
        pool_address: poolAddress,
        name: poolName,
        filter_reason: "Edge deployment risk: active_bin unavailable, can't verify position safety",
      });
      return false;
    }

    // Reject if strategy provides insufficient upside buffer.
    // With bins_below >> bins_above, the position is concentrated below active_bin
    // and any upward price movement immediately exits the range.
    if (binsAbove < EDGE_PROXIMITY.MIN_BINS_ABOVE) {
      log(
        "screening",
        `Edge proximity: rejected ${poolName} (${poolAddress}) — bins_above=${binsAbove} < ${EDGE_PROXIMITY.MIN_BINS_ABOVE} (insufficient upside buffer, active_bin=${activeBin})`
      );
      edgeFiltered.push({
        pool_address: poolAddress,
        name: poolName,
        filter_reason: `Edge deployment risk: active_bin too close to range boundary (bins_above=${binsAbove} < ${EDGE_PROXIMITY.MIN_BINS_ABOVE})`,
      });
      return false;
    }

    return true;
  });

  return { passing, edgeFiltered };
}
