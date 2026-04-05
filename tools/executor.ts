/**
 * Tool Executor
 *
 * Thin dispatcher that delegates to the registry and middleware chain.
 * All cross-cutting concerns (safety, logging, notifications) are handled
 * by middleware — this file just wires them together.
 */

import { log } from "../logger.js";
import type { AgentType, ToolExecutionResult, ToolName } from "../types/index.js";
import {
  applyMiddleware,
  loggingMiddleware,
  notificationMiddleware,
  safetyCheckMiddleware,
} from "./middleware.js";
import { getTool } from "./registry.js";
import "./discover.js"; // Auto-discover and register all tools

// Middleware chain — order matters (safety first, notifications last)
const MIDDLEWARE_CHAIN = [safetyCheckMiddleware, loggingMiddleware, notificationMiddleware];

/**
 * Execute a tool call with safety checks, logging, and notifications.
 * Thin dispatcher — all heavy lifting is in registry and middleware.
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

  // Execute through middleware chain
  try {
    const result = (await applyMiddleware(
      tool,
      args,
      role,
      MIDDLEWARE_CHAIN,
      tool.handler
    )) as ToolExecutionResult;

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log("error", `Tool ${cleanName} threw: ${errorMsg}`);
    return { error: errorMsg, tool: cleanName };
  }
}
