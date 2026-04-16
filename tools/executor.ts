/**
 * Tool Executor
 *
 * Thin dispatcher that delegates to the registry and middleware chain.
 * All cross-cutting concerns (safety, logging, notifications) are handled
 * by middleware — this file just wires them together.
 *
 * Updated to use dependency injection via registry middleware context.
 */

import { log } from "../src/infrastructure/logger.js";
import type { ToolName } from "../src/types/executor.js";
import type { AgentType, ToolExecutionResult } from "../src/types/index.js";
import { getMiddlewareChain, getMiddlewareContext, getTool } from "./registry.js";
import "./discover.js"; // Auto-discover and register all tools

/**
 * Validate that a value is a valid ToolExecutionResult shape.
 * Returns the value if valid, or creates a safe error result.
 */
function validateToolResult(result: unknown): ToolExecutionResult {
  if (typeof result !== "object" || result === null) {
    return { success: false, error: "Invalid result: not an object" };
  }
  const r = result as Record<string, unknown>;

  // Must have at least one of: success flag, error, blocked, or other result fields
  const hasSuccess = typeof r.success === "boolean";
  const hasError = typeof r.error === "string";
  const hasBlocked = typeof r.blocked === "boolean";
  const hasReason = typeof r.reason === "string";

  // If it has none of the expected fields, wrap it as a success result
  if (!hasSuccess && !hasError && !hasBlocked && !hasReason) {
    return { success: true, ...r };
  }

  return r as ToolExecutionResult;
}

/**
 * Execute a tool call with safety checks, logging, and notifications.
 * Thin dispatcher — all heavy lifting is in registry and middleware.
 *
 * NOTE: Middleware context must be initialized via bootstrap() before calling this.
 */
export async function executeTool(
  name: string,
  args: unknown,
  role: AgentType = "GENERAL"
): Promise<ToolExecutionResult> {
  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  const cleanName = name.replace(/<.*$/, "").trim();

  // Look up tool in registry
  const tool = getTool(cleanName as ToolName);
  if (!tool) {
    const error = `Unknown tool: ${cleanName}`;
    log("error", error);
    return { error };
  }

  // Validate role access
  if (!tool.roles.includes(role)) {
    const error = `Role ${role} cannot call ${cleanName}`;
    log("error", error);
    return { error };
  }

  // Get middleware chain from registry (set during bootstrap)
  const middlewareChain = getMiddlewareChain();
  const middlewareContext = getMiddlewareContext();

  // Execute through middleware chain if configured
  try {
    let rawResult: unknown;

    if (middlewareChain && middlewareContext) {
      const { applyMiddleware } = await import("./middleware.js");
      rawResult = await applyMiddleware(
        tool,
        args,
        role,
        middlewareChain,
        async (handlerArgs: unknown) => {
          const result = tool.handler(handlerArgs);
          // Normalize to Promise
          return Promise.resolve(result);
        }
      );
    } else {
      // Fallback: execute directly without middleware
      log("warn", `No middleware configured for ${cleanName}, executing directly`);
      const result = tool.handler(args);
      rawResult = await Promise.resolve(result);
    }

    return validateToolResult(rawResult);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log("error", `Tool ${cleanName} threw: ${errorMsg}`);
    return { error: errorMsg, tool: cleanName };
  }
}
