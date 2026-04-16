/**
 * Tool Registry
 *
 * Registry pattern for tool registration and lookup.
 * Tools self-register at module load time — no central switch statement needed.
 *
 * Updated to support middleware context injection.
 */

import type { ToolFunction } from "../src/types/executor.js";
import type { AgentType } from "../src/types/index.js";
import type { MiddlewareContext, MiddlewareFn } from "./middleware.js";

// Re-export MiddlewareContext type for convenience
export type { MiddlewareContext };

// Re-export ToolFunction as ToolHandler for semantic clarity
export type ToolHandler = ToolFunction;

import type { ToolName } from "../src/types/executor.js";

/** Tool registration structure */
export interface ToolRegistration {
  name: ToolName;
  handler: ToolHandler;
  roles: AgentType[]; // which roles can invoke this tool
  isWriteTool?: boolean; // triggers safety pre-checks
}

/** Internal registry storage */
const registry = new Map<string, ToolRegistration>();

/** Middleware context for tool execution */
let _middlewareContext: MiddlewareContext | null = null;
let _middlewareChain: MiddlewareFn[] | null = null;

/**
 * Register a tool with the registry.
 * Called by tool handler modules at load time.
 */
export function registerTool(tool: ToolRegistration): void {
  if (registry.has(tool.name)) {
    console.warn(`Tool "${tool.name}" is already registered. Overwriting.`);
  }
  registry.set(tool.name, tool);
}

/**
 * Get a tool registration by name.
 */
export function getTool(name: ToolName): ToolRegistration | undefined {
  return registry.get(name);
}

/**
 * Get all tools available to a specific role.
 */
export function getToolsForRole(role: AgentType): ToolRegistration[] {
  return [...registry.values()].filter((t) => t.roles.includes(role));
}

/**
 * Check if a tool exists in the registry.
 */
export function hasTool(name: ToolName): boolean {
  return registry.has(name);
}

/**
 * Get all registered tool names.
 */
export function getAllToolNames(): ToolName[] {
  return [...registry.keys()] as ToolName[];
}

/**
 * Clear the registry (useful for testing).
 */
export function clearRegistry(): void {
  registry.clear();
}

/**
 * Set the middleware context for tool execution.
 * This should be called during bootstrap to inject dependencies.
 */
export function setMiddlewareContext(context: MiddlewareContext): void {
  _middlewareContext = context;
}

/**
 * Get the current middleware context.
 */
export function getMiddlewareContext(): MiddlewareContext | null {
  return _middlewareContext;
}

/**
 * Set the middleware chain for tool execution.
 */
export function setMiddlewareChain(chain: MiddlewareFn[]): void {
  _middlewareChain = chain;
}

/**
 * Get the current middleware chain.
 */
export function getMiddlewareChain(): MiddlewareFn[] | null {
  return _middlewareChain;
}

/**
 * Execute a tool with middleware (if configured).
 * This is the main entry point for tool execution.
 */
export async function executeTool(
  tool: ToolRegistration,
  args: unknown,
  role: AgentType
): Promise<unknown> {
  // If middleware is configured, use it
  if (_middlewareContext && _middlewareChain) {
    const { applyMiddleware } = await import("./middleware.js");
    return applyMiddleware(tool, args, role, _middlewareChain, async (handlerArgs: unknown) => {
      const result = tool.handler(handlerArgs);
      // Normalize to Promise
      return Promise.resolve(result);
    });
  }

  // Otherwise, execute directly
  const result = tool.handler(args);
  return Promise.resolve(result);
}
