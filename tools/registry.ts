/**
 * Tool Registry
 *
 * Registry pattern for tool registration and lookup.
 * Tools self-register at module load time — no central switch statement needed.
 */

import type { ToolFunction } from "../src/types/executor.js";
import type { AgentType } from "../src/types/index.js";

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
