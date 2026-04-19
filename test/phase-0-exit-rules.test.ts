/**
 * Phase 0 Exit Rules Characterization Tests
 *
 * These tests document the current behavior of exit rule logic
 * from index.ts (lines 317-359) and state.ts (lines 473-584).
 *
 * This is a characterization test - it captures existing behavior
 * before refactoring to ensure no regressions.
 */

import {
  evaluateExitConditions,
  evaluateManagementExitRules,
  shouldCloseLowYield,
  shouldCloseOOR,
  shouldStopLoss,
  shouldTakeProfit,
} from "../src/domain/exit-rules.js";
import type { EnrichedPosition } from "../src/types/dlmm.js";
import type { ManagementConfig, PositionData, TrackedPosition } from "../src/types/state.js";
import { describe, expect, runTests, test } from "./test-harness.js";

// ============================================================================
// Helper to create minimal TrackedPosition mock
// ============================================================================

function createTrackedPositionMock(overrides: Partial<TrackedPosition> = {}): TrackedPosition {
  return {
    position: "test-position",
    pool: "test-pool",
    pool_name: "TEST/SOL",
    strategy: "spot",
    bin_range: { min: 80, max: 120, active: 100, bins_below: 20, bins_above: 20 },
    amount_sol: 1.0,
    amount_x: 1000,
    active_bin_at_deploy: 100,
    bin_step: 100,
    volatility: 2,
    fee_tvl_ratio: 0.05,
    initial_fee_tvl_24h: 0.05,
    organic_score: 80,
    initial_value_usd: 100,
    signal_snapshot: null,
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
    instruction: null,
    ...overrides,
  };
}

// ============================================================================
// Test Suite: Individual Rule Functions
// ============================================================================

describe("Exit Rules - shouldStopLoss", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
  };

  test("returns true when PnL <= stopLossPct", () => {
    expect(shouldStopLoss(-25, false, baseConfig)).toBe(true);
    expect(shouldStopLoss(-30, false, baseConfig)).toBe(true);
  });

  test("returns false when PnL > stopLossPct", () => {
    expect(shouldStopLoss(-20, false, baseConfig)).toBe(false);
    expect(shouldStopLoss(0, false, baseConfig)).toBe(false);
    expect(shouldStopLoss(10, false, baseConfig)).toBe(false);
  });

  test("returns false when PnL is suspicious", () => {
    expect(shouldStopLoss(-30, true, baseConfig)).toBe(false);
  });

  test("returns false when PnL is null", () => {
    expect(shouldStopLoss(null, false, baseConfig)).toBe(false);
    expect(shouldStopLoss(undefined, false, baseConfig)).toBe(false);
  });

  test("returns false when stopLossPct is not configured", () => {
    expect(shouldStopLoss(-30, false, {})).toBe(false);
  });
});

describe("Exit Rules - shouldTakeProfit", () => {
  const baseConfig: ManagementConfig = {
    takeProfitFeePct: 10,
  };

  test("returns true when PnL >= takeProfitFeePct", () => {
    expect(shouldTakeProfit(10, false, baseConfig)).toBe(true);
    expect(shouldTakeProfit(15, false, baseConfig)).toBe(true);
  });

  test("returns false when PnL < takeProfitFeePct", () => {
    expect(shouldTakeProfit(5, false, baseConfig)).toBe(false);
    expect(shouldTakeProfit(0, false, baseConfig)).toBe(false);
    expect(shouldTakeProfit(-10, false, baseConfig)).toBe(false);
  });

  test("returns false when PnL is suspicious", () => {
    expect(shouldTakeProfit(15, true, baseConfig)).toBe(false);
  });

  test("returns false when PnL is null", () => {
    expect(shouldTakeProfit(null, false, baseConfig)).toBe(false);
    expect(shouldTakeProfit(undefined, false, baseConfig)).toBe(false);
  });

  test("returns false when takeProfitFeePct is not configured", () => {
    expect(shouldTakeProfit(15, false, {})).toBe(false);
  });
});

