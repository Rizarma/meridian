/**
 * Threshold Analyzer - Pure Analysis Engine
 *
 * NO SIDE EFFECTS - This module only analyzes data and returns suggestions.
 * All config mutations are handled by the caller.
 */

import type { PerformanceRecord } from "../types/lessons.js";

// ─── Types ─────────────────────────────────────────────────────────

export interface AnalysisResult {
  winners: PerformanceRecord[];
  losers: PerformanceRecord[];
  stats: FieldStats;
  hasEnoughData: boolean;
  confidence: number; // Overall confidence 0-100
}

export interface FieldStats {
  maxVolatility: {
    winnerP75: number;
    winnerP25: number;
    loserP25: number;
    loserP75: number;
    gap: number; // Difference between winner avg and loser avg
  };
  minFeeActiveTvlRatio: {
    winnerMin: number;
    winnerMax: number;
    loserMin: number;
    loserMax: number;
    gap: number;
  };
  minOrganic: {
    winnerAvg: number;
    winnerMin: number;
    loserAvg: number;
    loserMax: number;
    gap: number;
  };
}

export interface ThresholdSuggestion {
  field: string;
  currentValue: number;
  suggestedValue: number;
  confidence: number; // 0-100
  rationale: string;
  stats: {
    winnerCount: number;
    loserCount: number;
    totalSample: number;
  };
}

// ─── Constants ───────────────────────────────────────────────────────

const MIN_SAMPLE_PER_CATEGORY = 5;
const MIN_TOTAL_SAMPLES = 15;
const CONFIDENCE_GAP_THRESHOLD = 15; // Minimum gap between winner/loser stats for high confidence
const MAX_CHANGE_PCT = 0.2; // Max 20% change per evolution

// ─── Main Analysis ───────────────────────────────────────────────────

export function analyzeThresholdEvolution(
  performanceData: PerformanceRecord[],
  currentConfig: {
    maxVolatility: number;
    minFeeActiveTvlRatio: number;
    minOrganic: number;
  }
): {
  suggestions: ThresholdSuggestion[];
  analysis: AnalysisResult;
} {
  // Split into winners and losers
  const winners = performanceData.filter((p) => p.pnl_pct > 0);
  const losers = performanceData.filter((p) => p.pnl_pct < -5);
  const _neutral = performanceData.filter((p) => p.pnl_pct >= -5 && p.pnl_pct <= 0);

  // Calculate confidence based on sample size
  const hasEnoughData =
    performanceData.length >= MIN_TOTAL_SAMPLES &&
    winners.length >= MIN_SAMPLE_PER_CATEGORY &&
    losers.length >= MIN_SAMPLE_PER_CATEGORY;

  const sampleConfidence = Math.min(
    100,
    (performanceData.length / MIN_TOTAL_SAMPLES) * 50 +
      (Math.min(winners.length, losers.length) / MIN_SAMPLE_PER_CATEGORY) * 50
  );

  // Calculate field statistics
  const stats = calculateFieldStats(winners, losers);

  // Calculate overall confidence
  const avgGap =
    (stats.maxVolatility.gap + stats.minFeeActiveTvlRatio.gap + stats.minOrganic.gap) / 3;
  const gapConfidence = Math.min(100, (avgGap / CONFIDENCE_GAP_THRESHOLD) * 50);
  const confidence = Math.round((sampleConfidence + gapConfidence) / 2);

  const analysis: AnalysisResult = {
    winners,
    losers,
    stats,
    hasEnoughData,
    confidence,
  };

  // Generate suggestions
  const suggestions: ThresholdSuggestion[] = [];

  if (hasEnoughData) {
    const volSuggestion = analyzeMaxVolatility(
      stats.maxVolatility,
      currentConfig.maxVolatility,
      winners.length,
      losers.length
    );
    if (volSuggestion) suggestions.push(volSuggestion);

    const feeSuggestion = analyzeMinFeeTvl(
      stats.minFeeActiveTvlRatio,
      currentConfig.minFeeActiveTvlRatio,
      winners.length,
      losers.length
    );
    if (feeSuggestion) suggestions.push(feeSuggestion);

    const organicSuggestion = analyzeMinOrganic(
      stats.minOrganic,
      currentConfig.minOrganic,
      winners.length,
      losers.length
    );
    if (organicSuggestion) suggestions.push(organicSuggestion);
  }

  return { suggestions, analysis };
}

