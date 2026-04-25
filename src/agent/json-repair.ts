/**
 * JSON Repair Utilities
 *
 * Safe argument parsing with malicious JSON detection and repair fallback.
 * Extracted from agent.ts to isolate JSON handling concerns.
 */

import { jsonrepair } from "jsonrepair";
import { log } from "../infrastructure/logger.js";
import { getErrorMessage } from "../utils/errors.js";

/**
 * Safely parse tool call arguments with JSON repair fallback.
 * Detects and rejects potentially malicious JSON patterns.
 *
 * @param raw - Raw JSON string from tool call
 * @param functionName - Tool name for logging context
 * @returns Parsed arguments object
 */
export function safeParseArgs(raw: string, functionName: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      const repaired = jsonrepair(raw);
      // Security: reject prototype pollution attempts
      if (repaired.includes("__proto__") || repaired.includes("constructor")) {
        throw new Error("Potentially malicious JSON detected");
      }
      log("warn", `Repaired malformed JSON args for ${functionName}`);
      return JSON.parse(repaired) as Record<string, unknown>;
    } catch (parseError) {
      log("error", `Failed to parse args for ${functionName}: ${getErrorMessage(parseError)}`);
      return {};
    }
  }
}

/**
 * Repair malformed tool call JSON in-place.
 * The API rejects the next request if history contains invalid JSON args.
 *
 * @param toolCalls - Array of tool calls to repair
 */
export function repairToolCallJson(
  toolCalls: Array<{
    id: string;
    function: {
      name: string;
      arguments: string;
    };
  }>
): void {
  for (const tc of toolCalls) {
    if (tc.function?.arguments) {
      try {
        JSON.parse(tc.function.arguments);
      } catch {
        try {
          tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
          log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
        } catch {
          tc.function.arguments = "{}";
          log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
        }
      }
    }
  }
}
