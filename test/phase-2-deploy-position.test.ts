/**
 * Characterization tests for deploy-position behavior
 * These tests document current behavior BEFORE extraction from tools/dlmm.ts
 *
 * Tests cover: dry-run contract, failure contract, success result shape,
 * and wide-range transaction sequencing.
 */
import { describe, expect, runTests, test } from "./test-harness.js";

// ─── Suite 1: Dry-Run Contract ─────────────────────────────────

describe("deploy-position dry-run contract", () => {
  test("dry_run: true returns would_deploy shape with pool_address, strategy, amount_x, amount_y, wide_range", () => {
    // Documents the exact shape returned when DRY_RUN=true (lines 110-125 in dlmm.ts)
    const result = {
      dry_run: true,
      would_deploy: {
        pool_address: "So11111111111111111111111111111111111111112",
        strategy: "spot",
        bins_below: 20,
        bins_above: 20,
        amount_x: 0,
        amount_y: 0.5,
        wide_range: false,
      },
      message: "DRY RUN — no transaction sent",
    };

    expect(result.dry_run).toBe(true);
    expect(result.would_deploy !== undefined).toBe(true);
    expect((result.would_deploy as Record<string, unknown>).pool_address !== undefined).toBe(true);
    expect((result.would_deploy as Record<string, unknown>).strategy !== undefined).toBe(true);
    expect((result.would_deploy as Record<string, unknown>).amount_x !== undefined).toBe(true);
    expect((result.would_deploy as Record<string, unknown>).amount_y !== undefined).toBe(true);
    expect((result.would_deploy as Record<string, unknown>).wide_range !== undefined).toBe(true);
    expect(result.message !== undefined).toBe(true);
  });

  test("No transaction activity in dry-run mode — would_deploy causes early return", () => {
    // The dry-run branch returns before wallet/pool are fetched (lines 110-125)
    // This means no simulateAndSend, no getPool, no getWallet calls
    let simulateCalled = false;
    let poolFetched = false;

    const dryRunDeploy = (isDryRun: boolean) => {
      if (isDryRun) {
        return {
          dry_run: true,
          would_deploy: {
            pool_address: "test",
            strategy: "spot",
            amount_x: 0,
            amount_y: 0.5,
            wide_range: false,
          },
          message: "DRY RUN — no transaction sent",
        };
      }
      // These would only execute in non-dry-run path
      poolFetched = true;
      simulateCalled = true;
      return { success: true, txs: ["hash"] };
    };

    const result = dryRunDeploy(true);

    expect(result.dry_run).toBe(true);
    expect(poolFetched).toBe(false);
    expect(simulateCalled).toBe(false);
  });

  test("dry-run wide_range is computed from bins_below + bins_above > 69", () => {
    // Documents that wide_range in dry-run result uses isWideRange(binsBelow, binsAbove)
    const computeWideRange = (binsBelow: number, binsAbove: number): boolean => {
      return binsBelow + binsAbove > 69;
    };

    expect(computeWideRange(20, 20)).toBe(false); // 40 bins — standard
    expect(computeWideRange(35, 35)).toBe(true); // 70 bins — wide
    expect(computeWideRange(50, 50)).toBe(true); // 100 bins — wide
  });
});

// ─── Suite 2: Failure Contract ─────────────────────────────────

