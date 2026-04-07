/**
 * Phase 0 Characterization Tests: Config Mutation and Persistence
 *
 * Tests the config mutation logic that mimics tools/executor.ts lines 214-349
 */

import { describe, expect, runTests, test } from "./test-harness.js";

// Mock CONFIG_MAP mimicking executor.ts lines 218-270
const CONFIG_MAP: Record<string, [string, string]> = {
  // screening
  minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
  minTvl: ["screening", "minTvl"],
  maxTvl: ["screening", "maxTvl"],
  minVolume: ["screening", "minVolume"],
  minOrganic: ["screening", "minOrganic"],
  minHolders: ["screening", "minHolders"],
  minMcap: ["screening", "minMcap"],
  maxMcap: ["screening", "maxMcap"],
  minBinStep: ["screening", "minBinStep"],
  maxBinStep: ["screening", "maxBinStep"],
  timeframe: ["screening", "timeframe"],
  category: ["screening", "category"],
  minTokenFeesSol: ["screening", "minTokenFeesSol"],
  maxBundlePct: ["screening", "maxBundlePct"],
  maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
  maxTop10Pct: ["screening", "maxTop10Pct"],
  minTokenAgeHours: ["screening", "minTokenAgeHours"],
  maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
  athFilterPct: ["screening", "athFilterPct"],
  minFeePerTvl24h: ["management", "minFeePerTvl24h"],
  // management
  minClaimAmount: ["management", "minClaimAmount"],
  autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
  outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
  outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
  oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
  oorCooldownHours: ["management", "oorCooldownHours"],
  minVolumeToRebalance: ["management", "minVolumeToRebalance"],
  stopLossPct: ["management", "stopLossPct"],
  takeProfitFeePct: ["management", "takeProfitFeePct"],
  trailingTakeProfit: ["management", "trailingTakeProfit"],
  trailingTriggerPct: ["management", "trailingTriggerPct"],
  trailingDropPct: ["management", "trailingDropPct"],
  solMode: ["management", "solMode"],
  minSolToOpen: ["management", "minSolToOpen"],
  deployAmountSol: ["management", "deployAmountSol"],
  gasReserve: ["management", "gasReserve"],
  positionSizePct: ["management", "positionSizePct"],
  // risk
  maxPositions: ["risk", "maxPositions"],
  maxDeployAmount: ["risk", "maxDeployAmount"],
  // schedule
  managementIntervalMin: ["schedule", "managementIntervalMin"],
  screeningIntervalMin: ["schedule", "screeningIntervalMin"],
  // models
  managementModel: ["llm", "managementModel"],
  screeningModel: ["llm", "screeningModel"],
  generalModel: ["llm", "generalModel"],
  // strategy
  binsBelow: ["strategy", "binsBelow"],
};

// Mock live config object
interface MockConfig {
  screening: {
    minTvl: number;
    maxTvl: number;
    minVolume: number;
    minBinStep: number;
    maxBinStep: number;
    [key: string]: string | number | boolean;
  };
  management: {
    deployAmountSol: number;
    gasReserve: number;
    outOfRangeWaitMinutes: number;
    [key: string]: string | number | boolean;
  };
  risk: {
    maxPositions: number;
    [key: string]: string | number | boolean;
  };
  schedule: {
    managementIntervalMin: number;
    screeningIntervalMin: number;
    [key: string]: string | number | boolean;
  };
  llm: {
    [key: string]: string | number | boolean;
  };
  strategy: {
    [key: string]: string | number | boolean;
  };
}

// Mock config mutation result
interface ConfigMutationResult {
  success: boolean;
  applied: Record<string, string | number | boolean>;
  unknown: string[];
  cronRestarted: boolean;
  persistedConfig: Record<string, unknown>;
}

// Mock _cronRestarter tracker
let cronRestartCalled = false;
let persistedUserConfig: Record<string, unknown> = {};

function resetMocks() {
  cronRestartCalled = false;
  persistedUserConfig = {};
}