describe("Exit Rules - shouldCloseOOR", () => {
  const baseConfig: ManagementConfig = {
    outOfRangeWaitMinutes: 30,
  };

  test("returns true when OOR time exceeds threshold", () => {
    const position = createTrackedPositionMock({
      out_of_range_since: new Date(Date.now() - 35 * 60000).toISOString(),
    });
    expect(shouldCloseOOR(position, baseConfig)).toBe(true);
  });

  test("returns false when OOR time is within threshold", () => {
    const position = createTrackedPositionMock({
      out_of_range_since: new Date(Date.now() - 15 * 60000).toISOString(),
    });
    expect(shouldCloseOOR(position, baseConfig)).toBe(false);
  });

  test("returns false when not out of range", () => {
    const position = createTrackedPositionMock({
      out_of_range_since: null,
    });
    expect(shouldCloseOOR(position, baseConfig)).toBe(false);
  });

  test("returns true exactly at threshold", () => {
    const position = createTrackedPositionMock({
      out_of_range_since: new Date(Date.now() - 30 * 60000).toISOString(),
    });
    expect(shouldCloseOOR(position, baseConfig)).toBe(true);
  });
});

describe("Exit Rules - shouldCloseLowYield", () => {
  const baseConfig: ManagementConfig = {
    minFeePerTvl24h: 0.001,
    minAgeBeforeYieldCheck: 60,
  };

  test("returns true when fee/TVL below threshold after min age", () => {
    expect(shouldCloseLowYield(0.0005, 90, baseConfig)).toBe(true);
  });

  test("returns false when fee/TVL above threshold", () => {
    expect(shouldCloseLowYield(0.002, 90, baseConfig)).toBe(false);
  });

  test("returns false before min age threshold", () => {
    expect(shouldCloseLowYield(0.0005, 30, baseConfig)).toBe(false);
  });

  test("returns false when age is null", () => {
    expect(shouldCloseLowYield(0.0005, null, baseConfig)).toBe(false);
    expect(shouldCloseLowYield(0.0005, undefined, baseConfig)).toBe(false);
  });

  test("returns false when feePerTvl24h is null", () => {
    expect(shouldCloseLowYield(null, 90, baseConfig)).toBe(false);
    expect(shouldCloseLowYield(undefined, 90, baseConfig)).toBe(false);
  });

  test("returns true at exact min age threshold", () => {
    expect(shouldCloseLowYield(0.0005, 60, baseConfig)).toBe(true);
  });
});

// ============================================================================
// Test Suite: evaluateExitConditions (state.ts usage)
// ============================================================================

describe("Exit Rules - evaluateExitConditions Stop Loss", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  const basePosition = createTrackedPositionMock();

  test("triggers stop loss at threshold (pnl_pct <= stopLossPct)", () => {
    const positionData: PositionData = {
      pnl_pct: -25,
      in_range: true,
    };

    const result = evaluateExitConditions(basePosition, positionData, baseConfig);

    expect(result?.action).toBe("STOP_LOSS");
    expect(result?.reason.includes("Stop loss")).toBe(true);
  });

  test("triggers stop loss below threshold (pnl_pct < stopLossPct)", () => {
    const positionData: PositionData = {
      pnl_pct: -30,
      in_range: true,
    };

    const result = evaluateExitConditions(basePosition, positionData, baseConfig);

    expect(result?.action).toBe("STOP_LOSS");
  });

  test("does not trigger stop loss above threshold (pnl_pct > stopLossPct)", () => {
    const positionData: PositionData = {
      pnl_pct: -20,
      in_range: true,
    };

    const result = evaluateExitConditions(basePosition, positionData, baseConfig);

    expect(result === null).toBe(true);
  });

  test("does not trigger stop loss when PnL is suspicious", () => {
    const positionData: PositionData = {
      pnl_pct: -30,
      pnl_pct_suspicious: true,
      in_range: true,
    };

    const result = evaluateExitConditions(basePosition, positionData, baseConfig);

    // When PnL is suspicious, stop loss is skipped
    expect(result?.action === "STOP_LOSS").toBe(false);
  });
});

