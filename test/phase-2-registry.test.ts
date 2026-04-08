/**
 * Phase 2 Tests: Registry Pattern
 *
 * Tests the tool registry implementation directly:
 * - registerTool() adds tools to registry
 * - getTool() retrieves tool by name
 * - getToolsForRole() filters by role
 * - hasTool() checks existence
 * - clearRegistry() resets for testing
 *
 * These tests exercise the REAL registry functions, not mocks.
 */

import type { ToolName } from "../src/types/executor.js";
import {
  clearRegistry,
  getAllToolNames,
  getTool,
  getToolsForRole,
  hasTool,
  registerTool,
} from "../tools/registry.js";
import { describe, expect, runTests, test } from "./test-harness.js";

// ═══════════════════════════════════════════════════════════════════════════
// Import bootstrap module which triggers ALL tool registrations
// This tests the REAL production bootstrap path used by index.ts
// ═══════════════════════════════════════════════════════════════════════════
import "../src/bootstrap.js";

// Test tool handler
const mockHandler = async (args: unknown) => ({ success: true, args });

// Use real tool names from the union type for testing
const TEST_TOOL_1: ToolName = "discover_pools";
const TEST_TOOL_2: ToolName = "get_top_candidates";
const TEST_TOOL_3: ToolName = "get_pool_detail";
const _TEST_TOOL_4: ToolName = "deploy_position";

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION TEST FIRST: Must run before any clearRegistry() calls
// ═══════════════════════════════════════════════════════════════════════════
describe("Registry Integration - Real Tool Loading", () => {
  test("registry is populated by production bootstrap path", () => {
    // Importing ../src/bootstrap.js triggers all tool registrations
    // This validates the real production path used by index.ts.

    const allNames = getAllToolNames();

    // Should NOT be empty - real tools should be registered from module imports
    expect(allNames.length > 0).toBe(true);

    // Verify real tools from the codebase are present (registered by module side-effects)
    // These are actual tools that should be registered when the modules load:

    // ═══════════════════════════════════════════════════════════════════════
    // TOOLS DIRECTORY (via auto-discovery)
    // ═══════════════════════════════════════════════════════════════════════

    // From screening.ts (3 tools)
    expect(hasTool("discover_pools")).toBe(true);
    expect(hasTool("get_top_candidates")).toBe(true);
    expect(hasTool("get_pool_detail")).toBe(true);

    // From dlmm.ts (8 tools)
    expect(hasTool("deploy_position")).toBe(true);
    expect(hasTool("close_position")).toBe(true);
    expect(hasTool("claim_fees")).toBe(true);
    expect(hasTool("get_my_positions")).toBe(true);
    expect(hasTool("get_position_pnl")).toBe(true);
    expect(hasTool("get_active_bin")).toBe(true);
    expect(hasTool("search_pools")).toBe(true);
    expect(hasTool("get_wallet_positions")).toBe(true);

    // From wallet.ts (2 tools)
    expect(hasTool("get_wallet_balance")).toBe(true);
    expect(hasTool("swap_token")).toBe(true);

    // From token.ts (3 tools)
    expect(hasTool("get_token_info")).toBe(true);
    expect(hasTool("get_token_holders")).toBe(true);
    expect(hasTool("get_token_narrative")).toBe(true);

    // From study.ts (2 tools)
    expect(hasTool("get_top_lpers")).toBe(true);
    expect(hasTool("study_top_lpers")).toBe(true);

    // From admin.ts (1 tool)
    expect(hasTool("self_update")).toBe(true);

    // ═══════════════════════════════════════════════════════════════════════
    // ROOT-LEVEL TOOL FILES (via explicit import in discover.ts)
    // ═══════════════════════════════════════════════════════════════════════

    // From smart-wallets.ts (4 tools)
    expect(hasTool("add_smart_wallet")).toBe(true);
    expect(hasTool("remove_smart_wallet")).toBe(true);
    expect(hasTool("list_smart_wallets")).toBe(true);
    expect(hasTool("check_smart_wallets_on_pool")).toBe(true);

    // From strategy-library.ts (5 tools)
    expect(hasTool("add_strategy")).toBe(true);
    expect(hasTool("list_strategies")).toBe(true);
    expect(hasTool("get_strategy")).toBe(true);
    expect(hasTool("set_active_strategy")).toBe(true);
    expect(hasTool("remove_strategy")).toBe(true);

    // From pool-memory.ts (2 tools)
    expect(hasTool("get_pool_memory")).toBe(true);
    expect(hasTool("add_pool_note")).toBe(true);

    // From token-blacklist.ts (3 tools)
    expect(hasTool("add_to_blacklist")).toBe(true);
    expect(hasTool("remove_from_blacklist")).toBe(true);
    expect(hasTool("list_blacklist")).toBe(true);

    // From dev-blocklist.ts (3 tools)
    expect(hasTool("block_deployer")).toBe(true);
    expect(hasTool("unblock_deployer")).toBe(true);
    expect(hasTool("list_blocked_deployers")).toBe(true);

    // From lessons.ts (6 tools)
    expect(hasTool("add_lesson")).toBe(true);
    expect(hasTool("pin_lesson")).toBe(true);
    expect(hasTool("unpin_lesson")).toBe(true);
    expect(hasTool("list_lessons")).toBe(true);
    expect(hasTool("clear_lessons")).toBe(true);
    expect(hasTool("get_performance_history")).toBe(true);

    // From state.ts (1 tool)
    expect(hasTool("set_position_note")).toBe(true);

    // From config.ts (1 tool)
    expect(hasTool("update_config")).toBe(true);

    // Verify tool metadata is correctly loaded from side-effect registrations
    const deployTool = getTool("deploy_position");
    expect(deployTool !== undefined).toBe(true);
    expect(deployTool?.roles.includes("SCREENER")).toBe(true);
    expect(deployTool?.roles.includes("GENERAL")).toBe(true);
    expect(deployTool?.isWriteTool).toBe(true);

    const closeTool = getTool("close_position");
    expect(closeTool !== undefined).toBe(true);
    expect(closeTool?.roles.includes("MANAGER")).toBe(true);
    expect(closeTool?.isWriteTool).toBe(true);

    const walletPositionsTool = getTool("get_wallet_positions");
    expect(walletPositionsTool !== undefined).toBe(true);
    // This tool is GENERAL-only (for researching external wallets)
    expect(
      walletPositionsTool?.roles.length === 1 && walletPositionsTool?.roles[0] === "GENERAL"
    ).toBe(true);

    // Verify role filtering works with real registered tools
    const screenerTools = getToolsForRole("SCREENER");
    expect(screenerTools.some((t) => t.name === "discover_pools")).toBe(true);
    expect(screenerTools.some((t) => t.name === "deploy_position")).toBe(true);
    expect(screenerTools.some((t) => t.name === "get_wallet_balance")).toBe(true);

    const managerTools = getToolsForRole("MANAGER");
    expect(managerTools.some((t) => t.name === "close_position")).toBe(true);
    expect(managerTools.some((t) => t.name === "claim_fees")).toBe(true);
    expect(managerTools.some((t) => t.name === "swap_token")).toBe(true);

    // ═══════════════════════════════════════════════════════════════════════
    // STRICT COUNT CHECK: Must match total expected tools
    // tools/: 3 + 8 + 2 + 3 + 2 + 1 = 19
    // root: 4 + 5 + 2 + 3 + 3 + 6 + 1 + 1 = 25
    // Total: 44 tools
    // ═══════════════════════════════════════════════════════════════════════
    expect(allNames.length).toBe(44);
  });
});