function mockCronRestarter() {
  cronRestartCalled = true;
}

// Mock config mutation logic mimicking executor.ts lines 272-349
function mutateConfig(
  liveConfig: MockConfig,
  changes: Record<string, string | number | boolean>,
  _reason = ""
): ConfigMutationResult {
  const applied: Record<string, string | number | boolean> = {};
  const unknown: string[] = [];

  // Build case-insensitive lookup (lines 275-279)
  const CONFIG_MAP_LOWER: Record<string, [string, [string, string]]> = Object.entries(CONFIG_MAP)
    .map(([k, v]) => [k.toLowerCase(), [k, v] as [string, [string, string]]])
    .reduce((acc, [k, v]) => ({ ...acc, [k as string]: v }), {});

  // Process changes (lines 281-288)
  for (const [key, val] of Object.entries(changes)) {
    const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
    if (!match) {
      unknown.push(key);
      continue;
    }
    applied[match[0] as string] = val;
  }

  // If no valid keys, return failure (lines 290-296)
  if (Object.keys(applied).length === 0) {
    return {
      success: false,
      applied: {},
      unknown,
      cronRestarted: false,
      persistedConfig: {},
    };
  }

  // Apply to live config immediately (lines 298-309)
  for (const [key, val] of Object.entries(applied)) {
    const [section, field] = CONFIG_MAP[key];
    const configSection = liveConfig[section as keyof MockConfig];
    configSection[field] = val;
  }

  // Persist to user-config.json (lines 311-323)
  Object.assign(persistedUserConfig, applied);
  persistedUserConfig._lastAgentTune = new Date().toISOString();

  // Restart cron jobs if intervals changed (lines 325-334)
  const intervalChanged =
    applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
  if (intervalChanged) {
    mockCronRestarter();
  }

  return {
    success: true,
    applied,
    unknown,
    cronRestarted: intervalChanged,
    persistedConfig: { ...persistedUserConfig },
  };
}

// ============================================================================
// Test Suite: Valid Key Updates
// ============================================================================

describe("Valid Key Updates", () => {
  let mockConfig: MockConfig;

  test("valid key update writes to user-config.json and reflects in live config object", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(mockConfig, { minTvl: 15000 }, "test update");

    // Check success
    expect(result.success).toBe(true);
    expect(result.applied.minTvl).toBe(15000);

    // Check live config was updated
    expect(mockConfig.screening.minTvl).toBe(15000);

    // Check persisted config
    expect(result.persistedConfig.minTvl).toBe(15000);
    expect(result.persistedConfig._lastAgentTune !== undefined).toBeTruthy();
  });

  test("multiple keys can be updated in one call", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(
      mockConfig,
      {
        minTvl: 20000,
        maxPositions: 5,
        deployAmountSol: 1.0,
      },
      "multi-section update"
    );

    expect(result.success).toBe(true);
    expect(Object.keys(result.applied).length).toBe(3);

    // Verify all sections updated
    expect(mockConfig.screening.minTvl).toBe(20000);
    expect(mockConfig.risk.maxPositions).toBe(5);
    expect(mockConfig.management.deployAmountSol).toBe(1.0);

    // Verify persistence
    expect(result.persistedConfig.minTvl).toBe(20000);
    expect(result.persistedConfig.maxPositions).toBe(5);
    expect(result.persistedConfig.deployAmountSol).toBe(1.0);
  });
});

// ============================================================================
// Test Suite: Unknown Key Rejection
// ============================================================================

