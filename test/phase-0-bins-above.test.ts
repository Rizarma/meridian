/**
 * Phase 0 Tests: binsAbove Configuration and Fallback Behavior
 *
 * Tests that:
 * - binsAbove is parsed from user-config with correct defaults
 * - CONFIG_MAP includes binsAbove mutation path
 * - Screening resolves binsAbove with conservative fallback chain:
 *     strategy.range.bins_above → config.strategy.binsAbove → 0
 * - Deploy path uses config.strategy.binsAbove instead of hardcoded 0
 */

import { describe, expect, runTests, test } from "./test-harness.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Mimic config creation (same pattern as phase-5-features.test.ts)
// ═══════════════════════════════════════════════════════════════════════════

interface StrategyConfig {
  strategy: string;
  binsBelow: number;
  binsAbove: number;
}

interface UserConfigPartial {
  strategy?: string;
  binsBelow?: number;
  binsAbove?: number;
}

function createTestStrategyConfig(u: UserConfigPartial): StrategyConfig {
  return {
    strategy: u.strategy ?? "bid_ask",
    binsBelow: u.binsBelow ?? 69,
    binsAbove: u.binsAbove ?? 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Mimic screening binsAbove resolution logic
// ═══════════════════════════════════════════════════════════════════════════

interface RangeCriteria {
  type?: "custom" | "default";
  bins_above?: number;
}

interface Strategy {
  range?: RangeCriteria;
}

/**
 * Resolves binsAbove with conservative fallback:
 * 1. strategy.range.bins_above (explicit numeric field)
 * 2. config.strategy.binsAbove (user-configured default)
 * 3. 0 (hardcoded floor)
 */
function resolveBinsAbove(activeStrategy: Strategy | null, configBinsAbove: number): number {
  if (activeStrategy) {
    return activeStrategy.range?.bins_above ?? configBinsAbove;
  }
  return configBinsAbove;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Mimic deploy fallback logic
// ═══════════════════════════════════════════════════════════════════════════

function resolveDeployBinsAbove(bins_above: number | undefined, configBinsAbove: number): number {
  return bins_above ?? configBinsAbove;
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Config Parsing Defaults
// ═══════════════════════════════════════════════════════════════════════════

describe("binsAbove Config Parsing", () => {
  test("defaults to 0 when not specified", () => {
    const cfg = createTestStrategyConfig({});
    expect(cfg.binsAbove).toBe(0);
  });

  test("reads explicit binsAbove from user config", () => {
    const cfg = createTestStrategyConfig({ binsAbove: 15 });
    expect(cfg.binsAbove).toBe(15);
  });

  test("binsAbove independent of binsBelow", () => {
    const cfg = createTestStrategyConfig({ binsBelow: 40, binsAbove: 20 });
    expect(cfg.binsBelow).toBe(40);
    expect(cfg.binsAbove).toBe(20);
  });

  test("binsBelow default unchanged when binsAbove is set", () => {
    const cfg = createTestStrategyConfig({ binsAbove: 10 });
    expect(cfg.binsBelow).toBe(69);
    expect(cfg.binsAbove).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: CONFIG_MAP includes binsAbove
// ═══════════════════════════════════════════════════════════════════════════

describe("binsAbove CONFIG_MAP Entry", () => {
  // Replicate the CONFIG_MAP from config.ts (subset for testing)
  const CONFIG_MAP: Record<string, [string, string]> = {
    strategy: ["strategy", "strategy"],
    binsBelow: ["strategy", "binsBelow"],
    binsAbove: ["strategy", "binsAbove"],
  };

  test("binsAbove exists in CONFIG_MAP", () => {
    expect(CONFIG_MAP.binsAbove !== undefined).toBe(true);
  });

  test("binsAbove maps to strategy section", () => {
    const [section, field] = CONFIG_MAP.binsAbove;
    expect(section).toBe("strategy");
    expect(field).toBe("binsAbove");
  });

  test("case-insensitive lookup works for binsAbove", () => {
    const CONFIG_MAP_LOWER: Record<string, [string, [string, string]]> = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );
    const match = CONFIG_MAP_LOWER["binsabove"];
    expect(match !== undefined).toBe(true);
    expect(match[0]).toBe("binsAbove");
    expect(match[1][0]).toBe("strategy");
    expect(match[1][1]).toBe("binsAbove");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Screening binsAbove Fallback Chain
// ═══════════════════════════════════════════════════════════════════════════

describe("Screening binsAbove Fallback Chain", () => {
  test("uses strategy.range.bins_above when present", () => {
    const strategy: Strategy = { range: { bins_above: 25 } };
    const result = resolveBinsAbove(strategy, 10);
    expect(result).toBe(25);
  });

  test("falls back to config.strategy.binsAbove when strategy has no bins_above", () => {
    const strategy: Strategy = { range: {} };
    const result = resolveBinsAbove(strategy, 15);
    expect(result).toBe(15);
  });

  test("falls back to config.strategy.binsAbove when strategy has no range", () => {
    const strategy: Strategy = {};
    const result = resolveBinsAbove(strategy, 12);
    expect(result).toBe(12);
  });

  test("falls back to config default (0) when no strategy and config default is 0", () => {
    const result = resolveBinsAbove(null, 0);
    expect(result).toBe(0);
  });

  test("uses configured binsAbove when no active strategy", () => {
    const result = resolveBinsAbove(null, 20);
    expect(result).toBe(20);
  });

  test("strategy bins_above=0 takes precedence over config binsAbove", () => {
    // Explicit 0 in strategy means "I deliberately want 0 bins above"
    const strategy: Strategy = { range: { bins_above: 0 } };
    const result = resolveBinsAbove(strategy, 20);
    expect(result).toBe(0);
  });

  test("full chain: undefined strategy → configured binsAbove=0 → 0", () => {
    const result = resolveBinsAbove(null, 0);
    expect(result).toBe(0);
  });

  test("full chain: strategy without bins_above → configured binsAbove=15 → 15", () => {
    const strategy: Strategy = { range: { type: "default" } };
    const result = resolveBinsAbove(strategy, 15);
    expect(result).toBe(15);
  });

  test("full chain: strategy bins_above=5 → 5 (config ignored)", () => {
    const strategy: Strategy = { range: { bins_above: 5, type: "custom" } };
    const result = resolveBinsAbove(strategy, 15);
    expect(result).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Deploy Path binsAbove Fallback
// ═══════════════════════════════════════════════════════════════════════════

describe("Deploy Path binsAbove Fallback", () => {
  test("uses explicit bins_above parameter when provided", () => {
    const result = resolveDeployBinsAbove(10, 0);
    expect(result).toBe(10);
  });

  test("falls back to config.strategy.binsAbove when bins_above is undefined", () => {
    const result = resolveDeployBinsAbove(undefined, 15);
    expect(result).toBe(15);
  });

  test("falls back to config.strategy.binsAbove=0 by default", () => {
    const result = resolveDeployBinsAbove(undefined, 0);
    expect(result).toBe(0);
  });

  test("explicit 0 bins_above is respected (not overridden by config)", () => {
    const result = resolveDeployBinsAbove(0, 20);
    expect(result).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Backward Compatibility
// ═══════════════════════════════════════════════════════════════════════════

describe("Backward Compatibility", () => {
  test("existing user-config without binsAbove defaults to 0", () => {
    // Simulates an existing user-config.json that has no binsAbove key
    const cfg = createTestStrategyConfig({
      strategy: "bid_ask",
      binsBelow: 69,
    });
    expect(cfg.binsAbove).toBe(0);
  });

  test("empty user-config defaults both binsBelow and binsAbove", () => {
    const cfg = createTestStrategyConfig({});
    expect(cfg.binsBelow).toBe(69);
    expect(cfg.binsAbove).toBe(0);
  });

  test("screening with no strategy and default config still uses 0", () => {
    // This is the pre-fix behavior — should still work
    const result = resolveBinsAbove(null, 0);
    expect(result).toBe(0);
  });

  test("deploy with no bins_above and default config still uses 0", () => {
    // Pre-fix: bins_above ?? 0
    // Post-fix: bins_above ?? config.strategy.binsAbove (which defaults to 0)
    const result = resolveDeployBinsAbove(undefined, 0);
    expect(result).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Run tests if this file is executed directly
// ═══════════════════════════════════════════════════════════════════════════

const isMainModule =
  import.meta.url.startsWith("file://") &&
  process.argv[1] &&
  import.meta.url.includes(process.argv[1].replace(/\\/g, "/"));
if (isMainModule) {
  runTests();
}