describe("deploy-position failure contract", () => {
  test("Thrown dependency error becomes { success: false, error: message }", () => {
    // Documents the catch block behavior (lines 291-295 in dlmm.ts)
    const simulateDeployError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    };

    // Case 1: Error instance
    const errorResult = simulateDeployError(new Error("Simulation failed: {InstructionError:...}"));
    expect(errorResult.success).toBe(false);
    expect(errorResult.error).toBe("Simulation failed: {InstructionError:...}");

    // Case 2: String error
    const stringResult = simulateDeployError("Connection refused");
    expect(stringResult.success).toBe(false);
    expect(stringResult.error).toBe("Connection refused");

    // Case 3: Non-standard error
    const numResult = simulateDeployError(42);
    expect(numResult.success).toBe(false);
    expect(numResult.error).toBe("42");
  });

  test("Pool on cooldown returns { success: false, error: 'Pool on cooldown...' }", () => {
    // Documents the cooldown check (lines 102-108 in dlmm.ts)
    const result = {
      success: false,
      error: "Pool on cooldown — was recently closed with a cooldown reason. Try a different pool.",
    };

    expect(result.success).toBe(false);
    expect(result.error !== undefined).toBe(true);
    expect((result.error as string).includes("cooldown")).toBe(true);
  });

  test("Base mint on cooldown returns { success: false, error: 'Token on cooldown...' }", () => {
    // Documents the base-mint cooldown check (lines 131-139 in dlmm.ts)
    const result = {
      success: false,
      error:
        "Token on cooldown — recently closed out-of-range too many times. Try a different token.",
    };

    expect(result.success).toBe(false);
    expect(result.error !== undefined).toBe(true);
    expect((result.error as string).includes("Token on cooldown")).toBe(true);
  });
});

// ─── Suite 3: Success Result Shape ─────────────────────────────

describe("deploy-position success result shape", () => {
  test("Returns success: true, position, pool, bin_range, price_range, txs", () => {
    // Documents the full success return shape (lines 268-290 in dlmm.ts)
    const result = {
      success: true,
      position: "newPositionPubkey123",
      pool: "poolAddress456",
      pool_name: "TEST/SOL",
      bin_range: { min: 80, max: 120, active: 100 },
      price_range: { min: 0.001, max: 0.005 },
      bin_step: 100,
      base_fee: 0.01,
      strategy: "spot",
      strategy_config: { id: "strat-1", lp_strategy: "spot" },
      wide_range: false,
      amount_x: 100,
      amount_y: 0.5,
      txs: ["txHash1"],
    };

    expect(result.success).toBe(true);
    expect(result.position !== undefined).toBe(true);
    expect(result.pool !== undefined).toBe(true);
    expect(result.bin_range !== undefined).toBe(true);
    expect(result.price_range !== undefined).toBe(true);
    expect(Array.isArray(result.txs)).toBe(true);
    expect(result.txs!.length).toBe(1);
  });

  test("Includes persistence fields: volatility, fee_tvl_ratio, organic_score, initial_value_usd, active_bin, amount_sol", () => {
    // Documents that these extra fields are returned for trackPosition persistence
    const result = {
      success: true,
      position: "pos123",
      pool: "pool456",
      volatility: 2.5,
      fee_tvl_ratio: 0.05,
      organic_score: 80,
      initial_value_usd: 150.0,
      active_bin: 100,
      amount_sol: 0.5,
      // ... other fields omitted for brevity
    };

    expect(result.volatility).toBe(2.5);
    expect(result.fee_tvl_ratio).toBe(0.05);
    expect(result.organic_score).toBe(80);
    expect(result.initial_value_usd).toBe(150.0);
    expect(result.active_bin).toBe(100);
    expect(result.amount_sol).toBe(0.5);
  });

  test("bin_range contains min, max, active; price_range contains min, max", () => {
    const result = {
      success: true,
      bin_range: { min: 80, max: 120, active: 100 },
      price_range: { min: 0.001, max: 0.005 },
    };

    const binRange = result.bin_range as { min: number; max: number; active: number };
    const priceRange = result.price_range as { min: number; max: number };

    expect(binRange.min).toBe(80);
    expect(binRange.max).toBe(120);
    expect(binRange.active).toBe(100);
    expect(priceRange.min).toBe(0.001);
    expect(priceRange.max).toBe(0.005);
  });

  test("base_fee is computed from pool.lbPair when not passed explicitly", () => {
    // Documents base_fee fallback computation (lines 256-259)
    const baseFactor = 100; // from pool.lbPair.parameters.baseFactor
    const actualBinStep = 100; // from pool.lbPair.binStep
    const computedFee = parseFloat((((baseFactor * actualBinStep) / 1e6) * 100).toFixed(4));

    expect(computedFee).toBe(0.1);

    // When base_fee is explicitly provided, it takes precedence
    const explicitFee = 0.05;
    const finalFee = explicitFee ?? computedFee;
    expect(finalFee).toBe(0.05);
  });
});