describe("Unknown Key Rejection", () => {
  let mockConfig: MockConfig;

  test("unknown key is rejected (not in CONFIG_MAP)", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(mockConfig, { unknownKey: 123, anotherBadKey: "test" }, "bad keys");

    // Should fail because no valid keys
    expect(result.success).toBe(false);
    expect(result.unknown.includes("unknownKey")).toBeTruthy();
    expect(result.unknown.includes("anotherBadKey")).toBeTruthy();
    expect(Object.keys(result.applied).length).toBe(0);
  });

  test("unknown keys rejected but valid ones applied in same call", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(
      mockConfig,
      { minTvl: 25000, badKey: "ignored", maxTvl: 200000 },
      "mixed keys"
    );

    // Should succeed with partial application
    expect(result.success).toBe(true);
    expect(result.applied.minTvl).toBe(25000);
    expect(result.applied.maxTvl).toBe(200000);
    expect(result.unknown.includes("badKey")).toBeTruthy();
    expect(Object.keys(result.applied).length).toBe(2);

    // Valid keys should be applied
    expect(mockConfig.screening.minTvl).toBe(25000);
    expect(mockConfig.screening.maxTvl).toBe(200000);
  });
});

// ============================================================================
// Test Suite: Cron Restart on Interval Change
// ============================================================================

describe("Cron Restart on Interval Change", () => {
  let mockConfig: MockConfig;

  test("interval change triggers cron restart signal (managementIntervalMin)", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(mockConfig, { managementIntervalMin: 15 }, "interval change");

    expect(result.success).toBe(true);
    expect(result.cronRestarted).toBe(true);
    expect(cronRestartCalled).toBe(true);
    expect(mockConfig.schedule.managementIntervalMin).toBe(15);
  });

  test("interval change triggers cron restart signal (screeningIntervalMin)", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(mockConfig, { screeningIntervalMin: 45 }, "interval change");

    expect(result.success).toBe(true);
    expect(result.cronRestarted).toBe(true);
    expect(cronRestartCalled).toBe(true);
    expect(mockConfig.schedule.screeningIntervalMin).toBe(45);
  });

  test("both interval changes trigger cron restart", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(
      mockConfig,
      { managementIntervalMin: 20, screeningIntervalMin: 60 },
      "both intervals"
    );

    expect(result.success).toBe(true);
    expect(result.cronRestarted).toBe(true);
    expect(cronRestartCalled).toBe(true);
  });

  test("non-interval keys do not trigger cron restart", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(mockConfig, { minTvl: 50000, maxPositions: 4 }, "no interval");

    expect(result.success).toBe(true);
    expect(result.cronRestarted).toBe(false);
    expect(cronRestartCalled).toBe(false);
  });
});

// ============================================================================
// Test Suite: Case-Insensitive Key Lookup
// ============================================================================

describe("Case-Insensitive Key Lookup", () => {
  let mockConfig: MockConfig;

  test("'mintvl' matches 'minTvl' (lowercase)", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(mockConfig, { mintvl: 30000 }, "lowercase key");

    expect(result.success).toBe(true);
    expect(result.applied.minTvl).toBe(30000);
    expect(mockConfig.screening.minTvl).toBe(30000);
  });

  test("'MAXTVL' matches 'maxTvl' (uppercase)", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(mockConfig, { MAXTVL: 300000 }, "uppercase key");

    expect(result.success).toBe(true);
    expect(result.applied.maxTvl).toBe(300000);
    expect(mockConfig.screening.maxTvl).toBe(300000);
  });

  test("'MinBinStep' matches 'minBinStep' (mixed case)", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(mockConfig, { MinBinStep: 100 }, "mixed case");

    expect(result.success).toBe(true);
    expect(result.applied.minBinStep).toBe(100);
    expect(mockConfig.screening.minBinStep).toBe(100);
  });

  test("'managementintervalmin' matches 'managementIntervalMin' (lowercase interval)", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(mockConfig, { managementintervalmin: 25 }, "lowercase interval");

    expect(result.success).toBe(true);
    expect(result.applied.managementIntervalMin).toBe(25);
    expect(result.cronRestarted).toBe(true);
    expect(mockConfig.schedule.managementIntervalMin).toBe(25);
  });

  test("multiple case-insensitive keys in one call", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const result = mutateConfig(
      mockConfig,
      { MINTVL: 40000, maxtvl: 500000, MINVOLUME: 1000 },
      "multiple case variants"
    );

    expect(result.success).toBe(true);
    expect(Object.keys(result.applied).length).toBe(3);
    expect(mockConfig.screening.minTvl).toBe(40000);
    expect(mockConfig.screening.maxTvl).toBe(500000);
    expect(mockConfig.screening.minVolume).toBe(1000);
  });
});