describe("Exit Rules - evaluateExitConditions Trailing TP", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
    trailingTakeProfit: true,
    trailingTriggerPct: 3,
    trailingDropPct: 1.5,
  };

  test("trails when active and drop from peak exceeds threshold", () => {
    const position = createTrackedPositionMock({
      trailing_active: true,
      peak_pnl_pct: 10,
    });
    const positionData: PositionData = {
      pnl_pct: 8, // Dropped 2% from peak of 10%
      in_range: true,
    };

    const result = evaluateExitConditions(position, positionData, baseConfig);

    expect(result?.action).toBe("TRAILING_TP");
    expect(result?.needs_confirmation).toBe(true);
    expect(result?.reason.includes("Trailing TP")).toBe(true);
  });

  test("does not trail when not active", () => {
    const position = createTrackedPositionMock({
      trailing_active: false,
      peak_pnl_pct: 10,
    });
    const positionData: PositionData = {
      pnl_pct: 8,
      in_range: true,
    };

    const result = evaluateExitConditions(position, positionData, baseConfig);

    expect(result?.action === "TRAILING_TP").toBe(false);
  });

  test("does not trail when drop is below threshold", () => {
    const position = createTrackedPositionMock({
      trailing_active: true,
      peak_pnl_pct: 10,
    });
    const positionData: PositionData = {
      pnl_pct: 9, // Only dropped 1% from peak
      in_range: true,
    };

    const result = evaluateExitConditions(position, positionData, baseConfig);

    expect(result?.action === "TRAILING_TP").toBe(false);
  });

  test("does not trail when PnL is suspicious", () => {
    const position = createTrackedPositionMock({
      trailing_active: true,
      peak_pnl_pct: 10,
    });
    const positionData: PositionData = {
      pnl_pct: 8,
      pnl_pct_suspicious: true,
      in_range: true,
    };

    const result = evaluateExitConditions(position, positionData, baseConfig);

    expect(result?.action === "TRAILING_TP").toBe(false);
  });

  test("returns confirmed trailing exit when in cooldown period", () => {
    const position = createTrackedPositionMock({
      confirmed_trailing_exit_until: new Date(Date.now() + 60000).toISOString(),
      confirmed_trailing_exit_reason: "Trailing TP confirmed earlier",
    });
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
    };

    const result = evaluateExitConditions(position, positionData, baseConfig);

    expect(result?.action).toBe("TRAILING_TP");
    expect(result?.needs_confirmation).toBe(false);
  });
});

describe("Exit Rules - evaluateExitConditions Out of Range", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  test("triggers OOR close after wait time exceeded", () => {
    const position = createTrackedPositionMock({
      out_of_range_since: new Date(Date.now() - 35 * 60000).toISOString(),
    });
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: false,
    };

    const result = evaluateExitConditions(position, positionData, baseConfig);

    expect(result?.action).toBe("OUT_OF_RANGE");
    expect(result?.reason.includes("Out of range")).toBe(true);
  });

  test("does not trigger OOR if within wait window", () => {
    const position = createTrackedPositionMock({
      out_of_range_since: new Date(Date.now() - 15 * 60000).toISOString(),
    });
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: false,
    };

    const result = evaluateExitConditions(position, positionData, baseConfig);

    expect(result?.action === "OUT_OF_RANGE").toBe(false);
  });

  test("does not trigger OOR when not out of range", () => {
    const position = createTrackedPositionMock({
      out_of_range_since: null,
    });
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
    };

    const result = evaluateExitConditions(position, positionData, baseConfig);

    expect(result?.action === "OUT_OF_RANGE").toBe(false);
  });
});

