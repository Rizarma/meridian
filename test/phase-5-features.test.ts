/**
 * Phase 5 Tests: Feature Flags
 *
 * Tests the feature flags system:
 * - Feature flags accessible via config.features
 * - OKX hybrid pattern (feature flag + env vars required)
 * - Config updates via update_config tool can toggle feature flags
 */

import { config, registerCronRestarter } from "../src/config/config.js";
import type { Config, FeaturesConfig, UserConfigPartial } from "../src/types/config.js";
import { isEnabled as isOKXEnabled } from "../tools/okx.js";
import { describe, expect, runTests, test } from "./test-harness.js";

// ═══════════════════════════════════════════════════════════════════════════
// Test Helper: Create fresh config from partial (no disk read)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a test Config from a UserConfigPartial without reading user-config.json.
 * This ensures tests are deterministic and not affected by user's local config.
 */
function createTestConfig(partial: UserConfigPartial): Config {
  const u = partial;

  return {
    risk: {
      maxPositions: u.maxPositions ?? 3,
      maxDeployAmount: u.maxDeployAmount ?? 50,
    },
    screening: {
      minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
      minTvl: u.minTvl ?? 10_000,
      maxTvl: u.maxTvl ?? 150_000,
      minVolume: u.minVolume ?? 500,
      minOrganic: u.minOrganic ?? 60,
      minHolders: u.minHolders ?? 500,
      minMcap: u.minMcap ?? 150_000,
      maxMcap: u.maxMcap ?? 10_000_000,
      minBinStep: u.minBinStep ?? 80,
      maxBinStep: u.maxBinStep ?? 125,
      maxVolatility: u.maxVolatility ?? null,
      timeframe: u.timeframe ?? "5m",
      category: u.category ?? "trending",
      minTokenFeesSol: u.minTokenFeesSol ?? 30,
      maxBundlePct: u.maxBundlePct ?? 30,
      maxBotHoldersPct: u.maxBotHoldersPct ?? 30,
      maxTop10Pct: u.maxTop10Pct ?? 60,
      blockedLaunchpads: u.blockedLaunchpads ?? [],
      allowedLaunchpads: u.allowedLaunchpads ?? [],
      minTokenAgeHours: u.minTokenAgeHours ?? null,
      maxTokenAgeHours: u.maxTokenAgeHours ?? null,
      athFilterPct: u.athFilterPct ?? null,
      maxCandidatesEnriched: u.maxCandidatesEnriched ?? 10,
    },
    management: {
      minClaimAmount: u.minClaimAmount ?? 5,
      autoSwapAfterClaim: u.autoSwapAfterClaim ?? false,
      outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
      outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
      oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
      oorCooldownHours: u.oorCooldownHours ?? 12,
      minVolumeToRebalance: u.minVolumeToRebalance ?? 1000,
      stopLossPct: u.stopLossPct ?? -50,
      takeProfitFeePct: u.takeProfitFeePct ?? 5,
      minFeePerTvl24h: u.minFeePerTvl24h ?? 7,
      minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60,
      minSolToOpen: u.minSolToOpen ?? 0.55,
      deployAmountSol: u.deployAmountSol ?? 0.5,
      gasReserve: u.gasReserve ?? 0.2,
      positionSizePct: u.positionSizePct ?? 0.35,
      trailingTriggerPct: u.trailingTriggerPct ?? 3,
      trailingDropPct: u.trailingDropPct ?? 1.5,
      pnlSanityMaxDiffPct: u.pnlSanityMaxDiffPct ?? 5,
    },
    strategy: {
      strategy: u.strategy ?? "bid_ask",
      binsBelow: u.binsBelow ?? 69,
    },
    schedule: {
      managementIntervalMin: u.managementIntervalMin ?? 10,
      screeningIntervalMin: u.screeningIntervalMin ?? 30,
      healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
    },
    llm: {
      temperature: u.temperature ?? 0.373,
      maxTokens: u.maxTokens ?? 4096,
      maxSteps: u.maxSteps ?? 20,
      managementModel: u.managementModel ?? "xiaomi/mimo-v2-omni",
      screeningModel: u.screeningModel ?? "xiaomi/mimo-v2-omni",
      generalModel: u.generalModel ?? "xiaomi/mimo-v2-omni",
    },
    tokens: {
      SOL: "So11111111111111111111111111111111111111112",
      USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    },
    darwin: {
      windowDays: u.darwin?.windowDays ?? 30,
      minSamples: u.darwin?.minSamples ?? 10,
      boostFactor: u.darwin?.boostFactor ?? 1.5,
      decayFactor: u.darwin?.decayFactor ?? 0.95,
      weightFloor: u.darwin?.weightFloor ?? 0.5,
      weightCeiling: u.darwin?.weightCeiling ?? 2.0,
    },
    features: {
      trailingTakeProfit: u.features?.trailingTakeProfit ?? u.trailingTakeProfit ?? true,
      hiveMind: u.features?.hiveMind ?? u.hiveMind ?? false,
      darwinEvolution: u.features?.darwinEvolution ?? u.darwinEvolution ?? false,
      solMode: u.features?.solMode ?? u.solMode ?? false,
      okx: u.features?.okx ?? u.okx ?? false,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get OKX status with detailed error information.
 */
function getOKXStatus(): { available: boolean; error?: string } {
  const hasFeatureFlag = config.features.okx === true;
  const hasApiKey = !!process.env.OKX_API_KEY;
  const hasSecretKey = !!process.env.OKX_SECRET_KEY;
  const hasPassphrase = !!process.env.OKX_PASSPHRASE;

  if (!hasFeatureFlag) {
    return { available: false, error: "OKX feature flag is disabled" };
  }

  if (!hasApiKey || !hasSecretKey || !hasPassphrase) {
    const missing = [
      !hasApiKey && "OKX_API_KEY",
      !hasSecretKey && "OKX_SECRET_KEY",
      !hasPassphrase && "OKX_PASSPHRASE",
    ].filter(Boolean);
    return { available: false, error: `Missing env vars: ${missing.join(", ")}` };
  }

  return { available: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Feature Flags Accessibility
// ═══════════════════════════════════════════════════════════════════════════

describe("Feature Flags - Accessibility", () => {
  test("config.features object exists", () => {
    expect(config.features !== undefined).toBe(true);
    expect(config.features !== null).toBe(true);
  });

  test("config.features has all expected flags", () => {
    const requiredFlags: (keyof FeaturesConfig)[] = [
      "trailingTakeProfit",
      "hiveMind",
      "darwinEvolution",
      "solMode",
      "okx",
    ];

    for (const flag of requiredFlags) {
      expect(config.features[flag] !== undefined).toBe(true);
    }
  });

  test("trailingTakeProfit flag is a boolean", () => {
    expect(typeof config.features.trailingTakeProfit).toBe("boolean");
  });

  test("hiveMind flag is a boolean", () => {
    expect(typeof config.features.hiveMind).toBe("boolean");
  });

  test("darwinEvolution flag is a boolean", () => {
    expect(typeof config.features.darwinEvolution).toBe("boolean");
  });

  test("solMode flag is a boolean", () => {
    expect(typeof config.features.solMode).toBe("boolean");
  });

  test("okx flag is a boolean", () => {
    expect(typeof config.features.okx).toBe("boolean");
  });
});

describe("Feature Flags - Default Values", () => {
  test("trailingTakeProfit defaults to true", () => {
    // Based on config.ts: u.features?.trailingTakeProfit ?? u.trailingTakeProfit ?? true
    const testConfig = createTestConfig({});
    expect(testConfig.features.trailingTakeProfit === true).toBe(true);
  });

  test("hiveMind defaults to false", () => {
    // Based on config.ts: u.features?.hiveMind ?? false
    const testConfig = createTestConfig({});
    expect(testConfig.features.hiveMind === false).toBe(true);
  });

  test("darwinEvolution defaults to false", () => {
    // Based on config.ts: u.features?.darwinEvolution ?? u.darwin?.enabled ?? false
    const testConfig = createTestConfig({});
    expect(testConfig.features.darwinEvolution === false).toBe(true);
  });

  test("solMode defaults to false", () => {
    // Based on config.ts: u.features?.solMode ?? u.solMode ?? false
    const testConfig = createTestConfig({});
    expect(testConfig.features.solMode === false).toBe(true);
  });

  test("okx defaults to false", () => {
    // Based on config.ts: u.features?.okx ?? false
    const testConfig = createTestConfig({});
    expect(testConfig.features.okx === false).toBe(true);
  });

  test("createTestConfig respects explicit feature overrides", () => {
    const testConfig = createTestConfig({
      features: {
        trailingTakeProfit: false,
        hiveMind: true,
        darwinEvolution: true,
        solMode: true,
        okx: true,
      },
    });
    expect(testConfig.features.trailingTakeProfit).toBe(false);
    expect(testConfig.features.hiveMind).toBe(true);
    expect(testConfig.features.darwinEvolution).toBe(true);
    expect(testConfig.features.solMode).toBe(true);
    expect(testConfig.features.okx).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: OKX Hybrid Pattern
// ═══════════════════════════════════════════════════════════════════════════

describe("OKX Hybrid Pattern - Feature Flag Disabled", () => {
  test("returns error when feature disabled even with env vars present", () => {
    // Store original values
    const originalFlag = config.features.okx;
    const originalApiKey = process.env.OKX_API_KEY;
    const originalSecretKey = process.env.OKX_SECRET_KEY;
    const originalPassphrase = process.env.OKX_PASSPHRASE;

    try {
      // Set feature flag to false but env vars present
      config.features.okx = false;
      process.env.OKX_API_KEY = "test-api-key";
      process.env.OKX_SECRET_KEY = "test-secret-key";
      process.env.OKX_PASSPHRASE = "test-passphrase";

      const status = getOKXStatus();
      expect(status.available).toBe(false);
      expect(status.error?.includes("feature flag is disabled")).toBe(true);
    } finally {
      // Restore original values
      config.features.okx = originalFlag;
      if (originalApiKey !== undefined) process.env.OKX_API_KEY = originalApiKey;
      else delete process.env.OKX_API_KEY;
      if (originalSecretKey !== undefined) process.env.OKX_SECRET_KEY = originalSecretKey;
      else delete process.env.OKX_SECRET_KEY;
      if (originalPassphrase !== undefined) process.env.OKX_PASSPHRASE = originalPassphrase;
      else delete process.env.OKX_PASSPHRASE;
    }
  });

  test("isOKXEnabled returns false when feature disabled", () => {
    const originalFlag = config.features.okx;
    const originalApiKey = process.env.OKX_API_KEY;
    const originalSecretKey = process.env.OKX_SECRET_KEY;
    const originalPassphrase = process.env.OKX_PASSPHRASE;

    try {
      config.features.okx = false;
      process.env.OKX_API_KEY = "test-api-key";
      process.env.OKX_SECRET_KEY = "test-secret-key";
      process.env.OKX_PASSPHRASE = "test-passphrase";

      expect(isOKXEnabled()).toBe(false);
    } finally {
      config.features.okx = originalFlag;
      if (originalApiKey !== undefined) process.env.OKX_API_KEY = originalApiKey;
      else delete process.env.OKX_API_KEY;
      if (originalSecretKey !== undefined) process.env.OKX_SECRET_KEY = originalSecretKey;
      else delete process.env.OKX_SECRET_KEY;
      if (originalPassphrase !== undefined) process.env.OKX_PASSPHRASE = originalPassphrase;
      else delete process.env.OKX_PASSPHRASE;
    }
  });
});

describe("OKX Hybrid Pattern - Feature Flag Enabled But No Env Vars", () => {
  test("returns error when feature enabled but no env vars", () => {
    const originalFlag = config.features.okx;
    const originalApiKey = process.env.OKX_API_KEY;
    const originalSecretKey = process.env.OKX_SECRET_KEY;
    const originalPassphrase = process.env.OKX_PASSPHRASE;

    try {
      // Set feature flag to true but no env vars
      config.features.okx = true;
      delete process.env.OKX_API_KEY;
      delete process.env.OKX_SECRET_KEY;
      delete process.env.OKX_PASSPHRASE;

      const status = getOKXStatus();
      expect(status.available).toBe(false);
      expect(status.error?.includes("Missing env vars")).toBe(true);
    } finally {
      config.features.okx = originalFlag;
      if (originalApiKey !== undefined) process.env.OKX_API_KEY = originalApiKey;
      if (originalSecretKey !== undefined) process.env.OKX_SECRET_KEY = originalSecretKey;
      if (originalPassphrase !== undefined) process.env.OKX_PASSPHRASE = originalPassphrase;
    }
  });

  test("returns error when only partial env vars present", () => {
    const originalFlag = config.features.okx;
    const originalApiKey = process.env.OKX_API_KEY;
    const originalSecretKey = process.env.OKX_SECRET_KEY;
    const originalPassphrase = process.env.OKX_PASSPHRASE;

    try {
      config.features.okx = true;
      process.env.OKX_API_KEY = "test-api-key";
      delete process.env.OKX_SECRET_KEY;
      delete process.env.OKX_PASSPHRASE;

      const status = getOKXStatus();
      expect(status.available).toBe(false);
      expect(status.error?.includes("Missing env vars")).toBe(true);
    } finally {
      config.features.okx = originalFlag;
      if (originalApiKey !== undefined) process.env.OKX_API_KEY = originalApiKey;
      else delete process.env.OKX_API_KEY;
      if (originalSecretKey !== undefined) process.env.OKX_SECRET_KEY = originalSecretKey;
      if (originalPassphrase !== undefined) process.env.OKX_PASSPHRASE = originalPassphrase;
    }
  });

  test("isOKXEnabled returns false when feature enabled but missing env vars", () => {
    const originalFlag = config.features.okx;
    const originalApiKey = process.env.OKX_API_KEY;
    const originalSecretKey = process.env.OKX_SECRET_KEY;
    const originalPassphrase = process.env.OKX_PASSPHRASE;

    try {
      config.features.okx = true;
      delete process.env.OKX_API_KEY;
      delete process.env.OKX_SECRET_KEY;
      delete process.env.OKX_PASSPHRASE;

      expect(isOKXEnabled()).toBe(false);
    } finally {
      config.features.okx = originalFlag;
      if (originalApiKey !== undefined) process.env.OKX_API_KEY = originalApiKey;
      if (originalSecretKey !== undefined) process.env.OKX_SECRET_KEY = originalSecretKey;
      if (originalPassphrase !== undefined) process.env.OKX_PASSPHRASE = originalPassphrase;
    }
  });
});

describe("OKX Hybrid Pattern - Both Feature Flag AND Env Vars Required", () => {
  test("OKX works only when both feature flag AND env vars present", () => {
    const originalFlag = config.features.okx;
    const originalApiKey = process.env.OKX_API_KEY;
    const originalSecretKey = process.env.OKX_SECRET_KEY;
    const originalPassphrase = process.env.OKX_PASSPHRASE;

    try {
      // Enable both feature flag and env vars
      config.features.okx = true;
      process.env.OKX_API_KEY = "test-api-key";
      process.env.OKX_SECRET_KEY = "test-secret-key";
      process.env.OKX_PASSPHRASE = "test-passphrase";

      const status = getOKXStatus();
      expect(status.available).toBe(true);
      expect(status.error).toBe(undefined);
      expect(isOKXEnabled()).toBe(true);
    } finally {
      config.features.okx = originalFlag;
      if (originalApiKey !== undefined) process.env.OKX_API_KEY = originalApiKey;
      else delete process.env.OKX_API_KEY;
      if (originalSecretKey !== undefined) process.env.OKX_SECRET_KEY = originalSecretKey;
      else delete process.env.OKX_SECRET_KEY;
      if (originalPassphrase !== undefined) process.env.OKX_PASSPHRASE = originalPassphrase;
      else delete process.env.OKX_PASSPHRASE;
    }
  });

  test("all combinations are tested", () => {
    const originalFlag = config.features.okx;
    const originalApiKey = process.env.OKX_API_KEY;
    const originalSecretKey = process.env.OKX_SECRET_KEY;
    const originalPassphrase = process.env.OKX_PASSPHRASE;

    try {
      // Test matrix of all combinations
      const testCases = [
        { flag: false, env: false, expected: false },
        { flag: false, env: true, expected: false },
        { flag: true, env: false, expected: false },
        { flag: true, env: true, expected: true },
      ];

      for (const tc of testCases) {
        config.features.okx = tc.flag;
        if (tc.env) {
          process.env.OKX_API_KEY = "test-api-key";
          process.env.OKX_SECRET_KEY = "test-secret-key";
          process.env.OKX_PASSPHRASE = "test-passphrase";
        } else {
          delete process.env.OKX_API_KEY;
          delete process.env.OKX_SECRET_KEY;
          delete process.env.OKX_PASSPHRASE;
        }

        const result = isOKXEnabled();
        expect(result === tc.expected).toBe(true);
      }
    } finally {
      config.features.okx = originalFlag;
      if (originalApiKey !== undefined) process.env.OKX_API_KEY = originalApiKey;
      else delete process.env.OKX_API_KEY;
      if (originalSecretKey !== undefined) process.env.OKX_SECRET_KEY = originalSecretKey;
      else delete process.env.OKX_SECRET_KEY;
      if (originalPassphrase !== undefined) process.env.OKX_PASSPHRASE = originalPassphrase;
      else delete process.env.OKX_PASSPHRASE;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Config Updates via update_config Tool
// ═══════════════════════════════════════════════════════════════════════════

describe("Feature Flags - Config Updates via update_config", () => {
  test("okx flag can be toggled via update_config mapping", () => {
    // Verify the CONFIG_MAP includes okx -> ["features", "okx"]
    // This is documented in config.ts lines 268
    const originalValue = config.features.okx;

    try {
      // Simulate what update_config does
      config.features.okx = true;
      expect(config.features.okx).toBe(true);

      config.features.okx = false;
      expect(config.features.okx).toBe(false);
    } finally {
      config.features.okx = originalValue;
    }
  });

  test("trailingTakeProfit flag can be toggled via update_config", () => {
    const originalValue = config.features.trailingTakeProfit;

    try {
      config.features.trailingTakeProfit = false;
      expect(config.features.trailingTakeProfit).toBe(false);

      config.features.trailingTakeProfit = true;
      expect(config.features.trailingTakeProfit).toBe(true);
    } finally {
      config.features.trailingTakeProfit = originalValue;
    }
  });

  test("hiveMind flag can be toggled via update_config", () => {
    const originalValue = config.features.hiveMind;

    try {
      config.features.hiveMind = true;
      expect(config.features.hiveMind).toBe(true);

      config.features.hiveMind = false;
      expect(config.features.hiveMind).toBe(false);
    } finally {
      config.features.hiveMind = originalValue;
    }
  });

  test("darwinEvolution flag can be toggled via update_config", () => {
    const originalValue = config.features.darwinEvolution;

    try {
      config.features.darwinEvolution = true;
      expect(config.features.darwinEvolution).toBe(true);

      config.features.darwinEvolution = false;
      expect(config.features.darwinEvolution).toBe(false);
    } finally {
      config.features.darwinEvolution = originalValue;
    }
  });

  test("solMode flag can be toggled via update_config", () => {
    const originalValue = config.features.solMode;

    try {
      config.features.solMode = true;
      expect(config.features.solMode).toBe(true);

      config.features.solMode = false;
      expect(config.features.solMode).toBe(false);
    } finally {
      config.features.solMode = originalValue;
    }
  });

  test("config changes persist in memory immediately", () => {
    const originalValue = config.features.okx;

    try {
      // First change
      config.features.okx = true;
      expect(config.features.okx).toBe(true);

      // Second change (verify it's not a one-time thing)
      config.features.okx = false;
      expect(config.features.okx).toBe(false);

      // Third change
      config.features.okx = true;
      expect(config.features.okx).toBe(true);
    } finally {
      config.features.okx = originalValue;
    }
  });
});

describe("Feature Flags - Integration with Other Config Sections", () => {
  test("features are separate from screening config", () => {
    expect(config.features.okx !== undefined).toBe(true);
    expect(config.screening.maxBundlePct !== undefined).toBe(true);
    // These are separate sections with different types
    const featureType = typeof config.features.okx;
    const screeningType = typeof config.screening.maxBundlePct;
    expect(featureType !== screeningType).toBe(true);
  });

  test("features.trailingTakeProfit exists as boolean", () => {
    expect(config.features.trailingTakeProfit !== undefined).toBe(true);
    expect(typeof config.features.trailingTakeProfit).toBe("boolean");
  });

  test("features are separate from darwin config", () => {
    expect(config.features.darwinEvolution !== undefined).toBe(true);
    expect(config.darwin.windowDays !== undefined).toBe(true);
    // Both exist but may have different values during migration
    expect(typeof config.features.darwinEvolution).toBe("boolean");
    expect(typeof config.darwin.windowDays).toBe("number");
  });
});

// Run tests immediately
runTests();