// ============================================================================
// Test Suite: Multiple Keys in One Call
// ============================================================================

describe("Multiple Keys in One Call", () => {
  let mockConfig: MockConfig;

  test("update multiple keys across different sections", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const changes = {
      minTvl: 25000,
      maxTvl: 300000,
      minVolume: 750,
      minBinStep: 85,
      maxBinStep: 130,
      deployAmountSol: 0.75,
      gasReserve: 0.25,
      maxPositions: 4,
    };

    const result = mutateConfig(mockConfig, changes, "comprehensive update");

    expect(result.success).toBe(true);
    expect(Object.keys(result.applied).length).toBe(8);

    // Verify all values updated
    expect(mockConfig.screening.minTvl).toBe(25000);
    expect(mockConfig.screening.maxTvl).toBe(300000);
    expect(mockConfig.screening.minVolume).toBe(750);
    expect(mockConfig.screening.minBinStep).toBe(85);
    expect(mockConfig.screening.maxBinStep).toBe(130);
    expect(mockConfig.management.deployAmountSol).toBe(0.75);
    expect(mockConfig.management.gasReserve).toBe(0.25);
    expect(mockConfig.risk.maxPositions).toBe(4);
  });

  test("handle boolean and string values correctly", () => {
    resetMocks();
    mockConfig = {
      screening: {
        minTvl: 10000,
        maxTvl: 150000,
        minVolume: 500,
        minBinStep: 80,
        maxBinStep: 125,
        timeframe: "5m",
        category: "trending",
      },
      management: {
        deployAmountSol: 0.5,
        gasReserve: 0.2,
        outOfRangeWaitMinutes: 30,
        trailingTakeProfit: false,
        solMode: false,
      },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: { managementModel: "default" },
      strategy: {},
    };

    const result = mutateConfig(
      mockConfig,
      {
        trailingTakeProfit: true,
        solMode: false,
        timeframe: "15m",
        category: "new",
        managementModel: "openrouter/gpt-4",
      },
      "mixed types"
    );

    expect(result.success).toBe(true);
    expect(result.applied.trailingTakeProfit).toBe(true);
    expect(result.applied.solMode).toBe(false);
    expect(result.applied.timeframe).toBe("15m");
    expect(result.applied.category).toBe("new");
    expect(result.applied.managementModel).toBe("openrouter/gpt-4");
  });

  test("persist _lastAgentTune timestamp on every update", () => {
    resetMocks();
    mockConfig = {
      screening: { minTvl: 10000, maxTvl: 150000, minVolume: 500, minBinStep: 80, maxBinStep: 125 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2, outOfRangeWaitMinutes: 30 },
      risk: { maxPositions: 3 },
      schedule: { managementIntervalMin: 10, screeningIntervalMin: 30 },
      llm: {},
      strategy: {},
    };

    const beforeTime = Date.now();
    const result = mutateConfig(mockConfig, { minTvl: 50000 }, "timestamp test");
    const afterTime = Date.now();

    expect(result.persistedConfig._lastAgentTune !== undefined).toBeTruthy();
    const timestamp = new Date(result.persistedConfig._lastAgentTune as string).getTime();
    expect(timestamp >= beforeTime).toBeTruthy();
    expect(timestamp <= afterTime).toBeTruthy();
  });
});

// ============================================================================
// Run tests if this file is executed directly
// ============================================================================

const isMainModule =
  import.meta.url.startsWith("file://") &&
  process.argv[1] &&
  import.meta.url.includes(process.argv[1].replace(/\\/g, "/"));
if (isMainModule) {
  runTests();
}

export type { ConfigMutationResult, MockConfig };
export { CONFIG_MAP, mutateConfig, resetMocks };
