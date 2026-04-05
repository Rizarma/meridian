/**
 * Phase 0 Exit Rules Characterization Tests
 *
 * These tests document the current behavior of exit rule logic
 * from index.ts (lines 317-359) and state.ts (lines 473-584).
 *
 * This is a characterization test - it captures existing behavior
 * before refactoring to ensure no regressions.
 */

import { describe, expect, runTests, test } from "./test-harness.js";

// ============================================================================
// Types (mirrored from types/state.d.ts)
// ============================================================================

interface PositionData {
  pnl_pct: number;
  pnl_pct_suspicious?: boolean;
  in_range: boolean;
  active_bin?: number;
  upper_bin?: number;
  fee_per_tvl_24h?: number;
  age_minutes?: number;
  unclaimed_fees_usd?: number | null;
}

interface ManagementConfig {
  trailingTakeProfit?: boolean;
  trailingTriggerPct?: number;
  trailingDropPct?: number;
  stopLossPct?: number;
  takeProfitFeePct?: number;
  outOfRangeWaitMinutes?: number;
  outOfRangeBinsToClose?: number;
  minFeePerTvl24h?: number;
  minAgeBeforeYieldCheck?: number;
  minClaimAmount?: number;
}

interface ExitAction {
  action: "CLOSE" | "STAY" | "CLAIM" | "STOP_LOSS" | "TRAILING_TP" | "OUT_OF_RANGE" | "LOW_YIELD";
  rule?: number;
  reason: string;
  needs_confirmation?: boolean;
}

interface PositionState {
  out_of_range_since: string | null;
  minutes_out_of_range: number;
  trailing_active: boolean;
  peak_pnl_pct: number;
}

// ============================================================================
// Mock evaluateExitConditions - mimics logic from index.ts and state.ts
// ============================================================================

/**
 * Mock implementation of exit condition evaluation.
 *
 * Based on:
 * - index.ts lines 317-359: Rule evaluation order
 * - state.ts lines 473-584: updatePnlAndCheckExits logic
 *
 * Exit rule priority (from index.ts):
 * 1. Stop loss (pnl_pct <= stopLossPct)
 * 2. Take profit (pnl_pct >= takeProfitFeePct)
 * 3. Pumped far above range (active_bin > upper_bin + outOfRangeBinsToClose)
 * 4. Stale above range (OOR for >= outOfRangeWaitMinutes)
 * 5. Low yield (fee_per_tvl_24h < minFeePerTvl24h after 60m)
 * 6. Claim fees (unclaimed_fees_usd >= minClaimAmount) [IMPLEMENTED]
 */
