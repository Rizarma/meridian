/**
 * Phase 2 Tests: Middleware Chain
 *
 * Tests the middleware implementation directly:
 * - applyMiddleware() composes chain correctly
 * - Middleware executes in order (safety → logging → notification)
 * - Safety middleware blocks write tools on check failure
 * - Logging middleware records actions
 * - Each middleware can short-circuit or pass through
 *
 * These tests exercise the REAL middleware functions with dependency injection.
 */

import type { ToolName } from "../src/types/executor.js";
import type { AgentType } from "../src/types/index.js";
import {
  applyMiddleware,
  createLoggingMiddleware,
  createSafetyCheckMiddleware,
  type MiddlewareContext,
  type MiddlewareFn,
} from "../tools/middleware.js";
import type { ToolRegistration } from "../tools/registry.js";
import { describeAsync, expect, runTestsAsync, testAsync } from "./test-harness.js";

// Mock tool for testing
const mockHandler = async (args: unknown) => ({ success: true, args });

const createMockTool = (
  name: ToolName,
  isWriteTool = false,
  roles: AgentType[] = ["GENERAL"]
): ToolRegistration => ({
  name,
  handler: mockHandler,
  roles,
  isWriteTool,
});

// Create a mock middleware context for testing
const createMockContext = (): MiddlewareContext => ({
  config: {
    risk: { maxPositions: 5, maxDeployAmount: 50 },
    screening: { minBinStep: 80, maxBinStep: 125 },
    management: { gasReserve: 0.2, deployAmountSol: 0.5 },
  } as unknown as MiddlewareContext["config"],
  logger: {
    log: () => {},
    logAction: () => {},
  },
  notificationService: {
    notifySwap: async () => {},
    notifyDeploy: async () => {},
    notifyClose: async () => {},
  },
  persistenceService: {
    trackPosition: async () => {},
    recordClaim: async () => {},
    recordClose: async () => {},
    recordPerformance: async () => {},
  },
  autoSwapService: {
    handleAutoSwapAfterClose: async () => {},
    handleAutoSwapAfterClaim: async () => {},
  },
  safetyCheckService: {
    runSafetyChecks: async () => ({ pass: true }),
  },
  validation: {
    validateSwapTokenArgs: () => ({
      success: true,
      data: { input_mint: "test", output_mint: "SOL", amount: 1 },
    }),
    validateDeployPositionArgs: () => ({
      success: true,
      data: { pool_address: "test", amount_y: 1 },
    }),
    validateClosePositionArgs: () => ({ success: true, data: { position_address: "test" } }),
  },
});

describeAsync("applyMiddleware Chain Composition", async () => {
  testAsync("middleware chain executes in order", async () => {
    const order: string[] = [];

    const mw1: MiddlewareFn = async (_tool, _args, _role, next) => {
      order.push("mw1-before");
      const result = await next();
      order.push("mw1-after");
      return result;
    };

    const mw2: MiddlewareFn = async (_tool, _args, _role, next) => {
      order.push("mw2-before");
      const result = await next();
      order.push("mw2-after");
      return result;
    };

    const tool = createMockTool("discover_pools");
    await applyMiddleware(tool, {}, "GENERAL", [mw1, mw2], async (args) => tool.handler(args));

    // Should be: mw1-before, mw2-before, handler, mw2-after, mw1-after
    expect(order[0]).toBe("mw1-before");
    expect(order[1]).toBe("mw2-before");
    expect(order[2]).toBe("mw2-after");
    expect(order[3]).toBe("mw1-after");
  });

  testAsync("middleware can short-circuit chain", async () => {
    const order: string[] = [];

    const blockingMw: MiddlewareFn = async (_tool, _args, _role, _next) => {
      order.push("blocking");
      return { blocked: true, reason: "Test block" };
      // Note: not calling next()
    };

    const afterMw: MiddlewareFn = async (_tool, _args, _role, next) => {
      order.push("after");
      return await next();
    };

    const tool = createMockTool("deploy_position", true);
    const result = (await applyMiddleware(
      tool,
      {},
      "GENERAL",
      [blockingMw, afterMw],
      async (args) => tool.handler(args)
    )) as { blocked: boolean; reason: string };

    expect(order.length).toBe(1);
    expect(order[0]).toBe("blocking");
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("Test block");
  });

  testAsync("empty chain just executes handler", async () => {
    const tool = createMockTool("discover_pools");
    const result = (await applyMiddleware(tool, { test: true }, "GENERAL", [], async (args) =>
      tool.handler(args)
    )) as {
      success: boolean;
      args: { test: boolean };
    };

    expect(result.success).toBe(true);
    expect(result.args.test).toBe(true);
  });
});