describe("Exit Rules - evaluateExitConditions Low Yield", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
    minAgeBeforeYieldCheck: 60,
  };

  const basePosition = createTrackedPositionMock();

  test("triggers low yield when fee/TVL below threshold after min age", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.0005,
      age_minutes: 90,
    };

    const result = evaluateExitConditions(basePosition, positionData, baseConfig);

    expect(result?.action).toBe("LOW_YIELD");
    expect(result?.reason.includes("Low yield")).toBe(true);
  });

  test("does not trigger low yield when fee/TVL above threshold", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
    };

    const result = evaluateExitConditions(basePosition, positionData, baseConfig);

    expect(result?.action === "LOW_YIELD").toBe(false);
  });

  test("does not trigger low yield before min age threshold", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.0005,
      age_minutes: 30,
    };

    const result = evaluateExitConditions(basePosition, positionData, baseConfig);

    expect(result?.action === "LOW_YIELD").toBe(false);
  });
});

describe("Exit Rules - evaluateExitConditions Priority Order", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
    minAgeBeforeYieldCheck: 60,
    trailingTakeProfit: true,
    trailingTriggerPct: 3,
    trailingDropPct: 1.5,
  };

  test("stop loss takes priority over trailing TP", () => {
    const position = createTrackedPositionMock({
      trailing_active: true,
      peak_pnl_pct: 10,
      out_of_range_since: new Date(Date.now() - 35 * 60000).toISOString(),
    });
    const positionData: PositionData = {
      pnl_pct: -30, // Stop loss condition
      in_range: false,
      fee_per_tvl_24h: 0.0005,
      age_minutes: 90,
    };

    const result = evaluateExitConditions(position, positionData, baseConfig);

    // Stop loss should trigger first
    expect(result?.action).toBe("STOP_LOSS");
  });

  test("trailing TP takes priority over OOR", () => {
    const position = createTrackedPositionMock({
      trailing_active: true,
      peak_pnl_pct: 10,
      out_of_range_since: new Date(Date.now() - 35 * 60000).toISOString(),
    });
    const positionData: PositionData = {
      pnl_pct: 8, // Trailing drop of 2% >= 1.5%
      in_range: false,
    };

    const result = evaluateExitConditions(position, positionData, baseConfig);

    // Trailing TP should trigger before OOR
    expect(result?.action).toBe("TRAILING_TP");
  });

  test("OOR takes priority over low yield", () => {
    const position = createTrackedPositionMock({
      out_of_range_since: new Date(Date.now() - 35 * 60000).toISOString(),
    });
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: false,
      fee_per_tvl_24h: 0.0005,
      age_minutes: 90,
    };

    const result = evaluateExitConditions(position, positionData, baseConfig);

    // OOR should trigger before low yield
    expect(result?.action).toBe("OUT_OF_RANGE");
  });
});

// ============================================================================
// Test Suite: evaluateManagementExitRules (index.ts usage)
// ============================================================================

describe("Exit Rules - evaluateManagementExitRules Stop Loss", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  test("triggers at threshold (pnl_pct <= stopLossPct)", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 100,
      total_value_true_usd: 100,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: -25,
      pnl_true_usd: -25,
      pnl_pct: -25,
      pnl_pct_derived: -25,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result?.action).toBe("CLOSE");
    expect(result?.rule).toBe(1);
    expect(result?.reason).toBe("stop loss");
  });

  test("does not trigger when PnL is suspicious", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 100,
      total_value_true_usd: 100,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: -30,
      pnl_true_usd: -30,
      pnl_pct: -30,
      pnl_pct_derived: -30,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: true,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, true);

    expect(result === null).toBe(true);
  });
});

describe("Exit Rules - evaluateManagementExitRules Take Profit", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  test("triggers at threshold (pnl_pct >= takeProfitFeePct)", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 110,
      total_value_true_usd: 110,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 10,
      pnl_true_usd: 10,
      pnl_pct: 10,
      pnl_pct_derived: 10,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result?.action).toBe("CLOSE");
    expect(result?.rule).toBe(2);
    expect(result?.reason).toBe("take profit");
  });

  test("does not trigger below threshold", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result === null).toBe(true);
  });
});