function evaluateExitConditions(
  positionData: PositionData,
  positionState: PositionState,
  config: ManagementConfig
): ExitAction {
  const {
    pnl_pct,
    pnl_pct_suspicious,
    in_range,
    active_bin,
    upper_bin,
    fee_per_tvl_24h,
    age_minutes,
  } = positionData;
  const { out_of_range_since, minutes_out_of_range, trailing_active, peak_pnl_pct } = positionState;

  // Rule 1: Stop loss
  // From index.ts line 318: if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct <= config.management.stopLossPct)
  if (
    !pnl_pct_suspicious &&
    pnl_pct != null &&
    config.stopLossPct != null &&
    pnl_pct <= config.stopLossPct
  ) {
    return {
      action: "CLOSE",
      rule: 1,
      reason: `Stop loss: PnL ${pnl_pct.toFixed(2)}% <= ${config.stopLossPct}%`,
    };
  }

  // Rule 2: Take profit
  // From index.ts line 323: if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct >= config.management.takeProfitFeePct)
  if (
    !pnl_pct_suspicious &&
    pnl_pct != null &&
    config.takeProfitFeePct != null &&
    pnl_pct >= config.takeProfitFeePct
  ) {
    return {
      action: "CLOSE",
      rule: 2,
      reason: "take profit",
    };
  }

  // Rule 3: Pumped far above range
  // From index.ts lines 328-335: if (p.active_bin > p.upper_bin + config.management.outOfRangeBinsToClose)
  if (
    active_bin != null &&
    upper_bin != null &&
    config.outOfRangeBinsToClose != null &&
    active_bin > upper_bin + config.outOfRangeBinsToClose
  ) {
    return {
      action: "CLOSE",
      rule: 3,
      reason: "pumped far above range",
    };
  }

  // Rule 4: Stale above range (OOR)
  // From index.ts lines 337-344: if (p.active_bin > p.upper_bin && (p.minutes_out_of_range ?? 0) >= config.management.outOfRangeWaitMinutes)
  if (
    active_bin != null &&
    upper_bin != null &&
    active_bin > upper_bin &&
    minutes_out_of_range != null &&
    config.outOfRangeWaitMinutes != null &&
    minutes_out_of_range >= config.outOfRangeWaitMinutes
  ) {
    return {
      action: "CLOSE",
      rule: 4,
      reason: `OOR: out of range for ${minutes_out_of_range}m (limit: ${config.outOfRangeWaitMinutes}m)`,
    };
  }

  // Rule 5: Low yield
  // From index.ts lines 347-353 and state.ts lines 568-581
  // Production requires age_minutes >= minAgeForYieldCheck (not null check)
  const minAgeForYieldCheck = config.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    config.minFeePerTvl24h != null &&
    fee_per_tvl_24h < config.minFeePerTvl24h &&
    age_minutes != null &&
    age_minutes >= minAgeForYieldCheck
  ) {
    return {
      action: "CLOSE",
      rule: 5,
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${config.minFeePerTvl24h}%`,
    };
  }

  // Rule 6: Claim fees
  // From index.ts line 356: if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount)
  const unclaimedFees = positionData.unclaimed_fees_usd ?? 0;
  if (config.minClaimAmount != null && unclaimedFees >= config.minClaimAmount) {
    return {
      action: "CLAIM",
      rule: 6,
      reason: `Claim fees: $${unclaimedFees.toFixed(2)} >= $${config.minClaimAmount}`,
    };
  }

  // Trailing take profit check (from state.ts lines 541-553)
  // Note: This runs after stop loss but the mock follows index.ts ordering
  if (config.trailingTakeProfit && trailing_active && !pnl_pct_suspicious) {
    const dropFromPeak = peak_pnl_pct - pnl_pct;
    if (dropFromPeak >= (config.trailingDropPct ?? 0)) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${peak_pnl_pct.toFixed(2)}% → current ${pnl_pct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${config.trailingDropPct}%)`,
        needs_confirmation: true,
      };
    }
  }

  // No exit triggered
  return {
    action: "STAY",
    reason: "Position healthy",
  };
}

// ============================================================================
// Test Suite: Exit Rules
// ============================================================================

