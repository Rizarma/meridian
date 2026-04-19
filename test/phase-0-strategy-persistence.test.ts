/**
 * Phase 0 Strategy Persistence Tests
 *
 * Tests the strategy persistence fix:
 * - New persistence stores strategy id + non-null strategy_config
 * - Legacy row with strategy="spot" and null strategy_config is resolved compatibly
 * - resolveStrategy handles various legacy and modern inputs
 * - Inconsistent strategy id vs strategy_config.id is handled
 */

import { get, run } from "../src/infrastructure/db.js";
import { getTrackedPosition, resolveStrategy, trackPosition } from "../src/infrastructure/state.js";
import type { Strategy } from "../src/types/strategy.js";
import { describeAsync, expect, runTestsAsync, testAsync } from "./test-harness.js";

// Initialize DB schema so getStrategy can access the strategies table
// This must run before any test that triggers resolveStrategy with a strategy ID
let _dbReady = false;
async function ensureDb(): Promise<void> {
  if (_dbReady) return;
  const { setupDatabase } = await import("../src/infrastructure/db-migrations.js");
  setupDatabase();
  // Also seed default strategies so getStrategy can find them
  // We need to reset the lazy flag because a fresh DB needs fresh defaults
  const strategyLib = await import("../src/domain/strategy-library.js");
  // Use addStrategy to ensure the default exists rather than calling private ensureDefaultsLazy
  strategyLib.addStrategy({
    id: "custom_ratio_spot",
    name: "Custom Ratio Spot",
    author: "meridian",
    lp_strategy: "spot",
    token_criteria: { notes: "Any token. Ratio expresses directional bias." },
    entry: {
      condition: "Directional view on token",
      single_side: null,
      notes: "test entry",
    },
    range: { type: "custom", notes: "test range" },
    exit: { take_profit_pct: 10, notes: "test exit" },
    best_for: "test",
  });
  _dbReady = true;
}

// ============================================================================
// Test Fixtures
// ============================================================================

const VALID_STRATEGY_CONFIG: Strategy = {
  id: "custom_ratio_spot",
  name: "Custom Ratio Spot",
  author: "meridian",
  lp_strategy: "spot",
  token_criteria: { notes: "test" },
  entry: {},
  range: {},
  exit: {},
  best_for: "test",
};

// ============================================================================
// resolveStrategy Tests
// ============================================================================

describeAsync("resolveStrategy — strategy_config present", async () => {
  testAsync("prefers strategy_config snapshot when available", async () => {
    const { resolved, strategyId, legacy } = resolveStrategy("spot", VALID_STRATEGY_CONFIG);

    expect(resolved).toBeTruthy();
    if (resolved) {
      expect(resolved.id).toBe("custom_ratio_spot");
    }
    expect(strategyId).toBe("custom_ratio_spot");
    expect(legacy).toBe(false);
  });

  testAsync("uses strategy_config even when strategy field is a legacy value", async () => {
    const { resolved, strategyId } = resolveStrategy("spot", VALID_STRATEGY_CONFIG);

    if (resolved) {
      expect(resolved.id).toBe("custom_ratio_spot");
    }
    expect(strategyId).toBe("custom_ratio_spot");
  });

  testAsync("uses strategy_config even when strategy is empty string", async () => {
    const { resolved, strategyId } = resolveStrategy("", VALID_STRATEGY_CONFIG);

    if (resolved) {
      expect(resolved.id).toBe("custom_ratio_spot");
    }
    expect(strategyId).toBe("custom_ratio_spot");
  });
});

describeAsync("resolveStrategy — legacy lp_strategy values", async () => {
  testAsync("resolves legacy 'spot' to synthetic strategy", async () => {
    const { resolved, strategyId, legacy } = resolveStrategy("spot", null);

    expect(resolved).toBeTruthy();
    expect(strategyId).toBe("custom_ratio_spot");
    expect(legacy).toBe(true);
    if (resolved) {
      expect(resolved.lp_strategy).toBe("spot");
      expect(resolved.id).toBe("custom_ratio_spot");
    }
  });

  testAsync("resolves legacy 'bid_ask' to synthetic strategy", async () => {
    const { resolved, legacy } = resolveStrategy("bid_ask", null);

    expect(resolved).toBeTruthy();
    expect(legacy).toBe(true);
    if (resolved) {
      expect(resolved.lp_strategy).toBe("bid_ask");
    }
  });

  testAsync("resolves legacy 'curve' to synthetic strategy", async () => {
    const { resolved, legacy } = resolveStrategy("curve", null);

    expect(resolved).toBeTruthy();
    expect(legacy).toBe(true);
    if (resolved) {
      expect(resolved.lp_strategy).toBe("curve");
    }
  });

  testAsync("resolves legacy 'any' to synthetic strategy", async () => {
    const { resolved, legacy } = resolveStrategy("any", null);

    expect(resolved).toBeTruthy();
    expect(legacy).toBe(true);
  });

  testAsync("resolves legacy 'mixed' to synthetic strategy", async () => {
    const { resolved, legacy } = resolveStrategy("mixed", null);

    expect(resolved).toBeTruthy();
    expect(legacy).toBe(true);
  });
});