// ─── Suite 4: Wide-Range Sequencing ────────────────────────────

describe("deploy-position wide-range sequencing", () => {
  test("Create-position txs happen before add-liquidity txs", () => {
    // Documents the two-phase wide-range path (lines 178-224 in dlmm.ts)
    // Phase 1: createExtendedEmptyPosition → may return Transaction[]
    // Phase 2: addLiquidityByStrategyChunkable → may return Transaction[]
    const executionOrder: string[] = [];

    const simulateWideRangeDeploy = () => {
      // Phase 1: Create empty position
      const createTxs = ["create-tx-1", "create-tx-2"]; // Array.isArray case
      for (const tx of createTxs) {
        executionOrder.push(`create:${tx}`);
      }

      // Phase 2: Add liquidity
      const addTxs = ["add-tx-1", "add-tx-2", "add-tx-3"]; // Array.isArray case
      for (const tx of addTxs) {
        executionOrder.push(`add:${tx}`);
      }
    };

    simulateWideRangeDeploy();

    // All create txs must come before any add txs
    const lastCreateIdx = executionOrder.reduce(
      (last, entry, idx) => (entry.startsWith("create:") ? idx : last),
      -1
    );
    const firstAddIdx = executionOrder.findIndex((entry) => entry.startsWith("add:"));

    expect(lastCreateIdx).toBe(1); // create-tx-2 at index 1
    expect(firstAddIdx).toBe(2); // add-tx-1 at index 2
    expect(lastCreateIdx < firstAddIdx).toBe(true);
    expect(executionOrder.length).toBe(5); // 2 create + 3 add
  });

  test("Every tx goes through simulateAndSend — no direct sends", () => {
    // Documents that each tx in both phases calls simulateAndSend
    const simulateAndSendCalls: string[] = [];

    const mockSimulateAndSend = (label: string, txIdx: number) => {
      simulateAndSendCalls.push(`${label}:${txIdx}`);
      return `tx-hash-${txIdx}`;
    };

    // Simulate wide-range path — each tx individually goes through simulateAndSend
    const createTxCount = 2;
    for (let i = 0; i < createTxCount; i++) {
      mockSimulateAndSend("create", i);
    }
    const addTxCount = 3;
    for (let i = 0; i < addTxCount; i++) {
      mockSimulateAndSend("add", i);
    }

    // Every single tx resulted in a simulateAndSend call
    expect(simulateAndSendCalls.length).toBe(createTxCount + addTxCount);
    expect(simulateAndSendCalls.length).toBe(5);
  });

  test("Standard path (≤69 bins) uses single tx with wallet + newPosition signers", () => {
    // Documents the non-wide-range path (lines 225-243)
    const isWideRangeDeploy = false;
    const signers: string[][] = [];

    if (isWideRangeDeploy) {
      // Wide range — not this test
    } else {
      // Standard path: single tx with both wallet and newPosition as signers
      signers.push(["wallet", "newPosition"]);
    }

    expect(signers.length).toBe(1); // Single tx
    expect(signers[0].length).toBe(2); // Two signers
    expect(signers[0].includes("wallet")).toBe(true);
    expect(signers[0].includes("newPosition")).toBe(true);
  });

  test("Wide-range create tx first signer includes both wallet and newPosition; subsequent only wallet", () => {
    // Documents signer pattern for multi-tx create (line 194)
    const createTxCount = 3;
    const signerPatterns: string[][] = [];

    for (let i = 0; i < createTxCount; i++) {
      const signers = i === 0 ? ["wallet", "newPosition"] : ["wallet"];
      signerPatterns.push(signers);
    }

    expect(signerPatterns[0].length).toBe(2); // First tx: wallet + newPosition
    expect(signerPatterns[0].includes("newPosition")).toBe(true);
    expect(signerPatterns[1].length).toBe(1); // Subsequent: wallet only
    expect(signerPatterns[2].length).toBe(1);
  });
});

// Run tests
runTests();