describe("Exit Rules - evaluateManagementExitRules Pumped Far Above Range (Rule 3)", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeBinsToClose: 20,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  test("triggers when active_bin > upper_bin + outOfRangeBinsToClose", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 100,
      active_bin: 125, // 100 + 20 + 5 = 125
      in_range: false,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result?.action).toBe("CLOSE");
    expect(result?.rule).toBe(3);
    expect(result?.reason).toBe("pumped far above range");
  });

  test("does not trigger when active_bin == upper_bin + outOfRangeBinsToClose", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 100,
      active_bin: 120, // Exactly 100 + 20
      in_range: false,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result === null).toBe(true);
  });

  test("Rule 3 takes priority over Rule 4 (OOR)", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 100,
      active_bin: 150, // Far above range (100 + 20 + 30)
      in_range: false,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 35, // Also exceeds OOR wait time
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    // Rule 3 should trigger before Rule 4
    expect(result?.action).toBe("CLOSE");
    expect(result?.rule).toBe(3);
  });
});

describe("Exit Rules - evaluateManagementExitRules Out of Range (Rule 4)", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  test("triggers after wait time exceeded when active_bin > upper_bin", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 100,
      active_bin: 110, // Above upper_bin (100) but not above 100 + 20 = 120
      in_range: false,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 35,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result?.action).toBe("CLOSE");
    expect(result?.rule).toBe(4);
    expect(result?.reason).toBe("OOR");
  });

  test("does not trigger if within wait window", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 100,
      active_bin: 110, // Above upper_bin (100) but not above 100 + 20 = 120
      in_range: false,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 15,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result === null).toBe(true);
  });

  test("does not trigger when active_bin <= upper_bin (in range)", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 100,
      active_bin: 90,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result === null).toBe(true);
  });

  test("triggers exactly at wait time threshold", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 100,
      active_bin: 110, // Above upper_bin (100) but not above 100 + 20 = 120
      in_range: false,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 30,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result?.action).toBe("CLOSE");
    expect(result?.rule).toBe(4);
  });
});

describe("Exit Rules - evaluateManagementExitRules Low Yield", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
    minAgeBeforeYieldCheck: 60,
  };

  test("triggers when fee/TVL below threshold after min age", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.0005,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result?.action).toBe("CLOSE");
    expect(result?.rule).toBe(5);
    expect(result?.reason).toBe("low yield");
  });

  test("does not trigger when fee/TVL above threshold", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result === null).toBe(true);
  });

  test("does not trigger before min age threshold", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.0005,
      age_minutes: 30,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result === null).toBe(true);
  });

  test("triggers at exact min age threshold", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.0005,
      age_minutes: 60,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result?.action).toBe("CLOSE");
    expect(result?.rule).toBe(5);
  });
});