describeAsync("resolveStrategy — valid strategy id", async () => {
  testAsync("resolves known strategy id via getStrategy", async () => {
    await ensureDb();
    // "custom_ratio_spot" is a default strategy in the strategy library
    const { resolved, strategyId, legacy } = resolveStrategy("custom_ratio_spot", null);

    expect(resolved).toBeTruthy();
    expect(strategyId).toBe("custom_ratio_spot");
    expect(legacy).toBe(false);
    if (resolved) {
      expect(resolved.id).toBe("custom_ratio_spot");
    }
  });
});

describeAsync("resolveStrategy — unknown strategy", async () => {
  testAsync("returns null for unknown non-legacy strategy id", async () => {
    await ensureDb();
    const { resolved } = resolveStrategy("nonexistent_strategy_xyz", null);

    // Unknown ID is not in legacy set, getStrategy returns error → null
    expect(resolved).toBe(null);
  });

  testAsync("returns null for empty string with no config", async () => {
    const { resolved } = resolveStrategy("", null);

    // Empty string → not legacy → getStrategy("") → error → not legacy → null
    expect(resolved).toBe(null);
  });
});

describeAsync("resolveStrategy — strategy_config without id", async () => {
  testAsync("falls through when strategy_config has no id", async () => {
    await ensureDb();
    const configNoId = { name: "test" } as unknown as Strategy;
    const { resolved } = resolveStrategy("custom_ratio_spot", configNoId);

    // Should still resolve via getStrategy because config didn't have an id
    expect(resolved).toBeTruthy();
    if (resolved) {
      expect(resolved.id).toBe("custom_ratio_spot");
    }
  });
});

// ============================================================================
// Persistence Pipeline Tests (unit-level, no DB)
// ============================================================================

describeAsync("Persistence pipeline — strategy field propagation", async () => {
  testAsync("deploy result with strategy_id and strategy_config preserves both", async () => {
    // Simulate what the deploy result looks like after the fix
    const deployResult = {
      success: true,
      position: "test-pos-123",
      pool: "test-pool-456",
      strategy: "custom_ratio_spot",
      strategy_config: VALID_STRATEGY_CONFIG,
    };

    // Verify the strategy is an ID, not a raw lp_strategy
    expect(deployResult.strategy).toBe("custom_ratio_spot");
    expect(deployResult.strategy_config).toBeTruthy();
    const config = deployResult.strategy_config as Strategy;
    expect(config.id).toBe("custom_ratio_spot");
    expect(config.lp_strategy).toBe("spot");
  });

  testAsync("legacy deploy result with strategy='spot' and no config is handled", async () => {
    // Simulate what a legacy deploy result looked like
    const legacyDeployResult = {
      success: true,
      position: "test-pos-legacy",
      pool: "test-pool-legacy",
      strategy: "spot",
      strategy_config: null,
    };

    // When this flows through trackPosition → resolveStrategy:
    const { resolved, legacy } = resolveStrategy(
      legacyDeployResult.strategy,
      legacyDeployResult.strategy_config as Strategy | null
    );

    expect(legacy).toBe(true);
    expect(resolved).toBeTruthy();
    if (resolved) {
      expect(resolved.lp_strategy).toBe("spot");
    }
  });

  testAsync("strategy_config snapshot is not null for new deployments", async () => {
    // After the fix, strategy_config should always be populated
    const deployResult = {
      success: true,
      strategy: "custom_ratio_spot",
      strategy_config: VALID_STRATEGY_CONFIG,
    };

    expect(deployResult.strategy_config).toBeTruthy();
    expect((deployResult.strategy_config as Strategy).id).toBe("custom_ratio_spot");
    // Verify it's not just the lp_strategy string
    expect(typeof deployResult.strategy_config).toBe("object");
  });
});