describe("Registry Basics", () => {
  test("clearRegistry removes all tools", () => {
    // First register a tool to ensure there's something to clear
    registerTool({
      name: TEST_TOOL_1,
      handler: mockHandler,
      roles: ["GENERAL"],
    });
    expect(hasTool(TEST_TOOL_1)).toBe(true);

    clearRegistry();
    expect(hasTool(TEST_TOOL_1)).toBe(false);
    expect(getAllToolNames().length).toBe(0);
  });

  test("registerTool adds tool to registry", () => {
    clearRegistry();
    registerTool({
      name: TEST_TOOL_2,
      handler: mockHandler,
      roles: ["SCREENER", "GENERAL"],
      isWriteTool: true,
    });

    expect(hasTool(TEST_TOOL_2)).toBe(true);

    const tool = getTool(TEST_TOOL_2);
    expect(tool !== null && tool !== undefined).toBe(true);
    if (tool) {
      expect(tool.name).toBe(TEST_TOOL_2);
      expect(tool.roles.includes("SCREENER")).toBe(true);
      expect(tool.roles.includes("GENERAL")).toBe(true);
      expect(tool.isWriteTool).toBe(true);
    }
  });

  test("getTool returns undefined for unknown tool", () => {
    clearRegistry();
    const tool = getTool("self_update" as ToolName); // Valid ToolName but not registered
    expect(tool === undefined).toBe(true);
  });

  test("hasTool returns false for unknown tool", () => {
    clearRegistry();
    expect(hasTool("self_update" as ToolName)).toBe(false);
  });

  test("registerTool overwrites existing tool with warning", () => {
    clearRegistry();
    const handler1 = async () => ({ version: 1 });
    const handler2 = async () => ({ version: 2 });

    registerTool({
      name: TEST_TOOL_3,
      handler: handler1,
      roles: ["GENERAL"],
    });

    // Should overwrite without throwing
    registerTool({
      name: TEST_TOOL_3,
      handler: handler2,
      roles: ["GENERAL"],
    });

    const tool = getTool(TEST_TOOL_3);
    expect(tool !== null && tool !== undefined).toBe(true);
  });
});