describe("Exit Rules - Stop Loss", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  const baseState: PositionState = {
    out_of_range_since: null,
    minutes_out_of_range: 0,
    trailing_active: false,
    peak_pnl_pct: 0,
  };

  test("triggers at threshold (pnl_pct <= stopLossPct)", () => {
    const positionData: PositionData = {
      pnl_pct: -25,
      in_range: true,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(1);
    expect(result.reason.includes("Stop loss")).toBeTruthy();
  });

  test("triggers below threshold (pnl_pct < stopLossPct)", () => {
    const positionData: PositionData = {
      pnl_pct: -30,
      in_range: true,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(1);
  });

  test("does not trigger above threshold (pnl_pct > stopLossPct)", () => {
    const positionData: PositionData = {
      pnl_pct: -20,
      in_range: true,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("does not trigger when PnL is suspicious", () => {
    const positionData: PositionData = {
      pnl_pct: -30,
      pnl_pct_suspicious: true,
      in_range: true,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    // When PnL is suspicious, stop loss is skipped (falls through to STAY)
    expect(result.action).toBe("STAY");
  });
});

describe("Exit Rules - Take Profit", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  const baseState: PositionState = {
    out_of_range_since: null,
    minutes_out_of_range: 0,
    trailing_active: false,
    peak_pnl_pct: 0,
  };

  test("triggers at threshold (pnl_pct >= takeProfitFeePct)", () => {
    const positionData: PositionData = {
      pnl_pct: 10,
      in_range: true,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(2);
    expect(result.reason).toBe("take profit");
  });

  test("triggers above threshold (pnl_pct > takeProfitFeePct)", () => {
    const positionData: PositionData = {
      pnl_pct: 15,
      in_range: true,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(2);
  });

  test("does not trigger below threshold (pnl_pct < takeProfitFeePct)", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("does not trigger when PnL is suspicious", () => {
    const positionData: PositionData = {
      pnl_pct: 15,
      pnl_pct_suspicious: true,
      in_range: true,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    // When PnL is suspicious, take profit is skipped
    expect(result.action).toBe("STAY");
  });
});

describe("Exit Rules - Pumped Far Above Range (Rule 3)", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeBinsToClose: 20,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  const baseState: PositionState = {
    out_of_range_since: null,
    minutes_out_of_range: 0,
    trailing_active: false,
    peak_pnl_pct: 0,
  };

  test("triggers when active_bin > upper_bin + outOfRangeBinsToClose", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: false,
      active_bin: 125, // 100 + 20 + 5 = 125
      upper_bin: 100,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(3);
    expect(result.reason).toBe("pumped far above range");
  });

  test("does not trigger when active_bin == upper_bin + outOfRangeBinsToClose", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: false,
      active_bin: 120, // Exactly 100 + 20
      upper_bin: 100,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("does not trigger when active_bin < upper_bin + outOfRangeBinsToClose", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      active_bin: 115, // Less than 100 + 20
      upper_bin: 100,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("does not trigger when active_bin is within range", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      active_bin: 90,
      upper_bin: 100,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("Rule 3 takes priority over Rule 4 (OOR)", () => {
    // When both Rule 3 and Rule 4 conditions are met, Rule 3 should trigger first
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: false,
      active_bin: 150, // Far above range (100 + 20 + 30)
      upper_bin: 100,
    };

    const positionState: PositionState = {
      out_of_range_since: "2024-01-01T00:00:00Z",
      minutes_out_of_range: 35, // Also exceeds OOR wait time
      trailing_active: false,
      peak_pnl_pct: 5,
    };

    const result = evaluateExitConditions(positionData, positionState, baseConfig);

    // Rule 3 should trigger before Rule 4
    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(3);
  });
});

describe("Exit Rules - Out of Range (OOR)", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  test("triggers after wait time exceeded when active_bin > upper_bin", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: false,
      active_bin: 150,
      upper_bin: 100,
    };

    const positionState: PositionState = {
      out_of_range_since: "2024-01-01T00:00:00Z",
      minutes_out_of_range: 35,
      trailing_active: false,
      peak_pnl_pct: 5,
    };

    const result = evaluateExitConditions(positionData, positionState, baseConfig);

    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(4);
    expect(result.reason.includes("OOR")).toBeTruthy();
  });

  test("does not trigger if within wait window", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: false,
      active_bin: 150,
      upper_bin: 100,
    };

    const positionState: PositionState = {
      out_of_range_since: "2024-01-01T00:00:00Z",
      minutes_out_of_range: 15,
      trailing_active: false,
      peak_pnl_pct: 5,
    };

    const result = evaluateExitConditions(positionData, positionState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("does not trigger when active_bin <= upper_bin (in range)", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      active_bin: 80,
      upper_bin: 100,
    };

    const positionState: PositionState = {
      out_of_range_since: null,
      minutes_out_of_range: 0,
      trailing_active: false,
      peak_pnl_pct: 5,
    };

    const result = evaluateExitConditions(positionData, positionState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("triggers exactly at wait time threshold", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: false,
      active_bin: 150,
      upper_bin: 100,
    };

    const positionState: PositionState = {
      out_of_range_since: "2024-01-01T00:00:00Z",
      minutes_out_of_range: 30,
      trailing_active: false,
      peak_pnl_pct: 5,
    };

    const result = evaluateExitConditions(positionData, positionState, baseConfig);

    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(4);
  });
});

describe("Exit Rules - Low Yield", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
    minAgeBeforeYieldCheck: 60,
  };

  const baseState: PositionState = {
    out_of_range_since: null,
    minutes_out_of_range: 0,
    trailing_active: false,
    peak_pnl_pct: 0,
  };

  test("triggers when fee/TVL below threshold after min age", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.0005,
      age_minutes: 90,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(5);
    expect(result.reason.includes("Low yield")).toBeTruthy();
  });

  test("does not trigger when fee/TVL above threshold", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("does not trigger before min age threshold", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.0005,
      age_minutes: 30,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("does not trigger when age is null (unknown age, skip yield check)", () => {
    // Production behavior: (p.age_minutes ?? 0) >= 60
    // If age_minutes is null, it defaults to 0, and 0 >= 60 is false
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.0005,
      age_minutes: undefined,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    // When age is unknown (null), low yield check is skipped
    expect(result.action).toBe("STAY");
  });

  test("triggers at exact min age threshold", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.0005,
      age_minutes: 60,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(5);
  });
});

describe("Exit Rules - Claim Fees", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
    minAgeBeforeYieldCheck: 60,
    minClaimAmount: 1.0,
  };

  const baseState: PositionState = {
    out_of_range_since: null,
    minutes_out_of_range: 0,
    trailing_active: false,
    peak_pnl_pct: 0,
  };

  test("triggers when unclaimed_fees_usd >= minClaimAmount", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      unclaimed_fees_usd: 1.5,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("CLAIM");
    expect(result.rule).toBe(6);
    expect(result.reason.includes("Claim fees")).toBeTruthy();
  });

  test("does not trigger when unclaimed_fees_usd < minClaimAmount", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      unclaimed_fees_usd: 0.5,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("does not trigger when unclaimed_fees_usd is 0", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      unclaimed_fees_usd: 0,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("handles null/undefined unclaimed_fees_usd as 0", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      unclaimed_fees_usd: null,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("Claim action comes after low yield check (priority order)", () => {
    // When both low yield and claim conditions are met, low yield should trigger first
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.0005, // Below threshold (low yield)
      age_minutes: 90, // Above min age
      unclaimed_fees_usd: 1.5, // Above claim threshold
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    // Rule 5 (low yield) should trigger before Rule 6 (claim)
    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(5);
  });

  test("triggers at exact threshold (unclaimed_fees_usd == minClaimAmount)", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      unclaimed_fees_usd: 1.0, // Exactly at threshold
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("CLAIM");
    expect(result.rule).toBe(6);
  });

  test("does not trigger when minClaimAmount is not configured", () => {
    const configWithoutMinClaim: ManagementConfig = {
      stopLossPct: -25,
      takeProfitFeePct: 10,
      outOfRangeWaitMinutes: 30,
      minFeePerTvl24h: 0.001,
      // minClaimAmount is undefined
    };

    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
      unclaimed_fees_usd: 5.0, // High unclaimed fees
    };

    const result = evaluateExitConditions(positionData, baseState, configWithoutMinClaim);

    // When minClaimAmount is not set, claim rule should not trigger
    expect(result.action).toBe("STAY");
  });
});

describe("Exit Rules - Healthy Position (No Exit)", () => {
  const baseConfig: ManagementConfig = {
    stopLossPct: -25,
    takeProfitFeePct: 10,
    outOfRangeWaitMinutes: 30,
    minFeePerTvl24h: 0.001,
  };

  const baseState: PositionState = {
    out_of_range_since: null,
    minutes_out_of_range: 0,
    trailing_active: false,
    peak_pnl_pct: 0,
  };

  test("returns STAY when position is healthy", () => {
    const positionData: PositionData = {
      pnl_pct: 5,
      in_range: true,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
    expect(result.reason).toBe("Position healthy");
  });

  test("returns STAY at zero PnL", () => {
    const positionData: PositionData = {
      pnl_pct: 0,
      in_range: true,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("returns STAY with moderate positive PnL", () => {
    const positionData: PositionData = {
      pnl_pct: 7,
      in_range: true,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });

  test("returns STAY with moderate negative PnL (above stop loss)", () => {
    const positionData: PositionData = {
      pnl_pct: -10,
      in_range: true,
      fee_per_tvl_24h: 0.002,
      age_minutes: 90,
    };

    const result = evaluateExitConditions(positionData, baseState, baseConfig);

    expect(result.action).toBe("STAY");
  });
});

describe("Exit Rules - Priority Order", () => {
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

    const positionData: PositionData = {
      pnl_pct: -25,
      in_range: true,
    };

    const positionState: PositionState = {
      out_of_range_since: null,
      minutes_out_of_range: 0,
      trailing_active: false,
      peak_pnl_pct: 0,
    };

    const result = evaluateExitConditions(positionData, positionState, baseConfig);

    // Stop loss (rule 1) should trigger before take profit (rule 2)
    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(1);
  });

  test("take profit takes priority over OOR when both conditions met", () => {
    const positionData: PositionData = {
      pnl_pct: 15,
      in_range: false,
    };

    const positionState: PositionState = {
      out_of_range_since: "2024-01-01T00:00:00Z",
      minutes_out_of_range: 35,
      trailing_active: false,
      peak_pnl_pct: 15,
    };

    const result = evaluateExitConditions(positionData, positionState, baseConfig);

    // Take profit (rule 2) should trigger before OOR (rule 4)
    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(2);
  });
});

// ============================================================================
// Run tests if this file is executed directly
// ============================================================================

// Run tests immediately (characterization tests should run on import)
runTests();

export type { ExitAction, ManagementConfig, PositionData, PositionState };
export { evaluateExitConditions };