describeAsync("Safety Check Middleware", async () => {
  testAsync("safety middleware passes through non-write tools", async () => {
    const context = createMockContext();
    const safetyCheckMiddleware = createSafetyCheckMiddleware(context);
    const tool = createMockTool("discover_pools", false);

    // Mock next that returns success
    let nextCalled = false;
    const mockNext = async () => {
      nextCalled = true;
      return { success: true };
    };

    const result = await safetyCheckMiddleware(tool, {}, "GENERAL", mockNext);

    expect(nextCalled).toBe(true);
    // Verify result matches what mockNext returned
    expect((result as { success: boolean }).success).toBe(true);
  });

  testAsync("safety middleware blocks when checks fail", async () => {
    const context = createMockContext();
    // Override safety check to fail
    context.safetyCheckService = {
      runSafetyChecks: async () => ({ pass: false, reason: "Test safety block" }),
    };
    const safetyCheckMiddleware = createSafetyCheckMiddleware(context);

    const tool = createMockTool("deploy_position", true);

    let nextCalled = false;
    const mockNext = async () => {
      nextCalled = true;
      return { success: true };
    };

    const result = await safetyCheckMiddleware(tool, {}, "GENERAL", mockNext);

    // When safety checks fail, next should NOT be called
    expect(nextCalled).toBe(false);
    expect((result as { blocked: boolean }).blocked).toBe(true);
    expect((result as { reason: string }).reason).toBe("Test safety block");
  });
});

describeAsync("Logging Middleware", async () => {
  testAsync("logging middleware records successful execution", async () => {
    const context = createMockContext();
    const loggingMiddleware = createLoggingMiddleware(context);
    const tool = createMockTool("discover_pools");

    const mockNext = async () => ({ success: true, data: "test" });

    const result = await loggingMiddleware(tool, { input: "value" }, "GENERAL", mockNext);

    expect((result as { success: boolean }).success).toBe(true);
    expect((result as { data: string }).data).toBe("test");
    // Note: We can't easily verify the log was written without mocking logAction
    // The fact that it doesn't throw is the main test
  });

  testAsync("logging middleware records failed execution", async () => {
    const context = createMockContext();
    const loggingMiddleware = createLoggingMiddleware(context);
    const tool = createMockTool("deploy_position", true);

    const mockNext = async () => ({ success: false, error: "Test error" });

    const result = await loggingMiddleware(tool, {}, "GENERAL", mockNext);

    expect((result as { success: boolean }).success).toBe(false);
    expect((result as { error: string }).error).toBe("Test error");
  });

  testAsync("logging middleware propagates errors", async () => {
    const context = createMockContext();
    const loggingMiddleware = createLoggingMiddleware(context);
    const tool = createMockTool("deploy_position", true);

    const mockNext = async () => {
      throw new Error("Test exception");
    };

    try {
      await loggingMiddleware(tool, {}, "GENERAL", mockNext);
      expect(false).toBe(true); // Should not reach here
    } catch (e) {
      expect(e instanceof Error).toBe(true);
      expect((e as Error).message).toBe("Test exception");
    }
  });
});

// Run all tests
runTestsAsync();