describe("Registry Role Filtering", () => {
  test("getToolsForRole returns only tools for that role", () => {
    clearRegistry();

    registerTool({
      name: "discover_pools",
      handler: mockHandler,
      roles: ["SCREENER"],
    });

    registerTool({
      name: "get_position_pnl",
      handler: mockHandler,
      roles: ["MANAGER"],
    });

    registerTool({
      name: "self_update",
      handler: mockHandler,
      roles: ["GENERAL"],
    });

    registerTool({
      name: "deploy_position",
      handler: mockHandler,
      roles: ["SCREENER", "MANAGER", "GENERAL"],
    });

    const screenerTools = getToolsForRole("SCREENER");
    expect(screenerTools.length === 2).toBe(true);
    expect(screenerTools.some((t) => t.name === "discover_pools")).toBe(true);
    expect(screenerTools.some((t) => t.name === "deploy_position")).toBe(true);

    const managerTools = getToolsForRole("MANAGER");
    expect(managerTools.length === 2).toBe(true);
    expect(managerTools.some((t) => t.name === "get_position_pnl")).toBe(true);
    expect(managerTools.some((t) => t.name === "deploy_position")).toBe(true);

    const generalTools = getToolsForRole("GENERAL");
    expect(generalTools.length === 2).toBe(true);
    expect(generalTools.some((t) => t.name === "self_update")).toBe(true);
    expect(generalTools.some((t) => t.name === "deploy_position")).toBe(true);
  });

  test("getToolsForRole returns empty array when no tools match", () => {
    clearRegistry();
    const tools = getToolsForRole("SCREENER");
    expect(tools.length === 0).toBe(true);
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
  // DO NOT clear registry before running tests - we want to verify
  // that the production bootstrap path (src/bootstrap.js)
  // triggered the side-effect registrations in each tool module
  runTests();
}

export { clearRegistry };