// ─── Field-Specific Analysis ───────────────────────────────────────

function analyzeMaxVolatility(
  stats: FieldStats["maxVolatility"],
  currentValue: number,
  winnerCount: number,
  loserCount: number
): ThresholdSuggestion | null {
  // Scenario: Losers clustered at lower volatility than current max
  // → Tighten threshold
  if (stats.loserP25 < currentValue) {
    const target = stats.loserP25 * 1.15;
    const suggested = clamp(nudge(currentValue, target, MAX_CHANGE_PCT), 1.0, 20.0);
    const rounded = Number(suggested.toFixed(1));

    if (rounded < currentValue) {
      const gapStrength = Math.min(100, ((currentValue - stats.loserP25) / currentValue) * 200);

      return {
        field: "maxVolatility",
        currentValue,
        suggestedValue: rounded,
        confidence: Math.round(60 + gapStrength * 0.4),
        rationale: `Losers clustered at volatility ~${stats.loserP25.toFixed(1)} (25th percentile). Current max ${currentValue} is too loose. Tightening to ${rounded} should filter more bad candidates.`,
        stats: { winnerCount, loserCount, totalSample: winnerCount + loserCount },
      };
    }
  }

  // Scenario: Winners pushing above current max, no losers up there
  // → Loosen threshold
  if (stats.winnerP75 > currentValue * 1.1 && stats.loserP75 <= currentValue) {
    const target = stats.winnerP75 * 1.1;
    const suggested = clamp(nudge(currentValue, target, MAX_CHANGE_PCT), 1.0, 20.0);
    const rounded = Number(suggested.toFixed(1));

    if (rounded > currentValue) {
      return {
        field: "maxVolatility",
        currentValue,
        suggestedValue: rounded,
        confidence: 65,
        rationale: `Winners reaching volatility ${stats.winnerP75.toFixed(1)} (75th percentile) while losers stay below ${stats.loserP75.toFixed(1)}. Loosening to ${rounded} captures more profitable opportunities.`,
        stats: { winnerCount, loserCount, totalSample: winnerCount + loserCount },
      };
    }
  }

  return null;
}

function analyzeMinFeeTvl(
  stats: FieldStats["minFeeActiveTvlRatio"],
  currentValue: number,
  winnerCount: number,
  loserCount: number
): ThresholdSuggestion | null {
  // Scenario: Winners all have significantly higher fee/TVL than current minimum
  // → Raise floor
  if (stats.winnerMin > currentValue * 1.2) {
    const target = stats.winnerMin * 0.85;
    const suggested = clamp(nudge(currentValue, target, MAX_CHANGE_PCT), 0.05, 10.0);
    const rounded = Number(suggested.toFixed(2));

    if (rounded > currentValue) {
      return {
        field: "minFeeActiveTvlRatio",
        currentValue,
        suggestedValue: rounded,
        confidence: 70,
        rationale: `Lowest winner has fee/TVL ${stats.winnerMin.toFixed(2)}, significantly above current floor ${currentValue}. Raising to ${rounded} filters low-quality pools.`,
        stats: { winnerCount, loserCount, totalSample: winnerCount + loserCount },
      };
    }
  }

  // Scenario: Losers have low fee/TVL, winners have higher
  // → Raise floor to separate them
  if (stats.loserMax < stats.winnerMin && stats.loserMax < currentValue * 1.5) {
    const target = Math.min(stats.winnerMin * 0.9, stats.loserMax * 1.2);
    const suggested = clamp(nudge(currentValue, target, MAX_CHANGE_PCT), 0.05, 10.0);
    const rounded = Number(suggested.toFixed(2));

    if (rounded > currentValue && !stats.loserMax) {
      return {
        field: "minFeeActiveTvlRatio",
        currentValue,
        suggestedValue: rounded,
        confidence: 75,
        rationale: `Clear separation: losers max ${stats.loserMax.toFixed(2)}, winners min ${stats.winnerMin.toFixed(2)}. Raising floor to ${rounded} exploits this gap.`,
        stats: { winnerCount, loserCount, totalSample: winnerCount + loserCount },
      };
    }
  }

  return null;
}

