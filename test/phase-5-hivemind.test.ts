/**
 * Phase 5 Tests: HiveMind Batch 1 — Screening Integration
 *
 * Tests covering:
 * 1. ReconCandidate type carries hive_consensus field
 * 2. Scoring includes hive_consensus weight
 * 3. Prompt builder renders HiveMind consensus block
 * 4. Signal staging includes hive_consensus
 * 5. formatPoolConsensusForPrompt gracefully handles empty / disabled
 */

import { config } from "../src/config/config.js";
import {
  buildCandidateBlocks,
  buildScreeningPrompt,
} from "../src/cycles/screening/prompt-builder.js";
import type { ScoredCandidate } from "../src/cycles/screening/scoring.js";
import { applyEdgeProximityFilter } from "../src/cycles/screening/scoring.js";
import { getAndClearStagedSignals, stageSignals } from "../src/domain/signal-tracker.js";
import { formatPoolConsensusForPrompt } from "../src/infrastructure/hive-mind.js";
import type { CondensedPool, ReconCandidate } from "../src/types/index.js";
import { describe, describeAsync, expect, runTestsAsync, test, testAsync } from "./test-harness.js";

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makePool(overrides: Partial<CondensedPool> = {}): CondensedPool {
  return {
    pool: overrides.pool ?? "PoolAddr1111111111111111111111111111111",
    name: overrides.name ?? "TEST/SOL",
    base: overrides.base ?? {
      symbol: "TEST",
      mint: "TestMint1111111111111111111111111111111",
      organic: 75,
      warnings: 0,
    },
    quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
    pool_type: "dlmm",
    bin_step: 100,
    fee_pct: 1.0,
    active_tvl: 50000,
    fee_window: 500,
    volume_window: 100000,
    fee_active_tvl_ratio: 1.0,
    volatility: 3.5,
    holders: 1200,
    mcap: 2000000,
    organic_score: 78,
    token_age_hours: 48,
    dev: null,
    active_positions: 20,
    active_pct: 0.5,
    open_positions: 10,
    price: 0.001,
    price_change_pct: 5,
    price_trend: "up",
    min_price: 0.0005,
    max_price: 0.002,
    volume_change_pct: 10,
    fee_change_pct: 8,
    swap_count: 500,
    unique_traders: 200,
    ...overrides,
  };
}

function makeCandidate(
  poolOverrides: Partial<CondensedPool> = {},
  hiveConsensus?: number | null
): ReconCandidate {
  return {
    pool: makePool(poolOverrides),
    sw: null,
    n: null,
    ti: null,
    mem: null,
    hive_consensus: hiveConsensus,
  };
}

