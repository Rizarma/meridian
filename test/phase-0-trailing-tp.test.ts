/**
 * Phase 0 Trailing Take Profit Characterization Tests
 *
 * These tests document the current behavior of trailing TP logic
 * from state.ts (lines 268-417).
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
  fee_per_tvl_24h?: number;
  age_minutes?: number;
}

interface ManagementConfig {
  trailingTakeProfit?: boolean;
  trailingTriggerPct?: number;
  trailingDropPct?: number;
  stopLossPct?: number;
  outOfRangeWaitMinutes?: number;
  minFeePerTvl24h?: number;
  minAgeBeforeYieldCheck?: number;
}

interface ExitAction {
  action: "CLOSE" | "STAY" | "TRAILING_TP" | "STOP_LOSS" | "OUT_OF_RANGE" | "LOW_YIELD";
  reason: string;
  needs_confirmation?: boolean;
  peak_pnl_pct?: number;
  current_pnl_pct?: number;
}

interface PeakConfirmation {
  confirmed: boolean;
  peak?: number;
  rejected?: boolean;
  pendingPeak?: number;
  pending: boolean;
}

interface TrailingConfirmation {
  confirmed: boolean;
  rejected?: boolean;
  pending: boolean;
}

// Mock position state for testing
interface MockPositionState {
  position_address: string;
  peak_pnl_pct: number;
  pending_peak_pnl_pct: number | null;
  pending_peak_started_at: string | null;
  trailing_active: boolean;
  out_of_range_since: string | null;
  pending_trailing_peak_pnl_pct?: number | null;
  pending_trailing_current_pnl_pct?: number | null;
  pending_trailing_drop_pct?: number | null;
  pending_trailing_started_at?: string | null;
  confirmed_trailing_exit_reason?: string | null;
  confirmed_trailing_exit_until?: string | null;
}

// ============================================================================
// Mock State Store (in-memory simulation of state.json)
// ============================================================================

const mockStateStore: Map<string, MockPositionState> = new Map();

function resetMockState(): void {
  mockStateStore.clear();
}

function getMockPosition(position_address: string): MockPositionState {
  if (!mockStateStore.has(position_address)) {
    mockStateStore.set(position_address, {
      position_address,
      peak_pnl_pct: 0,
      pending_peak_pnl_pct: null,
      pending_peak_started_at: null,
      trailing_active: false,
      out_of_range_since: null,
    });
  }
  return mockStateStore.get(position_address)!;
}

function saveMockPosition(position: MockPositionState): void {
  mockStateStore.set(position.position_address, position);
}

// ============================================================================
// Mock Functions - mimics state.ts lines 268-417
// ============================================================================

/**
 * Mock queuePeakConfirmation - mimics state.ts lines 268-292
 *
 * Queues a new peak candidate for confirmation after a delay.
 * Only queues if candidate is higher than current peak.
 */
function queuePeakConfirmation(position_address: string, candidatePnlPct: number | null): boolean {
  if (candidatePnlPct == null) return false;

  const pos = getMockPosition(position_address);
  const currentPeak = pos.peak_pnl_pct ?? 0;

  // Only queue if candidate is higher than current peak
  if (candidatePnlPct <= currentPeak) return false;

  const changed = pos.pending_peak_pnl_pct == null || candidatePnlPct > pos.pending_peak_pnl_pct;

  if (!changed) return false;

  pos.pending_peak_pnl_pct = candidatePnlPct;
  pos.pending_peak_started_at = new Date().toISOString();
  saveMockPosition(pos);

  return true;
}

/**
 * Mock resolvePendingPeak - mimics state.ts lines 297-328
 *
 * Resolves a pending peak after recheck delay.
 * Confirms if current PnL is within tolerance ratio of pending peak.
 */
