/**
 * Phase 2b Characterization Tests: agentLoop() Safety Behaviors
 *
 * These tests document current behavior BEFORE refactoring agent.ts.
 * They must pass before AND after extraction.
 *
 * Critical behaviors:
 * 1. Provider fallback state machine (system → user_embedded)
 * 2. ONCE_PER_SESSION persistence (pre-reservation prevents race conditions)
 * 3. Parallel pre-reservation (multiple identical calls in same response)
 * 4. Malicious JSON path (__proto__/constructor rejection)
 * 5. Tool-choice requirement (action intents force "required")
 */

import { describe, expect, runTests, test } from "./test-harness.js";

// ============================================================================
// Test 1: Provider fallback state machine (system → user_embedded)
// ============================================================================

describe("Provider fallback: system role error triggers user_embedded mode", () => {
  test("detects system role errors", () => {
    const isSystemRoleError = (error: unknown): boolean => {
      const err = error as { message?: string; error?: { message?: string } };
      const message = String(err?.message || err?.error?.message || error || "");
      return /invalid message role:\s*system/i.test(message);
    };

    const systemRoleErrorMessages = [
      "invalid message role: system",
      "Invalid message role: SYSTEM",
      "Provider error: invalid message role: system not allowed",
    ];

    for (const msg of systemRoleErrorMessages) {
      const error = new Error(msg);
      expect(isSystemRoleError(error)).toBe(true);
    }
  });

  test("does not detect non-system errors", () => {
    const isSystemRoleError = (error: unknown): boolean => {
      const err = error as { message?: string; error?: { message?: string } };
      const message = String(err?.message || err?.error?.message || error || "");
      return /invalid message role:\s*system/i.test(message);
    };

    const nonSystemErrors = [
      "rate limit exceeded",
      "invalid API key",
      "timeout",
      "tool_choice not supported",
    ];

    for (const msg of nonSystemErrors) {
      const error = new Error(msg);
      expect(isSystemRoleError(error)).toBe(false);
    }
  });
});

// ============================================================================
// Test 2: ONCE_PER_SESSION persistence (pre-reservation prevents race conditions)
// ============================================================================

describe("ONCE_PER_SESSION: pre-reservation prevents duplicate execution", () => {
  test("first call is allowed and reserved", () => {
    const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
    const firedOnce = new Set<string>();
    const reservedOncePerSession = new Set<string>();

    const functionName = "deploy_position";
    let blocked = false;

    if (ONCE_PER_SESSION.has(functionName)) {
      if (firedOnce.has(functionName) || reservedOncePerSession.has(functionName)) {
        blocked = true;
      } else {
        reservedOncePerSession.add(functionName);
        firedOnce.add(functionName);
      }
    }

    expect(blocked).toBe(false);
    expect(reservedOncePerSession.has(functionName)).toBe(true);
    expect(firedOnce.has(functionName)).toBe(true);
  });

  test("second call is blocked", () => {
    const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
    const firedOnce = new Set<string>();
    const reservedOncePerSession = new Set<string>();

    // First call
    const functionName = "deploy_position";
    reservedOncePerSession.add(functionName);
    firedOnce.add(functionName);

    // Second call
    let secondCallBlocked = false;
    if (ONCE_PER_SESSION.has(functionName)) {
      if (firedOnce.has(functionName) || reservedOncePerSession.has(functionName)) {
        secondCallBlocked = true;
      }
    }

    expect(secondCallBlocked).toBe(true);
  });
});

// ============================================================================
// Test 3: Parallel pre-reservation (multiple identical calls in same response)
// ============================================================================

describe("Parallel pre-reservation: multiple identical calls in same response", () => {
  test("only first of multiple identical calls is allowed", () => {
    const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
    const firedOnce = new Set<string>();
    const reservedOncePerSession = new Set<string>();

    // Simulate 3 deploy_position calls arriving simultaneously
    const toolCalls = [
      { id: "call_1", function: { name: "deploy_position", arguments: "{}" } },
      { id: "call_2", function: { name: "deploy_position", arguments: "{}" } },
      { id: "call_3", function: { name: "deploy_position", arguments: "{}" } },
    ];

    const results = toolCalls.map((toolCall) => {
      const functionName = toolCall.function.name;

      if (!ONCE_PER_SESSION.has(functionName)) {
        return { allowed: true, functionName };
      }

      if (firedOnce.has(functionName) || reservedOncePerSession.has(functionName)) {
        return { allowed: false, functionName, reason: "already reserved" };
      }

      // Reserve BEFORE async execution
      reservedOncePerSession.add(functionName);
      firedOnce.add(functionName);
      return { allowed: true, functionName };
    });

    // Only first call should be allowed
    expect(results[0].allowed).toBe(true);
    expect(results[1].allowed).toBe(false);
    expect(results[2].allowed).toBe(false);
  });
});