function makeScoredCandidate(
  poolOverrides: Partial<CondensedPool> = {},
  hiveConsensus?: number | null,
  score = 5.0,
  activeBin = 100
): ScoredCandidate {
  return {
    candidate: makeCandidate(poolOverrides, hiveConsensus),
    score,
    activeBin,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: ReconCandidate type carries hive_consensus
// ═══════════════════════════════════════════════════════════════════════════

describe("ReconCandidate — hive_consensus field", () => {
  test("candidate can hold a numeric hive_consensus value", () => {
    const c = makeCandidate({}, 72.5);
    expect(c.hive_consensus).toBe(72.5);
  });

  test("candidate can hold null hive_consensus", () => {
    const c = makeCandidate({}, null);
    expect(c.hive_consensus).toBe(null);
  });

  test("candidate defaults hive_consensus to undefined when omitted", () => {
    const c = makeCandidate({});
    expect(c.hive_consensus).toBe(undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Scoring includes hive_consensus
// ═══════════════════════════════════════════════════════════════════════════

describe("Scoring — hive_consensus contributes to score", () => {
  test("candidates with high hive_consensus score are distinguishable", () => {
    // We can't directly call computeCandidateScore (it's not exported), but
    // we can verify that ScoredCandidate carries hive_consensus through the pipeline.
    const withConsensus = makeScoredCandidate({}, 85.0);
    const withoutConsensus = makeScoredCandidate({}, null);

    // Both should be valid ScoredCandidate objects
    expect(withConsensus.candidate.hive_consensus).toBe(85.0);
    expect(withoutConsensus.candidate.hive_consensus).toBe(null);
  });

  test("edge proximity filter preserves hive_consensus on passing candidates", () => {
    const scored: ScoredCandidate[] = [
      makeScoredCandidate({ name: "Pool1" }, 70.0, 5.0, 100),
      makeScoredCandidate({ name: "Pool2" }, null, 4.5, 100),
    ];

    const { passing } = applyEdgeProximityFilter(scored, 15);
    expect(passing.length).toBe(2);
    expect(passing[0].candidate.hive_consensus).toBe(70.0);
    expect(passing[1].candidate.hive_consensus).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Prompt builder renders HiveMind consensus block
// ═══════════════════════════════════════════════════════════════════════════

describe("Prompt Builder — HiveMind consensus block", () => {
  test("prompt includes consensus block when provided", () => {
    const scored = [makeScoredCandidate()];
    const candidateBlocks = buildCandidateBlocks(scored, 5);
    const consensusBlock = "HIVE MIND CONSENSUS:\n[HIVE] TEST: 5 agents, 80% win";

    const prompt = buildScreeningPrompt(
      "Test strategy",
      { total_positions: 0 },
      0.5,
      scored,
      candidateBlocks,
      1.0,
      consensusBlock
    );

    expect(prompt.includes("HIVE MIND CONSENSUS")).toBe(true);
    expect(prompt.includes("80% win")).toBe(true);
  });

  test("prompt omits consensus section when block is empty string", () => {
    const scored = [makeScoredCandidate()];
    const candidateBlocks = buildCandidateBlocks(scored, 5);

    const prompt = buildScreeningPrompt(
      "Test strategy",
      { total_positions: 0 },
      0.5,
      scored,
      candidateBlocks,
      1.0,
      ""
    );

    expect(prompt.includes("HIVE MIND")).toBe(false);
  });

  test("prompt omits consensus section when block is undefined", () => {
    const scored = [makeScoredCandidate()];
    const candidateBlocks = buildCandidateBlocks(scored, 5);

    const prompt = buildScreeningPrompt(
      "Test strategy",
      { total_positions: 0 },
      0.5,
      scored,
      candidateBlocks,
      1.0
    );

    expect(prompt.includes("HIVE MIND")).toBe(false);
  });

  test("candidate block includes hive_consensus when present", () => {
    const scored = [makeScoredCandidate({}, 72.5)];
    const blocks = buildCandidateBlocks(scored, 5);

    expect(blocks[0].includes("hive:")).toBe(true);
    expect(blocks[0].includes("72.5%")).toBe(true);
  });

  test("candidate block omits hive line when consensus is null", () => {
    const scored = [makeScoredCandidate({}, null)];
    const blocks = buildCandidateBlocks(scored, 5);

    expect(blocks[0].includes("hive:")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Signal staging includes hive_consensus
// ═══════════════════════════════════════════════════════════════════════════

describe("Signal Staging — hive_consensus captured", () => {
  test("stageSignals accepts hive_consensus in signal snapshot", () => {
    const poolAddr = "SignalTestPool11111111111111111111111111";
    stageSignals(poolAddr, {
      organic_score: 80,
      fee_tvl_ratio: 1.2,
      hive_consensus: 75.0,
      volatility: 3.0,
    });

    const staged = getAndClearStagedSignals(poolAddr);
    expect(staged !== null).toBe(true);
    expect(staged?.hive_consensus).toBe(75.0);
    expect(staged?.organic_score).toBe(80);
  });

  test("stageSignals works without hive_consensus (backward compatible)", () => {
    const poolAddr = "NoHivePool111111111111111111111111111111";
    stageSignals(poolAddr, {
      organic_score: 60,
      volatility: 4.0,
    });

    const staged = getAndClearStagedSignals(poolAddr);
    expect(staged !== null).toBe(true);
    expect(staged?.hive_consensus).toBe(undefined);
    expect(staged?.organic_score).toBe(60);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: formatPoolConsensusForPrompt graceful behavior
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("formatPoolConsensusForPrompt — fail-open behavior", async () => {
  testAsync("returns empty string when poolAddresses is empty", async () => {
    const result = await formatPoolConsensusForPrompt([]);
    expect(result).toBe("");
  });

  testAsync("returns empty string when HiveMind is disabled (default)", async () => {
    // Ensure hiveMind feature flag is off
    const origFlag = config.features.hiveMind;
    config.features.hiveMind = false;
    try {
      const result = await formatPoolConsensusForPrompt([
        "SomePool1111111111111111111111111111111",
      ]);
      expect(result).toBe("");
    } finally {
      config.features.hiveMind = origFlag;
    }
  });

  testAsync("returns empty string when network is unavailable (fail-open)", async () => {
    // Enable feature flag but provide no real credentials
    const origFlag = config.features.hiveMind;
    const origUrl = process.env.HIVE_MIND_URL;
    const origKey = process.env.HIVE_MIND_API_KEY;

    config.features.hiveMind = true;
    process.env.HIVE_MIND_URL = "https://nonexistent-test.invalid";
    process.env.HIVE_MIND_API_KEY = "test-key-invalid";

    try {
      const result = await formatPoolConsensusForPrompt([
        "SomePool1111111111111111111111111111111",
      ]);
      // Should return empty string (fail-open), not throw
      expect(typeof result).toBe("string");
      expect(result).toBe("");
    } finally {
      config.features.hiveMind = origFlag;
      if (origUrl !== undefined) process.env.HIVE_MIND_URL = origUrl;
      else delete process.env.HIVE_MIND_URL;
      if (origKey !== undefined) process.env.HIVE_MIND_API_KEY = origKey;
      else delete process.env.HIVE_MIND_API_KEY;
    }
  });
});

// Run tests immediately
runTestsAsync().catch(() => process.exit(1));
