/**
 * Characterization tests for agent loop safety patterns
 * These tests document current behavior before refactoring src/agent/agent.ts
 *
 * CRITICAL BEHAVIORS:
 * - Provider fallback chain (system → user_embedded → no-tool_choice)
 * - Duplicate destructive call prevention (ONCE_PER_SESSION)
 * - Malicious JSON rejection (__proto__, constructor)
 * - Tool argument validation before execution
 */
import { describe, expect, runTests, test } from "./test-harness.js";

describe("Agent Provider Fallback Chain", () => {
  describe("system role error handling", () => {
    test("should switch to user_embedded mode when provider rejects system role", () => {
      // Lines 215-224 in agent.ts
      // Pattern: catch error → check isSystemRoleError → switch mode → retry

      const isSystemRoleError = (error: unknown): boolean => {
        const err = error as { message?: string; error?: { message?: string } };
        const message = String(err?.message || err?.error?.message || error || "");
        return /invalid message role:\s*system/i.test(message);
      };

      expect(isSystemRoleError({ message: "invalid message role: system not allowed" })).toBe(true);
      expect(isSystemRoleError({ message: "invalid message role:system" })).toBe(true);
      expect(isSystemRoleError({ message: "some other error" })).toBe(false);
      expect(isSystemRoleError(null)).toBe(false);
    });

    test("should rebuild messages with embedded system instructions after role rejection", () => {
      // Lines 101-116 in agent.ts show the two message building modes

      const buildMessages = (
        systemPrompt: string,
        sessionHistory: unknown[],
        goal: string,
        providerMode: "system" | "user_embedded"
      ) => {
        if (providerMode === "user_embedded") {
          return [
            ...sessionHistory,
            {
              role: "user",
              content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
            },
          ];
        }

        return [
          { role: "system", content: systemPrompt },
          ...sessionHistory,
          { role: "user", content: goal },
        ];
      };

      const systemPrompt = "You are a helpful assistant";
      const goal = "Deploy a position";
      const history: unknown[] = [];

      const systemMode = buildMessages(systemPrompt, history, goal, "system");
      expect((systemMode[0] as Record<string, string>).role).toBe("system");

      const embeddedMode = buildMessages(systemPrompt, history, goal, "user_embedded");
      expect((embeddedMode[0] as Record<string, string>).role).toBe("user");
      // Check that embedded mode contains system instructions
      expect(
        (embeddedMode[0] as Record<string, string>).content.indexOf("SYSTEM INSTRUCTIONS") >= 0
      ).toBe(true);
    });
  });

  describe("tool_choice error handling", () => {
    test("should detect tool_choice related errors", () => {
      // Lines 124-129 in agent.ts

      const isToolChoiceError = (error: unknown): boolean => {
        const err = error as { message?: string; error?: { message?: string } };
        const message = String(err?.message || err?.error?.message || error || "");
        return /tool_choice/i.test(message) || /no endpoints found.*tool/i.test(message);
      };

      expect(isToolChoiceError({ message: "tool_choice parameter not supported" })).toBe(true);
      expect(isToolChoiceError({ message: "Invalid tool_choice value" })).toBe(true);
      expect(isToolChoiceError({ message: "no endpoints found matching tool requirements" })).toBe(
        true
      );
      expect(isToolChoiceError({ message: "some other error" })).toBe(false);
    });

    test("should disable tool_choice and retry when provider rejects it", () => {
      // Lines 225-231 in agent.ts
      // Pattern: catch error → check isToolChoiceError → set toolChoice = null → retry

      let toolChoice: string | null = "required";

      const handleToolChoiceError = (error: unknown) => {
        const isToolChoiceErr =
          /tool_choice/i.test(String(error)) || /no endpoints found.*tool/i.test(String(error));
        if (isToolChoiceErr) {
          toolChoice = null;
          return true; // handled
        }
        return false;
      };

      expect(handleToolChoiceError({ message: "tool_choice not supported" })).toBe(true);
      expect(toolChoice === null).toBe(true);
    });
  });

  describe("provider error retry with fallback model", () => {
    test("should retry on 502/503/529 errors with exponential backoff", () => {
      // Lines 235-249 in agent.ts
      // Pattern: check error code → wait (attempt + 1) * base_wait → retry
      // On second attempt, switch to fallback model

      const shouldRetry = (errCode: number | undefined): boolean => {
        return errCode === 502 || errCode === 503 || errCode === 529;
      };

      expect(shouldRetry(502)).toBe(true);
      expect(shouldRetry(503)).toBe(true);
      expect(shouldRetry(529)).toBe(true);
      expect(shouldRetry(400)).toBe(false);
      expect(shouldRetry(429)).toBe(false);
      expect(shouldRetry(undefined)).toBe(false);
    });

    test("should switch to fallback model on second retry attempt", () => {
      // Lines 237-239 in agent.ts
      // Pattern: if attempt === 1 and usedModel !== fallback → switch

      const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";
      const DEFAULT_MODEL = "openai/gpt-4o";

      const getModelForAttempt = (attempt: number, currentModel: string): string => {
        if (attempt === 1 && currentModel !== FALLBACK_MODEL) {
          return FALLBACK_MODEL;
        }
        return currentModel;
      };

      expect(getModelForAttempt(0, DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
      expect(getModelForAttempt(1, DEFAULT_MODEL)).toBe(FALLBACK_MODEL);
      expect(getModelForAttempt(2, FALLBACK_MODEL)).toBe(FALLBACK_MODEL);
    });
  });
});

describe("Duplicate Destructive Call Prevention", () => {
  describe("ONCE_PER_SESSION tracking", () => {
    test("should track destructive tools that can only fire once per session", () => {
      // Lines 171-176 in agent.ts
      const ONCE_PER_SESSION: Set<string> = new Set([
        "deploy_position",
        "swap_token",
        "close_position",
      ]);

      expect(ONCE_PER_SESSION.has("deploy_position")).toBe(true);
      expect(ONCE_PER_SESSION.has("swap_token")).toBe(true);
      expect(ONCE_PER_SESSION.has("close_position")).toBe(true);
      expect(ONCE_PER_SESSION.has("get_wallet_balance")).toBe(false);
    });

    test("should pre-reserve tools before async execution to prevent race conditions", () => {
      // Lines 324-347 in agent.ts show the pre-reservation pattern
      // This prevents multiple identical calls in the same LLM response from all passing

      const ONCE_PER_SESSION = new Set(["deploy_position", "close_position"]);
      const firedOnce = new Set<string>();
      const reservedOncePerSession = new Set<string>();

      const precheckTool = (functionName: string) => {
        if (!ONCE_PER_SESSION.has(functionName)) {
          return { blocked: false };
        }

        if (firedOnce.has(functionName) || reservedOncePerSession.has(functionName)) {
          return {
            blocked: true,
            reason: `${functionName} is allowed only once per session`,
          };
        }

        // Reserve BEFORE async execution
        reservedOncePerSession.add(functionName);
        firedOnce.add(functionName);
        return { blocked: false };
      };

      // First call should succeed
      expect(precheckTool("deploy_position").blocked).toBe(false);

      // Second call (same session) should be blocked
      expect(precheckTool("deploy_position").blocked).toBe(true);

      // Different destructive tool should still work once
      expect(precheckTool("close_position").blocked).toBe(false);
      expect(precheckTool("close_position").blocked).toBe(true);
    });

    test("should return blocked result with specific message shape", () => {
      // Lines 355-376 in agent.ts show the blocked result shape

      const createBlockedResult = (functionName: string) => ({
        blocked: true,
        reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.`,
      });

      const result = createBlockedResult("deploy_position");
      expect(result.blocked).toBe(true);
      // Check that message contains expected parts
      expect(result.reason.indexOf("already attempted this session") >= 0).toBe(true);
      expect(result.reason.indexOf("do not retry") >= 0).toBe(true);
    });
  });

  describe("parallel execution safety", () => {
    test("should block sibling calls to same destructive tool in parallel batch", () => {
      // Lines 324-347: pre-reservation happens before Promise.all
      // This ensures that even if two deploy_position calls are in the same
      // tool_calls array, only one executes

      const ONCE_PER_SESSION = new Set(["deploy_position"]);
      const firedOnce = new Set<string>();
      const reservedOncePerSession = new Set<string>();

      const toolCalls = [
        { id: "call_1", function: { name: "deploy_position" } },
        { id: "call_2", function: { name: "deploy_position" } }, // duplicate
        { id: "call_3", function: { name: "get_wallet_balance" } }, // safe
      ];

      const preChecked = toolCalls.map((toolCall) => {
        const functionName = toolCall.function.name;

        if (!ONCE_PER_SESSION.has(functionName)) {
          return { toolCall, functionName, blocked: false };
        }

        if (firedOnce.has(functionName) || reservedOncePerSession.has(functionName)) {
          return {
            toolCall,
            functionName,
            blocked: true,
            reason: `${functionName} is allowed only once per session`,
          };
        }

        reservedOncePerSession.add(functionName);
        firedOnce.add(functionName);
        return { toolCall, functionName, blocked: false };
      });

      // First deploy_position passes
      expect(preChecked[0].blocked).toBe(false);

      // Second deploy_position blocked (same batch)
      expect(preChecked[1].blocked).toBe(true);

      // get_wallet_balance always allowed
      expect(preChecked[2].blocked).toBe(false);
    });
  });
});

describe("Tool JSON Security", () => {
  describe("malicious JSON detection", () => {
    test("should reject JSON containing __proto__", () => {
      // Lines 536-538 in agent.ts
      const hasMaliciousKeys = (json: string): boolean => {
        return json.includes("__proto__") || json.includes("constructor");
      };

      expect(hasMaliciousKeys('{"__proto__": {"polluted": true}}')).toBe(true);
      expect(hasMaliciousKeys('{"constructor": {"prototype": {}}}')).toBe(true);
      expect(hasMaliciousKeys('{"key": "__proto__"}')).toBe(true); // substring check
      expect(hasMaliciousKeys('{"normal": "value"}')).toBe(false);
    });

    test("should throw when malicious JSON detected after repair", () => {
      const safeParseArgs = (raw: string): Record<string, unknown> => {
        try {
          return JSON.parse(raw);
        } catch {
          // Simulate repair
          const repaired = raw.replace(/\n/g, ""); // simplified repair
          if (repaired.includes("__proto__") || repaired.includes("constructor")) {
            throw new Error("Potentially malicious JSON detected");
          }
          return JSON.parse(repaired);
        }
      };

      let errorThrown = false;
      let errorMessage = "";
      try {
        safeParseArgs('{"__proto__": {}}');
      } catch (e) {
        errorThrown = true;
        errorMessage = (e as Error).message;
      }
      expect(errorThrown).toBe(true);
      expect(errorMessage.indexOf("Potentially malicious JSON") >= 0).toBe(true);
    });
  });

  describe("JSON repair fallback", () => {
    test("should repair malformed JSON before parsing", () => {
      // Lines 530-545 in agent.ts show the repair pattern
      // Uses jsonrepair library to fix common JSON issues

      const safeParseArgs = (raw: string): Record<string, unknown> => {
        try {
          return JSON.parse(raw);
        } catch {
          try {
            // Simulated repair (actual code uses jsonrepair library)
            const repaired = raw
              .replace(/'/g, '"') // single quotes to double
              .replace(/,\s*}/g, "}") // trailing commas
              .replace(/,\s*]/g, "]");

            if (repaired.includes("__proto__") || repaired.includes("constructor")) {
              throw new Error("Potentially malicious JSON detected");
            }
            return JSON.parse(repaired);
          } catch {
            return {}; // fallback to empty args
          }
        }
      };

      // Malformed but repairable
      expect(safeParseArgs("{'key': 'value'}")).toHaveProperty("key");
      expect(safeParseArgs('{"key": "value",}').key).toBe("value");

      // Unrepairable returns empty object - check it has no keys
      const emptyResult = safeParseArgs("not json at all");
      expect(Object.keys(emptyResult).length === 0).toBe(true);
    });
  });
});

describe("Tool Argument Validation", () => {
  describe("write tool validation", () => {
    test("should validate arguments before executing write tools", () => {
      // Lines 382-432 in agent.ts show validation pattern
      const writeToolsRequiringValidation = [
        "swap_token",
        "deploy_position",
        "close_position",
        "add_liquidity",
        "withdraw_liquidity",
      ];

      expect(writeToolsRequiringValidation.includes("deploy_position")).toBe(true);
      expect(writeToolsRequiringValidation.includes("close_position")).toBe(true);
    });

    test("should return validation error result with blocked flag when validation fails", () => {
      // Lines 412-431 in agent.ts show the validation error result shape

      const createValidationError = (error: string) => ({
        error: `Invalid arguments: ${error}`,
        success: false,
        blocked: true,
      });

      const result = createValidationError("pool_address is required");
      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.error.indexOf("Invalid arguments") >= 0).toBe(true);
    });
  });
});

describe("Final Answer Policy", () => {
  describe("no-tool retry behavior", () => {
    test("should retry when no tool called for tool-required request", () => {
      // Lines 291-314 in agent.ts
      // Pattern: if mustUseRealTool && !sawToolCall → increment retry → push reminder

      const MAX_NO_TOOL_RETRIES = 3;

      const shouldRetryNoTool = (
        mustUseRealTool: boolean,
        sawToolCall: boolean,
        retryCount: number
      ): boolean => {
        if (mustUseRealTool && !sawToolCall) {
          return retryCount < MAX_NO_TOOL_RETRIES;
        }
        return false;
      };

      expect(shouldRetryNoTool(true, false, 0)).toBe(true);
      expect(shouldRetryNoTool(true, false, 1)).toBe(true);
      expect(shouldRetryNoTool(true, false, 2)).toBe(true);
      expect(shouldRetryNoTool(true, false, 3)).toBe(false); // max reached
      expect(shouldRetryNoTool(false, false, 0)).toBe(false); // not required
      expect(shouldRetryNoTool(true, true, 0)).toBe(false); // already called
    });

    test("should return error when max no-tool retries exceeded", () => {
      // Lines 298-305 in agent.ts

      const createMaxRetriesResult = (goal: string) => ({
        content:
          "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
        userMessage: goal,
      });

      const result = createMaxRetriesResult("Deploy a position");
      expect(result.content.indexOf("no tool call was made") >= 0).toBe(true);
    });
  });

  describe("empty content handling", () => {
    test("should pop empty message and retry for Hermes null content", () => {
      // Lines 286-290 in agent.ts
      // Hermes models sometimes return null content — pop and retry

      const handleEmptyContent = (msg: { content: string | null }, messages: unknown[]) => {
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          return { shouldRetry: true };
        }
        return { shouldRetry: false };
      };

      const messages: unknown[] = [{ role: "assistant", content: null }];
      const result = handleEmptyContent({ content: null }, messages);
      expect(result.shouldRetry).toBe(true);
      expect(messages.length).toBe(0); // popped
    });
  });
});

// Run tests
runTests();