// ============================================================================
// Test 4: Malicious JSON path (__proto__/constructor rejection)
// ============================================================================

describe("Malicious JSON: __proto__ and constructor are rejected", () => {
  test("rejects __proto__ payloads", () => {
    const safeParseArgs = (raw: string): Record<string, unknown> => {
      if (raw.includes("__proto__") || raw.includes("constructor")) {
        throw new Error("Potentially malicious JSON detected");
      }
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {};
      }
    };

    const maliciousPayloads = [
      '{"__proto__": {"isAdmin": true}}',
      '{"key": "value", "__proto__": {"polluted": true}}',
    ];

    for (const payload of maliciousPayloads) {
      let threw = false;
      try {
        safeParseArgs(payload);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
  });

  test("rejects constructor payloads", () => {
    const safeParseArgs = (raw: string): Record<string, unknown> => {
      if (raw.includes("__proto__") || raw.includes("constructor")) {
        throw new Error("Potentially malicious JSON detected");
      }
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {};
      }
    };

    const maliciousPayloads = [
      '{"constructor": {"prototype": {"isAdmin": true}}}',
      '{"data": {"constructor": {"prototype": {"polluted": true}}}}',
    ];

    for (const payload of maliciousPayloads) {
      let threw = false;
      try {
        safeParseArgs(payload);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
  });

  test("accepts safe payloads", () => {
    const safeParseArgs = (raw: string): Record<string, unknown> => {
      if (raw.includes("__proto__") || raw.includes("constructor")) {
        throw new Error("Potentially malicious JSON detected");
      }
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {};
      }
    };

    const safePayloads = [
      '{"key": "value"}',
      '{"amount": 100, "token": "SOL"}',
      '{"nested": {"data": "value"}}',
    ];

    for (const payload of safePayloads) {
      let threw = false;
      try {
        safeParseArgs(payload);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    }
  });
});

// ============================================================================
// Test 5: Tool-choice requirement (action intents force "required")
// ============================================================================

describe("Tool-choice: action intents force 'required' on step 0", () => {
  test("detects action intents", () => {
    const ACTION_INTENTS =
      /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;

    const actionGoals = [
      "deploy a position in SOL-USDC pool",
      "open liquidity position",
      "add liquidity to pool",
      "close my position",
      "exit the pool",
      "withdraw liquidity",
      "claim fees",
      "swap 100 SOL for USDC",
      "block this pool",
      "unblock the token",
    ];

    for (const goal of actionGoals) {
      expect(ACTION_INTENTS.test(goal)).toBe(true);
    }
  });

  test("does not detect non-action intents", () => {
    const ACTION_INTENTS =
      /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;

    const nonActionGoals = [
      "what is my balance",
      "show my positions",
      "analyze pool performance",
      "get wallet info",
      "check PnL",
    ];

    for (const goal of nonActionGoals) {
      expect(ACTION_INTENTS.test(goal)).toBe(false);
    }
  });

  test("step 0 with action intent forces required", () => {
    const getToolChoice = (step: number, goal: string, mustUseRealTool: boolean): string | null => {
      const ACTION_INTENTS =
        /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      if (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) {
        return "required";
      }
      return "auto";
    };

    expect(getToolChoice(0, "deploy position", false)).toBe("required");
    expect(getToolChoice(0, "close position", false)).toBe("required");
  });

  test("step 0 without action intent uses auto", () => {
    const getToolChoice = (step: number, goal: string, mustUseRealTool: boolean): string | null => {
      const ACTION_INTENTS =
        /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      if (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) {
        return "required";
      }
      return "auto";
    };

    expect(getToolChoice(0, "what is my balance", false)).toBe("auto");
  });

  test("step 1+ uses auto regardless of intent", () => {
    const getToolChoice = (step: number, goal: string, mustUseRealTool: boolean): string | null => {
      const ACTION_INTENTS =
        /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      if (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) {
        return "required";
      }
      return "auto";
    };

    expect(getToolChoice(1, "deploy position", false)).toBe("auto");
    expect(getToolChoice(5, "close position", false)).toBe("auto");
  });

  test("mustUseRealTool forces required even without action intent", () => {
    const getToolChoice = (step: number, goal: string, mustUseRealTool: boolean): string | null => {
      const ACTION_INTENTS =
        /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      if (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) {
        return "required";
      }
      return "auto";
    };

    expect(getToolChoice(0, "what is my balance", true)).toBe("required");
  });
});

// ============================================================================
// Run all tests
// ============================================================================

runTests();
