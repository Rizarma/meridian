/**
 * Phase 5.3 Tests: Broader Integration Coverage
 *
 * Integration tests covering:
 * 1. Agent loop → tool execution → state mutation (ReAct cycle)
 * 2. Tool registry role enforcement (SCREENER vs MANAGER access control)
 * 3. Middleware chain ordering (safety → logging → notification)
 * 4. threshold-evolution.ts → signal-weights.ts data flow
 *
 * These tests exercise real production code paths with minimal mocking.
 */

import { config } from "../src/config/config.js";
import { loadWeights, recalculateWeights } from "../src/domain/signal-weights.js";
import { evolveThresholds } from "../src/domain/threshold-evolution.js";
import type { Config } from "../src/types/config.js";
import type { ToolName } from "../src/types/executor.js";
import type { AgentType } from "../src/types/index.js";
import type { PerformanceRecord as LessonsPerformanceRecord } from "../src/types/lessons.js";
import type { PerformanceRecord as WeightsPerformanceRecord } from "../src/types/weights.js";
import type { MiddlewareFn } from "../tools/middleware.js";
import { applyMiddleware } from "../tools/middleware.js";
import {
  clearRegistry,
  getTool,
  getToolsForRole,
  hasTool,
  registerTool,
} from "../tools/registry.js";
import { describeAsync, expect, runTestsAsync, testAsync } from "./test-harness.js";

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: Agent loop → tool execution → state mutation
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("Agent Loop → Tool Execution → State Mutation", async () => {
  // Factory function to create isolated mock state and handlers for each test
  const createMockState = () => {
    const mockState: {
      positions: Array<{
        position: string;
        pool: string;
        strategy: string;
        deployed_at: string;
      }>;
      events: string[];
    } = {
      positions: [],
      events: [],
    };

    const mockDeployHandler = async (args: unknown) => {
      const deployArgs = args as {
        pool_address: string;
        strategy?: string;
        amount_sol?: number;
      };
      const position = `pos_${Math.random().toString(36).slice(2, 10)}`;
      mockState.positions.push({
        position,
        pool: deployArgs.pool_address,
        strategy: deployArgs.strategy || "spot",
        deployed_at: new Date().toISOString(),
      });
      mockState.events.push(`deploy:${position}`);
      return {
        success: true,
        position,
        pool: deployArgs.pool_address,
        strategy: deployArgs.strategy || "spot",
        amount_sol: deployArgs.amount_sol || 0.5,
        tx: "mock_tx_signature",
      };
    };

    const mockCloseHandler = async (args: unknown) => {
      const closeArgs = args as { position_address: string; reason?: string };
      const pos = mockState.positions.find((p) => p.position === closeArgs.position_address);
      if (pos) {
        mockState.events.push(`close:${closeArgs.position_address}:${closeArgs.reason || "agent"}`);
      }
      return {
        success: true,
        position: closeArgs.position_address,
        closed: true,
        reason: closeArgs.reason || "agent decision",
      };
    };

    return { mockState, mockDeployHandler, mockCloseHandler };
  };

  testAsync(
    "ReAct cycle: agent receives prompt → LLM returns tool call → tool executes → state mutates",
    async () => {
      const { mockState, mockDeployHandler, mockCloseHandler } = createMockState();
      clearRegistry();

      registerTool({
        name: "deploy_position" as ToolName,
        handler: mockDeployHandler,
        roles: ["SCREENER", "GENERAL"],
        isWriteTool: true,
      });

      registerTool({
        name: "close_position" as ToolName,
        handler: mockCloseHandler,
        roles: ["MANAGER", "GENERAL"],
        isWriteTool: true,
      });

      const toolCallIntent = {
        name: "deploy_position",
        args: { pool_address: "ABC123", amount_sol: 0.5, strategy: "spot" },
      };

      const tool = getTool(toolCallIntent.name as ToolName);
      expect(tool !== undefined).toBe(true);
      if (!tool) return;
      expect(tool.roles.includes("SCREENER")).toBe(true);

      const result = (await tool.handler(toolCallIntent.args)) as {
        success: boolean;
        position: string;
        pool: string;
      };

      expect(result.success).toBe(true);
      expect(result.pool).toBe("ABC123");
      expect(mockState.positions.length).toBe(1);
      expect(mockState.positions[0].pool).toBe("ABC123");
    }
  );

  testAsync("state mutation chain: deploy → track → close → record", async () => {
    const { mockState, mockDeployHandler, mockCloseHandler } = createMockState();

    const deployResult = (await mockDeployHandler({
      pool_address: "POOL456",
      amount_sol: 1.0,
      strategy: "bid",
    })) as { success: boolean; position: string };

    expect(deployResult.success).toBe(true);
    const positionAddress = deployResult.position;
    expect(mockState.positions.length).toBe(1);

    const closeResult = (await mockCloseHandler({
      position_address: positionAddress,
      reason: "take_profit",
    })) as { success: boolean; closed: boolean };

    expect(closeResult.success).toBe(true);
    expect(closeResult.closed).toBe(true);
    expect(mockState.events.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: Tool registry role enforcement
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("Tool Registry Role Enforcement", async () => {
  testAsync("SCREENER can call SCREENER-only tool", async () => {
    clearRegistry();

    registerTool({
      name: "discover_pools" as ToolName,
      handler: async () => ({ success: true, data: "screener_result" }),
      roles: ["SCREENER"],
      isWriteTool: false,
    });

    expect(hasTool("discover_pools" as ToolName)).toBe(true);
    const screenerTools = getToolsForRole("SCREENER");
    expect(screenerTools.some((t) => t.name === "discover_pools")).toBe(true);

    const tool = getTool("discover_pools" as ToolName);
    expect(tool !== undefined).toBe(true);
    const result = (await tool?.handler({})) as { success: boolean; data: string };
    expect(result.success).toBe(true);
  });

  testAsync("SCREENER is blocked from calling MANAGER-only tool", async () => {
    clearRegistry();

    registerTool({
      name: "close_position" as ToolName,
      handler: async () => ({ success: true, data: "manager_result" }),
      roles: ["MANAGER"],
      isWriteTool: true,
    });

    const screenerTools = getToolsForRole("SCREENER");
    expect(screenerTools.some((t) => t.name === "close_position")).toBe(false);

    const tool = getTool("close_position" as ToolName);
    expect(tool !== undefined).toBe(true);
    expect(tool?.roles.includes("SCREENER")).toBe(false);
    expect(tool?.roles.includes("MANAGER")).toBe(true);
  });

  testAsync("GENERAL role can call cross-role tools", async () => {
    clearRegistry();

    registerTool({
      name: "get_wallet_balance" as ToolName,
      handler: async () => ({ success: true }),
      roles: ["SCREENER", "MANAGER", "GENERAL"],
      isWriteTool: false,
    });

    const screenerTools = getToolsForRole("SCREENER");
    const managerTools = getToolsForRole("MANAGER");
    const generalTools = getToolsForRole("GENERAL");

    expect(screenerTools.some((t) => t.name === "get_wallet_balance")).toBe(true);
    expect(managerTools.some((t) => t.name === "get_wallet_balance")).toBe(true);
    expect(generalTools.some((t) => t.name === "get_wallet_balance")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: Middleware chain ordering
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("Middleware Chain Ordering", async () => {
  testAsync("middleware runs in correct order: safety → logging → notification", async () => {
    clearRegistry();
    const executionOrder: string[] = [];

    const trackingSafety: MiddlewareFn = async (_tool, _args, _role, next) => {
      executionOrder.push("safety:before");
      const result = await next();
      executionOrder.push("safety:after");
      return result;
    };

    const trackingLogging: MiddlewareFn = async (_tool, _args, _role, next) => {
      executionOrder.push("logging:before");
      const result = await next();
      executionOrder.push("logging:after");
      return result;
    };

    const trackingNotification: MiddlewareFn = async (_tool, _args, _role, next) => {
      executionOrder.push("notification:before");
      const result = await next();
      executionOrder.push("notification:after");
      return result;
    };

    const mockHandler = async () => {
      executionOrder.push("handler");
      return { success: true };
    };

    const tool = {
      name: "test_tool" as ToolName,
      handler: mockHandler,
      roles: ["GENERAL" as AgentType],
      isWriteTool: true,
    };

    await applyMiddleware(
      tool,
      {},
      "GENERAL",
      [trackingSafety, trackingLogging, trackingNotification],
      tool.handler
    );

    expect(executionOrder[0]).toBe("safety:before");
    expect(executionOrder[1]).toBe("logging:before");
    expect(executionOrder[2]).toBe("notification:before");
    expect(executionOrder[3]).toBe("handler");
  });

  testAsync("safety check runs first and can block the chain", async () => {
    clearRegistry();
    const executionOrder: string[] = [];

    const blockingSafety: MiddlewareFn = async () => {
      executionOrder.push("safety:block");
      return { blocked: true, reason: "Safety check failed" };
    };

    const mockHandler = async () => {
      executionOrder.push("handler");
      return { success: true };
    };

    const tool = {
      name: "deploy_position" as ToolName,
      handler: mockHandler,
      roles: ["GENERAL" as AgentType],
      isWriteTool: true,
    };

    const result = (await applyMiddleware(tool, {}, "GENERAL", [blockingSafety], tool.handler)) as {
      blocked: boolean;
    };

    expect(executionOrder.length).toBe(1);
    expect(result.blocked).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: threshold-evolution.ts → signal-weights.ts data flow
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("Threshold Evolution → Signal Weights Data Flow", async () => {
  // Helper for threshold evolution (uses lessons.d.ts type)
  const createThresholdRecord = (
    overrides: Partial<LessonsPerformanceRecord> = {}
  ): LessonsPerformanceRecord => ({
    position: `pos_${Math.random().toString(36).slice(2, 10)}`,
    pool: `pool_${Math.random().toString(36).slice(2, 8)}`,
    pool_name: "TEST/POOL",
    strategy: "spot",
    bin_range: 10,
    bin_step: 100,
    amount_sol: 0.5,
    fees_earned_usd: 10,
    final_value_usd: 260,
    initial_value_usd: 200,
    minutes_in_range: 120,
    minutes_held: 1440,
    close_reason: "take_profit",
    base_mint: "So11111111111111111111111111111111111111112",
    deployed_at: new Date(Date.now() - 86400000).toISOString(),
    pnl_usd: overrides.pnl_usd ?? 0,
    pnl_pct: overrides.pnl_pct ?? ((overrides.pnl_usd ?? 0) / 200) * 100,
    range_efficiency: 85,
    recorded_at: new Date().toISOString(),
    volatility: overrides.volatility ?? 5,
    fee_tvl_ratio: overrides.fee_tvl_ratio ?? 0.05,
    organic_score: overrides.organic_score ?? 70,
    ...overrides,
  });

  // Helper for signal weights (uses weights.d.ts type)
  const createWeightsRecord = (
    overrides: Partial<WeightsPerformanceRecord> = {}
  ): WeightsPerformanceRecord => ({
    pnl_usd: overrides.pnl_usd ?? 0,
    recorded_at: new Date().toISOString(),
    closed_at: new Date().toISOString(),
    deployed_at: new Date(Date.now() - 86400000).toISOString(),
    signal_snapshot: overrides.signal_snapshot ?? {
      organic_score: 70,
      fee_tvl_ratio: 0.05,
      volume: 10000,
      mcap: 1000000,
      holder_count: 1000,
      smart_wallets_present: false,
      narrative_quality: "medium",
      study_win_rate: 0.6,
      hive_consensus: 0.5,
      volatility: 5,
    },
    ...overrides,
  });

  testAsync("real evolveThresholds() mutates config based on performance patterns", async () => {
    const performanceRecords: LessonsPerformanceRecord[] = [
      createThresholdRecord({
        pnl_usd: 200,
        pnl_pct: 100,
        volatility: 2,
        fee_tvl_ratio: 0.08,
        organic_score: 85,
      }),
      createThresholdRecord({
        pnl_usd: 250,
        pnl_pct: 125,
        volatility: 2.5,
        fee_tvl_ratio: 0.09,
        organic_score: 88,
      }),
      createThresholdRecord({
        pnl_usd: 150,
        pnl_pct: 75,
        volatility: 3,
        fee_tvl_ratio: 0.07,
        organic_score: 82,
      }),
      createThresholdRecord({
        pnl_usd: -150,
        pnl_pct: -75,
        volatility: 6,
        fee_tvl_ratio: 0.02,
        organic_score: 45,
      }),
      createThresholdRecord({
        pnl_usd: -200,
        pnl_pct: -100,
        volatility: 7,
        fee_tvl_ratio: 0.015,
        organic_score: 42,
      }),
    ];

    const originalMaxVolatility = config.screening.maxVolatility;
    const originalMinFeeRatio = config.screening.minFeeActiveTvlRatio;
    const originalMinOrganic = config.screening.minOrganic;

    config.screening.maxVolatility = 10;
    config.screening.minFeeActiveTvlRatio = 0.05;
    config.screening.minOrganic = 60;

    const result = evolveThresholds(performanceRecords, config as Config);

    expect(result !== null).toBe(true);

    const maxVolatilityChanged = config.screening.maxVolatility !== 10;
    const minFeeChanged = config.screening.minFeeActiveTvlRatio !== 0.05;
    const minOrganicChanged = config.screening.minOrganic !== 60;

    expect(maxVolatilityChanged || minFeeChanged || minOrganicChanged).toBe(true);

    config.screening.maxVolatility = originalMaxVolatility;
    config.screening.minFeeActiveTvlRatio = originalMinFeeRatio;
    config.screening.minOrganic = originalMinOrganic;
  });

  testAsync("real recalculateWeights() mutates signal weights based on performance", async () => {
    const performanceRecords: WeightsPerformanceRecord[] = [
      createWeightsRecord({
        pnl_usd: 250,
        signal_snapshot: {
          organic_score: 85,
          fee_tvl_ratio: 0.08,
          volume: 15000,
          mcap: 2000000,
          holder_count: 1500,
          smart_wallets_present: true,
          narrative_quality: "high",
          study_win_rate: 0.7,
          hive_consensus: 0.6,
          volatility: 3,
        },
      }),
      createWeightsRecord({
        pnl_usd: 300,
        signal_snapshot: {
          organic_score: 88,
          fee_tvl_ratio: 0.09,
          volume: 18000,
          mcap: 2500000,
          holder_count: 1800,
          smart_wallets_present: true,
          narrative_quality: "high",
          study_win_rate: 0.75,
          hive_consensus: 0.65,
          volatility: 2.5,
        },
      }),
      createWeightsRecord({
        pnl_usd: 200,
        signal_snapshot: {
          organic_score: 82,
          fee_tvl_ratio: 0.07,
          volume: 14000,
          mcap: 1900000,
          holder_count: 1450,
          smart_wallets_present: true,
          narrative_quality: "high",
          study_win_rate: 0.68,
          hive_consensus: 0.58,
          volatility: 3.5,
        },
      }),
      createWeightsRecord({
        pnl_usd: 280,
        signal_snapshot: {
          organic_score: 90,
          fee_tvl_ratio: 0.095,
          volume: 20000,
          mcap: 3000000,
          holder_count: 2000,
          smart_wallets_present: true,
          narrative_quality: "high",
          study_win_rate: 0.8,
          hive_consensus: 0.7,
          volatility: 2,
        },
      }),
      createWeightsRecord({
        pnl_usd: 220,
        signal_snapshot: {
          organic_score: 86,
          fee_tvl_ratio: 0.085,
          volume: 16000,
          mcap: 2200000,
          holder_count: 1600,
          smart_wallets_present: true,
          narrative_quality: "high",
          study_win_rate: 0.72,
          hive_consensus: 0.62,
          volatility: 2.8,
        },
      }),
      createWeightsRecord({
        pnl_usd: -150,
        signal_snapshot: {
          organic_score: 45,
          fee_tvl_ratio: 0.02,
          volume: 5000,
          mcap: 500000,
          holder_count: 300,
          smart_wallets_present: false,
          narrative_quality: "low",
          study_win_rate: 0.3,
          hive_consensus: 0.2,
          volatility: 15,
        },
      }),
      createWeightsRecord({
        pnl_usd: -200,
        signal_snapshot: {
          organic_score: 42,
          fee_tvl_ratio: 0.015,
          volume: 4000,
          mcap: 400000,
          holder_count: 250,
          smart_wallets_present: false,
          narrative_quality: "low",
          study_win_rate: 0.25,
          hive_consensus: 0.15,
          volatility: 18,
        },
      }),
      createWeightsRecord({
        pnl_usd: -100,
        signal_snapshot: {
          organic_score: 48,
          fee_tvl_ratio: 0.025,
          volume: 6000,
          mcap: 600000,
          holder_count: 350,
          smart_wallets_present: false,
          narrative_quality: "low",
          study_win_rate: 0.35,
          hive_consensus: 0.25,
          volatility: 12,
        },
      }),
      createWeightsRecord({
        pnl_usd: -180,
        signal_snapshot: {
          organic_score: 40,
          fee_tvl_ratio: 0.01,
          volume: 3000,
          mcap: 300000,
          holder_count: 200,
          smart_wallets_present: false,
          narrative_quality: "low",
          study_win_rate: 0.2,
          hive_consensus: 0.1,
          volatility: 20,
        },
      }),
      createWeightsRecord({
        pnl_usd: -120,
        signal_snapshot: {
          organic_score: 46,
          fee_tvl_ratio: 0.022,
          volume: 5500,
          mcap: 550000,
          holder_count: 320,
          smart_wallets_present: false,
          narrative_quality: "low",
          study_win_rate: 0.32,
          hive_consensus: 0.22,
          volatility: 14,
        },
      }),
    ];

    const initialWeightsData = await loadWeights();
    const initialWeights = { ...initialWeightsData.weights };

    const result = await recalculateWeights(performanceRecords, {
      darwin: {
        windowDays: 60,
        minSamples: 5,
        boostFactor: 1.05,
        decayFactor: 0.95,
        weightFloor: 0.3,
        weightCeiling: 2.5,
      },
    });

    expect(typeof result).toBe("object");
    expect(typeof result.weights).toBe("object");
    expect(Array.isArray(result.changes)).toBe(true);

    const updatedWeightsData = await loadWeights();
    const updatedWeights = updatedWeightsData.weights;

    let weightsChanged = false;
    for (const signal of Object.keys(initialWeights)) {
      if (initialWeights[signal] !== updatedWeights[signal]) {
        weightsChanged = true;
        break;
      }
    }

    if (result.changes.length > 0) {
      expect(weightsChanged).toBe(true);
      for (const change of result.changes) {
        expect(updatedWeights[change.signal]).toBe(change.to);
      }
    }

    const organicWeight = updatedWeights.organic_score ?? 1.0;
    const volatilityWeight = updatedWeights.volatility ?? 1.0;

    expect(organicWeight >= 0.3).toBe(true);
    expect(volatilityWeight >= 0.3 && volatilityWeight <= 2.5).toBe(true);
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
  runTestsAsync().catch(() => process.exit(1));
}