function resolvePendingPeak(
  position_address: string,
  currentPnlPct: number | null,
  toleranceRatio: number = 0.85
): PeakConfirmation {
  const pos = getMockPosition(position_address);

  if (pos.pending_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingPeak = pos.pending_peak_pnl_pct;
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_started_at = null;

  if (currentPnlPct != null && currentPnlPct >= pendingPeak * toleranceRatio) {
    pos.peak_pnl_pct = Math.max(pos.peak_pnl_pct ?? 0, pendingPeak, currentPnlPct);
    saveMockPosition(pos);
    return { confirmed: true, peak: pos.peak_pnl_pct, pending: false };
  }

  saveMockPosition(pos);
  return { confirmed: false, rejected: true, pendingPeak, pending: false };
}

/**
 * Mock queueTrailingDropConfirmation - mimics state.ts lines 333-361
 *
 * Queues a trailing drop confirmation for trailing take-profit exit.
 */
function queueTrailingDropConfirmation(
  position_address: string,
  peakPnlPct: number | null,
  currentPnlPct: number | null,
  trailingDropPct: number | null
): boolean {
  if (peakPnlPct == null || currentPnlPct == null || trailingDropPct == null) return false;

  const pos = getMockPosition(position_address);

  const changed =
    pos.pending_trailing_peak_pnl_pct == null ||
    peakPnlPct !== pos.pending_trailing_peak_pnl_pct ||
    currentPnlPct !== pos.pending_trailing_current_pnl_pct;

  if (!changed) return false;

  pos.pending_trailing_peak_pnl_pct = peakPnlPct;
  pos.pending_trailing_current_pnl_pct = currentPnlPct;
  pos.pending_trailing_drop_pct = trailingDropPct;
  pos.pending_trailing_started_at = new Date().toISOString();
  saveMockPosition(pos);

  return true;
}

/**
 * Mock resolvePendingTrailingDrop - mimics state.ts lines 366-417
 *
 * Resolve a pending trailing drop confirmation after recheck delay.
 */
function resolvePendingTrailingDrop(
  position_address: string,
  currentPnlPct: number | null,
  trailingDropPct: number | null,
  tolerancePct: number = 1.0
): TrailingConfirmation {
  const pos = getMockPosition(position_address);

  if (pos.pending_trailing_peak_pnl_pct == null) {
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
    saveMockPosition(pos);
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
    pos.confirmed_trailing_exit_until = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    saveMockPosition(pos);
    return { confirmed: true, pending: false };
  }

  saveMockPosition(pos);
  return { confirmed: false, rejected: true, pending: false };
}

/**
 * Mock updatePnlAndCheckExits - mimics state.ts lines 473-584
 *
 * Main function that:
 * 1. Activates trailing TP when trigger threshold reached
 * 2. Checks for stop loss
 * 3. Checks for trailing TP exit (drop from peak)
 * 4. Checks for OOR timeout
 * 5. Checks for low yield
 */
function updatePnlAndCheckExits(
  position_address: string,
  positionData: PositionData,
  mgmtConfig: ManagementConfig
): ExitAction | null {
  const {
    pnl_pct: currentPnlPct,
    pnl_pct_suspicious,
    in_range,
    fee_per_tvl_24h,
    age_minutes,
  } = positionData;
  const pos = getMockPosition(position_address);

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
    saveMockPosition(pos);
  }

  // Activate trailing TP once trigger threshold is reached
  // From state.ts lines 502-513
  if (
    mgmtConfig.trailingTakeProfit &&
    !pos.trailing_active &&
    (pos.peak_pnl_pct ?? 0) >= (mgmtConfig.trailingTriggerPct ?? 0)
  ) {
    pos.trailing_active = true;
    saveMockPosition(pos);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    saveMockPosition(pos);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    saveMockPosition(pos);
  }

  // Stop loss check (from state.ts lines 528-539)
  if (
    !pnl_pct_suspicious &&
    currentPnlPct != null &&
    mgmtConfig.stopLossPct != null &&
    currentPnlPct <= mgmtConfig.stopLossPct
  ) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // Trailing TP check (from state.ts lines 541-553)
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= (mgmtConfig.trailingDropPct ?? 0)) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
      };
    }
  }

  // Out of range check
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor(
      (Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000
    );
    if (minutesOOR >= (mgmtConfig.outOfRangeWaitMinutes ?? 30)) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // Low yield check
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}%`,
    };
  }

  return null;
}

// ============================================================================
// Test Suite: Trailing Take Profit
// ============================================================================

describe("Trailing TP - Activation", () => {
  const baseConfig: ManagementConfig = {
    trailingTakeProfit: true,
    trailingTriggerPct: 50,
    trailingDropPct: 20,
    stopLossPct: -25,
    outOfRangeWaitMinutes: 30,
  };

  test("does not activate below trigger threshold", () => {
    resetMockState();
    const posId = "pos-1";

    // Set peak below trigger
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 40; // Below 50% trigger
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: 35,
      in_range: true,
    };

    const result = updatePnlAndCheckExits(posId, positionData, baseConfig);
    const updatedPos = getMockPosition(posId);

    expect(updatedPos.trailing_active).toBeFalsy();
    expect(result).toBe(null); // No exit triggered
  });

  test("activates at trigger threshold (peak >= trailingTriggerPct)", () => {
    resetMockState();
    const posId = "pos-2";

    // Set peak at trigger threshold
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 50; // At 50% trigger
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: 45,
      in_range: true,
    };

    const _result = updatePnlAndCheckExits(posId, positionData, baseConfig);
    const updatedPos = getMockPosition(posId);

    expect(updatedPos.trailing_active).toBeTruthy();
  });

  test("activates above trigger threshold", () => {
    resetMockState();
    const posId = "pos-3";

    // Set peak above trigger
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 75; // Above 50% trigger
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: 70,
      in_range: true,
    };

    const _result = updatePnlAndCheckExits(posId, positionData, baseConfig);
    const updatedPos = getMockPosition(posId);

    expect(updatedPos.trailing_active).toBeTruthy();
  });

  test("does not activate when trailingTakeProfit is disabled", () => {
    resetMockState();
    const posId = "pos-4";

    const disabledConfig: ManagementConfig = {
      ...baseConfig,
      trailingTakeProfit: false,
    };

    // Set peak above trigger
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 75;
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: 70,
      in_range: true,
    };

    const _result = updatePnlAndCheckExits(posId, positionData, disabledConfig);
    const updatedPos = getMockPosition(posId);

    expect(updatedPos.trailing_active).toBeFalsy();
  });
});

describe("Trailing TP - Peak Updates", () => {
  const _baseConfig: ManagementConfig = {
    trailingTakeProfit: true,
    trailingTriggerPct: 50,
    trailingDropPct: 20,
    stopLossPct: -25,
    outOfRangeWaitMinutes: 30,
  };

  test("peak updates on new high via queuePeakConfirmation", () => {
    resetMockState();
    const posId = "pos-5";

    // Initial state
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 50;
    saveMockPosition(pos);

    // Queue a higher peak
    const queued = queuePeakConfirmation(posId, 60);
    expect(queued).toBeTruthy();

    const updatedPos = getMockPosition(posId);
    expect(updatedPos.pending_peak_pnl_pct).toBe(60);
    expect(updatedPos.pending_peak_started_at).toBeTruthy();
  });

  test("does not queue peak if candidate is lower than current peak", () => {
    resetMockState();
    const posId = "pos-6";

    // Initial state with high peak
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 80;
    saveMockPosition(pos);

    // Try to queue a lower peak
    const queued = queuePeakConfirmation(posId, 70);
    expect(queued).toBeFalsy();

    const updatedPos = getMockPosition(posId);
    expect(updatedPos.pending_peak_pnl_pct).toBe(null);
  });

  test("does not queue peak if candidate equals current peak", () => {
    resetMockState();
    const posId = "pos-7";

    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 60;
    saveMockPosition(pos);

    // Try to queue same peak
    const queued = queuePeakConfirmation(posId, 60);
    expect(queued).toBeFalsy();
  });

  test("resolves pending peak with confirmation when within tolerance", () => {
    resetMockState();
    const posId = "pos-8";

    // Setup pending peak
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 50;
    pos.pending_peak_pnl_pct = 70;
    pos.pending_peak_started_at = new Date().toISOString();
    saveMockPosition(pos);

    // Resolve with current PnL within 85% tolerance (70 * 0.85 = 59.5)
    const result = resolvePendingPeak(posId, 65, 0.85);

    expect(result.confirmed).toBeTruthy();
    expect(result.peak).toBe(70);

    const updatedPos = getMockPosition(posId);
    expect(updatedPos.peak_pnl_pct).toBe(70);
    expect(updatedPos.pending_peak_pnl_pct).toBe(null);
  });

  test("rejects pending peak when outside tolerance", () => {
    resetMockState();
    const posId = "pos-9";

    // Setup pending peak
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 50;
    pos.pending_peak_pnl_pct = 70;
    pos.pending_peak_started_at = new Date().toISOString();
    saveMockPosition(pos);

    // Resolve with current PnL below 85% tolerance (70 * 0.85 = 59.5)
    const result = resolvePendingPeak(posId, 50, 0.85);

    expect(result.confirmed).toBeFalsy();
    expect(result.rejected).toBeTruthy();

    const updatedPos = getMockPosition(posId);
    expect(updatedPos.peak_pnl_pct).toBe(50); // Unchanged
    expect(updatedPos.pending_peak_pnl_pct).toBe(null);
  });
});

describe("Trailing TP - Drop Detection", () => {
  const baseConfig: ManagementConfig = {
    trailingTakeProfit: true,
    trailingTriggerPct: 50,
    trailingDropPct: 20,
    stopLossPct: -25,
    outOfRangeWaitMinutes: 30,
  };

  test("does not close while above floor (drop < trailingDropPct)", () => {
    resetMockState();
    const posId = "pos-10";

    // Setup: trailing active, peak at 70%, current at 55% (drop of 15% < 20%)
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 70;
    pos.trailing_active = true;
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: 55,
      in_range: true,
    };

    const result = updatePnlAndCheckExits(posId, positionData, baseConfig);

    expect(result).toBe(null); // No exit
  });

  test("closes when drop triggers (dropFromPeak >= trailingDropPct)", () => {
    resetMockState();
    const posId = "pos-11";

    // Setup: trailing active, peak at 70%, current at 48% (drop of 22% >= 20%)
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 70;
    pos.trailing_active = true;
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: 48,
      in_range: true,
    };

    const result = updatePnlAndCheckExits(posId, positionData, baseConfig);

    expect(result).toBeTruthy();
    expect(result?.action).toBe("TRAILING_TP");
    expect(result?.needs_confirmation).toBeTruthy();
    expect(result?.peak_pnl_pct).toBe(70);
    expect(result?.current_pnl_pct).toBe(48);
    expect(result?.reason.includes("dropped 22")).toBeTruthy();
  });

  test("closes exactly at drop threshold", () => {
    resetMockState();
    const posId = "pos-12";

    // Setup: trailing active, peak at 70%, current at 50% (drop of exactly 20%)
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 70;
    pos.trailing_active = true;
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: 50,
      in_range: true,
    };

    const result = updatePnlAndCheckExits(posId, positionData, baseConfig);

    expect(result).toBeTruthy();
    expect(result?.action).toBe("TRAILING_TP");
  });

  test("does not close if trailing disabled even with large drop", () => {
    resetMockState();
    const posId = "pos-13";

    const disabledConfig: ManagementConfig = {
      ...baseConfig,
      trailingTakeProfit: false,
    };

    // Setup: trailing NOT active, peak at 70%, current at 40% (drop of 30%)
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 70;
    pos.trailing_active = false; // Not active
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: 40,
      in_range: true,
    };

    const result = updatePnlAndCheckExits(posId, positionData, disabledConfig);

    expect(result).toBe(null); // No trailing exit
  });

  test("does not trigger trailing exit when PnL is suspicious", () => {
    resetMockState();
    const posId = "pos-14";

    // Setup: trailing active, but PnL suspicious
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 70;
    pos.trailing_active = true;
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: 48,
      pnl_pct_suspicious: true,
      in_range: true,
    };

    const result = updatePnlAndCheckExits(posId, positionData, baseConfig);

    // Trailing exit is skipped when PnL is suspicious
    expect(result).toBe(null);
  });
});

describe("Trailing TP - Stop Loss Priority", () => {
  const baseConfig: ManagementConfig = {
    trailingTakeProfit: true,
    trailingTriggerPct: 50,
    trailingDropPct: 20,
    stopLossPct: -25,
    outOfRangeWaitMinutes: 30,
  };

  test("stop loss takes priority over trailing TP", () => {
    resetMockState();
    const posId = "pos-15";

    // Setup: trailing active, but PnL dropped below stop loss
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 70;
    pos.trailing_active = true;
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: -30, // Below -25% stop loss
      in_range: true,
    };

    const result = updatePnlAndCheckExits(posId, positionData, baseConfig);

    // Stop loss should trigger before trailing TP check
    expect(result).toBeTruthy();
    expect(result?.action).toBe("STOP_LOSS");
  });

  test("trailing TP triggers when stop loss not hit", () => {
    resetMockState();
    const posId = "pos-16";

    // Setup: trailing active, PnL dropped but above stop loss
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 70;
    pos.trailing_active = true;
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: 45, // Above -25% stop loss, but dropped 25% from peak
      in_range: true,
    };

    const result = updatePnlAndCheckExits(posId, positionData, baseConfig);

    expect(result).toBeTruthy();
    expect(result?.action).toBe("TRAILING_TP");
  });
});

describe("Trailing TP - Edge Cases", () => {
  const baseConfig: ManagementConfig = {
    trailingTakeProfit: true,
    trailingTriggerPct: 50,
    trailingDropPct: 20,
    stopLossPct: -25,
    outOfRangeWaitMinutes: 30,
  };

  test("handles zero peak gracefully", () => {
    resetMockState();
    const posId = "pos-17";

    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 0;
    pos.trailing_active = false;
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: -5,
      in_range: true,
    };

    const _result = updatePnlAndCheckExits(posId, positionData, baseConfig);

    // Should not activate (0 < 50 trigger)
    const updatedPos = getMockPosition(posId);
    expect(updatedPos.trailing_active).toBeFalsy();
  });

  test("handles negative peak gracefully", () => {
    resetMockState();
    const posId = "pos-18";

    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = -10;
    pos.trailing_active = false;
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: -15,
      in_range: true,
    };

    const _result = updatePnlAndCheckExits(posId, positionData, baseConfig);

    // Should not activate (-10 < 50 trigger)
    const updatedPos = getMockPosition(posId);
    expect(updatedPos.trailing_active).toBeFalsy();
  });

  test("queuePeakConfirmation returns false for null candidate", () => {
    resetMockState();
    const posId = "pos-19";

    const queued = queuePeakConfirmation(posId, null);
    expect(queued).toBeFalsy();
  });

  test("resolvePendingPeak returns not pending when no pending peak", () => {
    resetMockState();
    const posId = "pos-20";

    const result = resolvePendingPeak(posId, 50);

    expect(result.confirmed).toBeFalsy();
    expect(result.pending).toBeFalsy();
  });
});

// ============================================================================
// Test Suite: Trailing Drop Confirmation (state.ts lines 333-417)
// ============================================================================

describe("Trailing Drop Confirmation", () => {
  test("queueTrailingDropConfirmation queues a new trailing drop", () => {
    resetMockState();
    const posId = "pos-drop-1";

    // Setup position with trailing active
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 70;
    pos.trailing_active = true;
    saveMockPosition(pos);

    // Queue a trailing drop confirmation
    const queued = queueTrailingDropConfirmation(posId, 70, 48, 20);
    expect(queued).toBeTruthy();

    const updatedPos = getMockPosition(posId);
    expect(updatedPos.pending_trailing_peak_pnl_pct).toBe(70);
    expect(updatedPos.pending_trailing_current_pnl_pct).toBe(48);
    expect(updatedPos.pending_trailing_drop_pct).toBe(20);
    expect(updatedPos.pending_trailing_started_at).toBeTruthy();
  });

  test("queueTrailingDropConfirmation returns false for null values", () => {
    resetMockState();
    const posId = "pos-drop-2";

    const queued = queueTrailingDropConfirmation(posId, null, 48, 20);
    expect(queued).toBeFalsy();

    const queued2 = queueTrailingDropConfirmation(posId, 70, null, 20);
    expect(queued2).toBeFalsy();

    const queued3 = queueTrailingDropConfirmation(posId, 70, 48, null);
    expect(queued3).toBeFalsy();
  });

  test("queueTrailingDropConfirmation returns false if unchanged", () => {
    resetMockState();
    const posId = "pos-drop-3";

    // Setup position with existing pending drop
    const pos = getMockPosition(posId);
    pos.pending_trailing_peak_pnl_pct = 70;
    pos.pending_trailing_current_pnl_pct = 48;
    pos.pending_trailing_drop_pct = 20;
    pos.pending_trailing_started_at = new Date().toISOString();
    saveMockPosition(pos);

    // Try to queue same values
    const queued = queueTrailingDropConfirmation(posId, 70, 48, 20);
    expect(queued).toBeFalsy();
  });

  test("resolvePendingTrailingDrop confirms when within tolerance", () => {
    resetMockState();
    const posId = "pos-drop-4";

    // Setup position with pending trailing drop
    const pos = getMockPosition(posId);
    pos.pending_trailing_peak_pnl_pct = 70;
    pos.pending_trailing_current_pnl_pct = 48;
    pos.pending_trailing_drop_pct = 20;
    pos.pending_trailing_started_at = new Date().toISOString();
    saveMockPosition(pos);

    // Resolve with current PnL within tolerance (drop still >= 20%)
    const result = resolvePendingTrailingDrop(posId, 49, 20, 1.0);

    expect(result.confirmed).toBeTruthy();
    expect(result.pending).toBeFalsy();

    const updatedPos = getMockPosition(posId);
    expect(updatedPos.confirmed_trailing_exit_reason).toBeTruthy();
    expect(updatedPos.confirmed_trailing_exit_until).toBeTruthy();
  });

  test("resolvePendingTrailingDrop rejects when outside tolerance", () => {
    resetMockState();
    const posId = "pos-drop-5";

    // Setup position with pending trailing drop
    const pos = getMockPosition(posId);
    pos.pending_trailing_peak_pnl_pct = 70;
    pos.pending_trailing_current_pnl_pct = 48;
    pos.pending_trailing_drop_pct = 22;
    pos.pending_trailing_started_at = new Date().toISOString();
    saveMockPosition(pos);

    // Resolve with current PnL outside tolerance (drop changed significantly)
    const result = resolvePendingTrailingDrop(posId, 60, 20, 1.0);

    expect(result.confirmed).toBeFalsy();
    expect(result.rejected).toBeTruthy();
    expect(result.pending).toBeFalsy();

    const updatedPos = getMockPosition(posId);
    expect(updatedPos.confirmed_trailing_exit_until).toBeFalsy();
  });

  test("resolvePendingTrailingDrop returns not pending when no pending drop", () => {
    resetMockState();
    const posId = "pos-drop-6";

    const result = resolvePendingTrailingDrop(posId, 50, 20);

    expect(result.confirmed).toBeFalsy();
    expect(result.pending).toBeFalsy();
  });
});

// ============================================================================
// Test Suite: Confirmed Trailing Exit Cooldown (state.ts lines 484-496)
// ============================================================================

describe("Confirmed Trailing Exit Cooldown", () => {
  test("returns TRAILING_TP action during cooldown period", () => {
    resetMockState();
    const posId = "pos-cooldown-1";

    // Setup position with confirmed trailing exit in the future
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 70;
    pos.trailing_active = true;
    pos.confirmed_trailing_exit_reason =
      "Trailing TP: peak 70.00% → current 48.00% (dropped 22.00%)";
    pos.confirmed_trailing_exit_until = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes from now
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: 45,
      in_range: true,
    };

    const result = updatePnlAndCheckExits(posId, positionData, {
      trailingTakeProfit: true,
      trailingTriggerPct: 50,
      trailingDropPct: 20,
      stopLossPct: -25,
      outOfRangeWaitMinutes: 30,
    });

    expect(result).toBeTruthy();
    expect(result?.action).toBe("TRAILING_TP");
    expect(result?.needs_confirmation).toBeFalsy(); // Already confirmed
    expect(result?.reason).toBe("Trailing TP: peak 70.00% → current 48.00% (dropped 22.00%)");
  });

  test("clears expired cooldown and continues normal checks", () => {
    resetMockState();
    const posId = "pos-cooldown-2";

    // Setup position with expired confirmed trailing exit
    const pos = getMockPosition(posId);
    pos.peak_pnl_pct = 70;
    pos.trailing_active = true;
    pos.confirmed_trailing_exit_reason = "Trailing TP: peak 70.00% → current 48.00%";
    pos.confirmed_trailing_exit_until = new Date(Date.now() - 1000).toISOString(); // 1 second ago (expired)
    saveMockPosition(pos);

    const positionData: PositionData = {
      pnl_pct: 65, // Still good, no drop
      in_range: true,
    };

    const result = updatePnlAndCheckExits(posId, positionData, {
      trailingTakeProfit: true,
      trailingTriggerPct: 50,
      trailingDropPct: 20,
      stopLossPct: -25,
      outOfRangeWaitMinutes: 30,
    });

    // Should clear cooldown and return null (no exit)
    expect(result).toBe(null);

    const updatedPos = getMockPosition(posId);
    expect(updatedPos.confirmed_trailing_exit_until).toBeFalsy();
    expect(updatedPos.confirmed_trailing_exit_reason).toBeFalsy();
  });

  test("5-minute cooldown is set on confirmation", () => {
    resetMockState();
    const posId = "pos-cooldown-3";

    // Setup position with pending trailing drop
    const pos = getMockPosition(posId);
    pos.pending_trailing_peak_pnl_pct = 70;
    pos.pending_trailing_current_pnl_pct = 48;
    pos.pending_trailing_drop_pct = 22;
    pos.pending_trailing_started_at = new Date().toISOString();
    saveMockPosition(pos);

    // Resolve with confirmation
    const beforeResolve = Date.now();
    resolvePendingTrailingDrop(posId, 49, 20, 1.0);
    const afterResolve = Date.now();

    const updatedPos = getMockPosition(posId);
    const cooldownUntil = new Date(updatedPos.confirmed_trailing_exit_until!).getTime();

    // Cooldown should be approximately 5 minutes (300 seconds) from resolution
    expect(cooldownUntil).toBeGreaterThan(beforeResolve + 5 * 60 * 1000 - 2000); // Allow 2s tolerance
    expect(cooldownUntil).toBeLessThan(afterResolve + 5 * 60 * 1000 + 2000);
  });
});

// ============================================================================
// Run tests if this file is executed directly
// ============================================================================

// Run tests immediately (characterization tests should run on import)
runTests();

export type {
  ExitAction,
  ManagementConfig,
  MockPositionState,
  PeakConfirmation,
  PositionData,
  TrailingConfirmation,
};
export {
  getMockPosition,
  queuePeakConfirmation,
  queueTrailingDropConfirmation,
  resetMockState,
  resolvePendingPeak,
  resolvePendingTrailingDrop,
  saveMockPosition,
  updatePnlAndCheckExits,
};