function analyzeMinOrganic(
  stats: FieldStats["minOrganic"],
  currentValue: number,
  winnerCount: number,
  loserCount: number
): ThresholdSuggestion | null {
  const gap = stats.winnerAvg - stats.loserAvg;

  // Scenario: Significant gap between winner and loser organic scores
  // → Adjust toward winner average
  if (gap >= 10) {
    const target = Math.max(stats.winnerMin - 3, currentValue + gap * 0.3);
    const suggested = clamp(Math.round(nudge(currentValue, target, MAX_CHANGE_PCT)), 60, 90);

    if (suggested > currentValue) {
      return {
        field: "minOrganic",
        currentValue,
        suggestedValue: suggested,
        confidence: Math.round(60 + Math.min(30, gap)),
        rationale: `Winner avg organic ${stats.winnerAvg.toFixed(0)} vs loser avg ${stats.loserAvg.toFixed(0)} (gap=${gap.toFixed(0)}). Raising from ${currentValue} to ${suggested} captures this edge.`,
        stats: { winnerCount, loserCount, totalSample: winnerCount + loserCount },
      };
    }
  }

  return null;
}

// ─── Statistics Helpers ────────────────────────────────────────────

function calculateFieldStats(
  winners: PerformanceRecord[],
  losers: PerformanceRecord[]
): FieldStats {
  const winVols = winners.map((p) => p.volatility).filter(isFiniteNum);
  const loseVols = losers.map((p) => p.volatility).filter(isFiniteNum);

  const winFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
  const loseFees = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);

  const winOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
  const loseOrganics = losers.map((p) => p.organic_score).filter(isFiniteNum);

  return {
    maxVolatility: {
      winnerP75: percentile(winVols, 75),
      winnerP25: percentile(winVols, 25),
      loserP25: percentile(loseVols, 25),
      loserP75: percentile(loseVols, 75),
      gap: avg(winVols) - avg(loseVols),
    },
    minFeeActiveTvlRatio: {
      winnerMin: winFees.length ? Math.min(...winFees) : 0,
      winnerMax: winFees.length ? Math.max(...winFees) : 0,
      loserMin: loseFees.length ? Math.min(...loseFees) : 0,
      loserMax: loseFees.length ? Math.max(...loseFees) : 0,
      gap: avg(winFees) - avg(loseFees),
    },
    minOrganic: {
      winnerAvg: avg(winOrganics),
      winnerMin: winOrganics.length ? Math.min(...winOrganics) : 0,
      loserAvg: avg(loseOrganics),
      loserMax: loseOrganics.length ? Math.max(...loseOrganics) : 0,
      gap: avg(winOrganics) - avg(loseOrganics),
    },
  };
}

// ─── Math Helpers ──────────────────────────────────────────────────

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function nudge(current: number, target: number, maxChangePct: number): number {
  const delta = target - current;
  const maxDelta = current * maxChangePct;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ─── Confidence Calculation ────────────────────────────────────────

export function calculateConfidence(
  sampleSize: number,
  winnerCount: number,
  loserCount: number,
  gap: number
): number {
  const sampleScore = Math.min(50, (sampleSize / MIN_TOTAL_SAMPLES) * 50);
  const balanceScore = Math.min(
    25,
    (Math.min(winnerCount, loserCount) / MIN_SAMPLE_PER_CATEGORY) * 25
  );
  const gapScore = Math.min(25, (gap / CONFIDENCE_GAP_THRESHOLD) * 25);

  return Math.round(sampleScore + balanceScore + gapScore);
}