describe("Exit Rules - evaluateManagementExitRules Claim Fees", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
    minAgeBeforeYieldCheck: 60,
    minClaimAmount: 1.0,
  };

  test("triggers when unclaimed_fees_usd >= minClaimAmount", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 1.5,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 1.5,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result?.action).toBe("CLAIM");
  });

  test("does not trigger when unclaimed_fees_usd < minClaimAmount", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0.5,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0.5,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result?.action === "CLAIM").toBe(false);
  });

  test("does not trigger when unclaimed_fees_usd is 0", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result?.action === "CLAIM").toBe(false);
  });

  test("handles null/undefined unclaimed_fees_usd as 0", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: null,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: null,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result?.action === "CLAIM").toBe(false);
  });

  test("Claim action comes after low yield check (priority order)", () => {
    // When both low yield and claim conditions are met, low yield should trigger first
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 1.5, // Above claim threshold
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 1.5,
      fee_per_tvl_24h: 0.0005, // Below threshold (low yield)
      age_minutes: 90, // Above min age
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    // Rule 5 (low yield) should trigger before Claim
    expect(result?.action).toBe("CLOSE");
    expect(result?.rule).toBe(5);
  });

  test("triggers at exact threshold (unclaimed_fees_usd == minClaimAmount)", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 1.0, // Exactly at threshold
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 1.0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result?.action).toBe("CLAIM");
  });

  test("does not trigger when minClaimAmount is not configured", () => {
    const configWithoutMinClaim: ManagementConfig = {
      stopLossPct: -25,
      takeProfitFeePct: 10,
      outOfRangeWaitMinutes: 30,
      minFeePerTvl24h: 0.001,
      // minClaimAmount is undefined - defaults to 5
    };

    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 2.0, // Less than default 5
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 2.0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, configWithoutMinClaim, false);

    // When unclaimed fees < default minClaimAmount (5), claim rule should not trigger
    expect(result?.action === "CLAIM").toBe(false);
  });
});

describe("Exit Rules - evaluateManagementExitRules Healthy Position (No Exit)", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  test("returns null when position is healthy", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 105,
      total_value_true_usd: 105,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 5,
      pnl_true_usd: 5,
      pnl_pct: 5,
      pnl_pct_derived: 5,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result === null).toBe(true);
  });

  test("returns null at zero PnL", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 100,
      total_value_true_usd: 100,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 0,
      pnl_true_usd: 0,
      pnl_pct: 0,
      pnl_pct_derived: 0,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result === null).toBe(true);
  });

  test("returns null with moderate positive PnL", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 107,
      total_value_true_usd: 107,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 7,
      pnl_true_usd: 7,
      pnl_pct: 7,
      pnl_pct_derived: 7,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result === null).toBe(true);
  });

  test("returns null with moderate negative PnL (above stop loss)", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 90,
      total_value_true_usd: 90,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: -10,
      pnl_true_usd: -10,
      pnl_pct: -10,
      pnl_pct_derived: -10,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    expect(result === null).toBe(true);
  });
});

describe("Exit Rules - evaluateManagementExitRules Priority Order", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  test("stop loss takes priority over take profit when both conditions met", () => {
    // This shouldn't happen in practice, but test priority
    // If pnl_pct is somehow both <= -25 and >= 10, stop loss should win
    // (This is actually impossible, so we test the boundary)

    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 120,
      active_bin: 100,
      in_range: true,
      unclaimed_fees_usd: 0,
      total_value_usd: 75,
      total_value_true_usd: 75,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: -25,
      pnl_true_usd: -25,
      pnl_pct: -25,
      pnl_pct_derived: -25,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 0,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    // Stop loss (rule 1) should trigger before take profit (rule 2)
    expect(result?.action).toBe("CLOSE");
    expect(result?.rule).toBe(1);
  });

  test("take profit takes priority over OOR when both conditions met", () => {
    const position: EnrichedPosition = {
      position: "test",
      pool: "test-pool",
      pair: "TEST/SOL",
      base_mint: "test-mint",
      lower_bin: 80,
      upper_bin: 100,
      active_bin: 150,
      in_range: false,
      unclaimed_fees_usd: 0,
      total_value_usd: 115,
      total_value_true_usd: 115,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 15,
      pnl_true_usd: 15,
      pnl_pct: 15,
      pnl_pct_derived: 15,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: 0,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      minutes_out_of_range: 35,
      instruction: null,
      tracked_state: null,
    };

    const result = evaluateManagementExitRules(position, baseConfig, false);

    // Take profit (rule 2) should trigger before OOR (rule 4)
    expect(result?.action).toBe("CLOSE");
    expect(result?.rule).toBe(2);
  });
});

// ============================================================================
// Run tests if this file is executed directly
// ============================================================================

// Run tests immediately (characterization tests should run on import)
runTests();