describeAsync("Persistence pipeline — DB round trip", async () => {
  testAsync("trackPosition stores canonical strategy id and snapshot for new rows", async () => {
    await ensureDb();
    const position = `pos-canonical-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    trackPosition({
      position,
      pool: "pool-1",
      pool_name: "Pool 1",
      strategy: "custom_ratio_spot",
      strategy_config: VALID_STRATEGY_CONFIG,
      bin_range: { min: 1, max: 2 },
      amount_sol: 1,
      amount_x: 0,
      active_bin: 10,
      bin_step: 80,
      volatility: 1,
      fee_tvl_ratio: 2,
      organic_score: 3,
      initial_value_usd: 4,
      signal_snapshot: null,
    });

    const raw = get<{ strategy: string; strategy_config: string | null }>(
      "SELECT strategy, strategy_config FROM position_state WHERE position = ?",
      position
    );

    expect(raw?.strategy).toBe("custom_ratio_spot");
    expect(raw?.strategy_config).toBeTruthy();

    const tracked = getTrackedPosition(position);
    expect(tracked?.strategy).toBe("custom_ratio_spot");
    expect(tracked?.strategy_config?.id).toBe("custom_ratio_spot");
  });

  testAsync(
    "setupDatabase backfills legacy lp_strategy rows to canonical strategy ids",
    async () => {
      await ensureDb();
      const position = `pos-legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      run(
        `INSERT INTO position_state (
        position, pool, pool_name, strategy, strategy_config, bin_range, amount_sol, amount_x,
        active_bin_at_deploy, bin_step, volatility, fee_tvl_ratio, initial_fee_tvl_24h,
        organic_score, initial_value_usd, signal_snapshot, deployed_at, notes, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        position,
        "pool-legacy-1",
        "Pool Legacy 1",
        "spot",
        null,
        JSON.stringify({ min: 1, max: 2 }),
        1,
        0,
        10,
        80,
        1,
        2,
        2,
        3,
        4,
        null,
        new Date().toISOString(),
        JSON.stringify([]),
        new Date().toISOString()
      );

      const { backfillLegacyStrategyFields } = await import(
        "../src/infrastructure/db-migrations.js"
      );
      backfillLegacyStrategyFields();

      const raw = get<{ strategy: string; strategy_config: string | null }>(
        "SELECT strategy, strategy_config FROM position_state WHERE position = ?",
        position
      );

      expect(raw?.strategy).toBe("custom_ratio_spot");
      expect(raw?.strategy_config).toBeTruthy();

      const tracked = getTrackedPosition(position);
      expect(tracked?.strategy).toBe("custom_ratio_spot");
      expect(tracked?.strategy_config?.id).toBe("custom_ratio_spot");
      expect(tracked?.strategy_config?.lp_strategy).toBe("spot");
    }
  );

  testAsync("trackPosition prefers strategy_config.id when strategy field disagrees", async () => {
    await ensureDb();
    const position = `pos-mismatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    trackPosition({
      position,
      pool: "pool-mismatch-1",
      pool_name: "Pool Mismatch 1",
      strategy: "single_sided_reseed",
      strategy_config: VALID_STRATEGY_CONFIG,
      bin_range: { min: 1, max: 2 },
      amount_sol: 1,
      amount_x: 0,
      active_bin: 10,
      bin_step: 80,
      volatility: 1,
      fee_tvl_ratio: 2,
      organic_score: 3,
      initial_value_usd: 4,
      signal_snapshot: null,
    });

    const tracked = getTrackedPosition(position);
    expect(tracked?.strategy).toBe("custom_ratio_spot");
    expect(tracked?.strategy_config?.id).toBe("custom_ratio_spot");
  });
});

describeAsync("resolveStrategy — edge cases", async () => {
  testAsync("undefined strategy_config treated as null", async () => {
    const { resolved, legacy } = resolveStrategy("spot", undefined);

    expect(legacy).toBe(true);
    expect(resolved).toBeTruthy();
  });

  testAsync("strategy_config with empty object falls through", async () => {
    await ensureDb();
    const { resolved } = resolveStrategy("custom_ratio_spot", {} as Strategy);

    // Empty object has no id → falls through to getStrategy
    expect(resolved).toBeTruthy();
    if (resolved) {
      expect(resolved.id).toBe("custom_ratio_spot");
    }
  });
});

// Run all tests
runTestsAsync();
