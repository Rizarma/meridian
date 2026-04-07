/**
 * Phase 0 Characterization Tests: Tool Safety Gating
 *
 * Tests the tool safety check logic that mimics:
 * - tools/executor.ts lines 537-621 (deploy_position safety checks)
 * - agent.ts lines 29-70 (role-based tool access)
 */

import {
  detectAllIntents,
  detectIntent,
  getRoleForIntent,
  getToolsForIntent,
  INTENTS,
} from "../src/agent/intent.js";
import {
  GENERAL_INTENT_ONLY_TOOLS,
  MANAGER_TOOLS,
  SCREENER_TOOLS,
} from "../src/agent/tool-sets.js";
import type { AgentType } from "../src/types/agent.js";
import { describe, expect, runTests, test } from "./test-harness.js";

// Mock config for safety checks
interface MockScreeningConfig {
  minBinStep: number;
  maxBinStep: number;
}

interface MockRiskConfig {
  maxPositions: number;
  maxDeployAmount: number;
}

interface MockManagementConfig {
  deployAmountSol: number;
  gasReserve: number;
}

interface MockConfig {
  screening: MockScreeningConfig;
  risk: MockRiskConfig;
  management: MockManagementConfig;
}

// Mock position data
interface MockPosition {
  position: string;
  pool: string;
  base_mint?: string;
}

interface MockPositionsResult {
  total_positions: number;
  positions: MockPosition[];
}

interface MockWalletBalances {
  sol: number;
}

// Safety check result
interface SafetyCheckResult {
  pass: boolean;
  reason?: string;
}

// Role check result with goal for GENERAL role intent matching
interface RoleCheckResult {
  allowed: boolean;
  reason?: string;
}

type AgentRole = AgentType;

// Role-based tool access check using real intent module
function checkToolAccess(role: AgentRole, toolName: string, goal: string = ""): RoleCheckResult {
  // SCREENER role can only access SCREENER_TOOLS
  if (role === "SCREENER") {
    if (SCREENER_TOOLS.has(toolName)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Tool '${toolName}' is not available to SCREENER role.`,
    };
  }

  // MANAGER role can only access MANAGER_TOOLS
  if (role === "MANAGER") {
    if (MANAGER_TOOLS.has(toolName)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Tool '${toolName}' is not available to MANAGER role.`,
    };
  }

  // GENERAL role: use real intent detection from intent module
  if (role === "GENERAL") {
    // Get ALL matching intents (production behavior: union tools from every matching intent)
    const matchedIntents = detectAllIntents(goal);

    // If any intents matched, union their tools and check against the union
    if (matchedIntents.length > 0) {
      const matchedTools = new Set<string>();
      for (const intent of matchedIntents) {
        for (const tool of getToolsForIntent(intent)) {
          matchedTools.add(tool);
        }
      }
      if (matchedTools.has(toolName)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Tool '${toolName}' not available for matched intents [${matchedIntents.join(", ")}] in GENERAL role.`,
      };
    }

    // If no intent matched, fall back to all non-restricted tools
    const hasRestrictedTool = GENERAL_INTENT_ONLY_TOOLS.has(toolName);
    if (!hasRestrictedTool) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Tool '${toolName}' requires specific intent in goal for GENERAL role.`,
    };
  }

  return { allowed: false, reason: "Unknown role" };
}

// Mock safety check logic mimicking executor.ts lines 537-621
function runDeploySafetyChecks(
  config: MockConfig,
  args: {
    pool_address: string;
    bin_step?: number;
    amount_y?: number;
    amount_sol?: number;
    base_mint?: string;
  },
  getMyPositions: () => MockPositionsResult,
  getWalletBalances: () => MockWalletBalances,
  isDryRun: boolean
): SafetyCheckResult {
  const deployArgs = args;

  // Check bin_step range (lines 542-552)
  const minStep = config.screening.minBinStep;
  const maxStep = config.screening.maxBinStep;
  if (
    deployArgs.bin_step != null &&
    (deployArgs.bin_step < minStep || deployArgs.bin_step > maxStep)
  ) {
    return {
      pass: false,
      reason: `bin_step ${deployArgs.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
    };
  }

  // Check position count + duplicate pool guard (lines 554-568)
  const positions = getMyPositions();
  if (positions.total_positions >= config.risk.maxPositions) {
    return {
      pass: false,
      reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
    };
  }

  const alreadyInPool = positions.positions.some((p) => p.pool === deployArgs.pool_address);
  if (alreadyInPool) {
    return {
      pass: false,
      reason: `Already have an open position in pool ${deployArgs.pool_address}. Cannot open duplicate.`,
    };
  }

  // Block same base token across different pools (lines 570-582)
  if (deployArgs.base_mint) {
    const alreadyHasMint = positions.positions.some((p) => p.base_mint === deployArgs.base_mint);
    if (alreadyHasMint) {
      return {
        pass: false,
        reason: `Already holding base token ${deployArgs.base_mint} in another pool. One position per token only.`,
      };
    }
  }

  // Check amount limits (lines 584-605)
  const amountY = deployArgs.amount_y ?? deployArgs.amount_sol ?? 0;
  if (amountY <= 0) {
    return {
      pass: false,
      reason: `Must provide a positive SOL amount (amount_y).`,
    };
  }

  const minDeploy = Math.max(0.1, config.management.deployAmountSol);
  if (amountY < minDeploy) {
    return {
      pass: false,
      reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
    };
  }
  if (amountY > config.risk.maxDeployAmount) {
    return {
      pass: false,
      reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
    };
  }

  // Check SOL balance (lines 607-618)
  if (!isDryRun) {
    const balance = getWalletBalances();
    const gasReserve = config.management.gasReserve;
    const minRequired = amountY + gasReserve;
    if (balance.sol < minRequired) {
      return {
        pass: false,
        reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
      };
    }
  }

  return { pass: true };
}

// ============================================================================
// Test Suite: deploy_position Safety Checks
// ============================================================================

describe("deploy_position Safety Checks", () => {
  let mockConfig: MockConfig;
  let mockPositions: MockPositionsResult;
  let mockBalances: MockWalletBalances;

  const mockGetMyPositions = () => mockPositions;
  const mockGetWalletBalances = () => mockBalances;

  test("bin_step below minBinStep is blocked", () => {
    mockConfig = {
      screening: { minBinStep: 80, maxBinStep: 125 },
      risk: { maxPositions: 3, maxDeployAmount: 50 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2 },
    };
    mockPositions = {
      total_positions: 1,
      positions: [{ position: "pos123", pool: "poolABC", base_mint: "mintXYZ" }],
    };
    mockBalances = { sol: 5.0 };

    const result = runDeploySafetyChecks(
      mockConfig,
      { pool_address: "poolNEW", bin_step: 50, amount_y: 1.0 },
      mockGetMyPositions,
      mockGetWalletBalances,
      false
    );

    expect(result.pass).toBe(false);
    expect(result.reason?.includes("bin_step 50")).toBeTruthy();
    expect(result.reason?.includes("outside the allowed range")).toBeTruthy();
    expect(result.reason?.includes("[80-125]")).toBeTruthy();
  });

  test("bin_step above maxBinStep is blocked", () => {
    mockConfig = {
      screening: { minBinStep: 80, maxBinStep: 125 },
      risk: { maxPositions: 3, maxDeployAmount: 50 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2 },
    };
    mockPositions = {
      total_positions: 1,
      positions: [{ position: "pos123", pool: "poolABC", base_mint: "mintXYZ" }],
    };
    mockBalances = { sol: 5.0 };

    const result = runDeploySafetyChecks(
      mockConfig,
      { pool_address: "poolNEW", bin_step: 150, amount_y: 1.0 },
      mockGetMyPositions,
      mockGetWalletBalances,
      false
    );

    expect(result.pass).toBe(false);
    expect(result.reason?.includes("bin_step 150")).toBeTruthy();
    expect(result.reason?.includes("outside the allowed range")).toBeTruthy();
  });

  test("bin_step within range is allowed", () => {
    mockConfig = {
      screening: { minBinStep: 80, maxBinStep: 125 },
      risk: { maxPositions: 3, maxDeployAmount: 50 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2 },
    };
    mockPositions = {
      total_positions: 1,
      positions: [{ position: "pos123", pool: "poolABC", base_mint: "mintXYZ" }],
    };
    mockBalances = { sol: 5.0 };

    const result = runDeploySafetyChecks(
      mockConfig,
      { pool_address: "poolNEW", bin_step: 100, amount_y: 1.0 },
      mockGetMyPositions,
      mockGetWalletBalances,
      false
    );

    expect(result.pass).toBe(true);
  });

  test("position count at maxPositions is blocked", () => {
    mockConfig = {
      screening: { minBinStep: 80, maxBinStep: 125 },
      risk: { maxPositions: 3, maxDeployAmount: 50 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2 },
    };
    mockPositions = {
      total_positions: 3,
      positions: [{ position: "pos123", pool: "poolABC", base_mint: "mintXYZ" }],
    };
    mockBalances = { sol: 5.0 };

    const result = runDeploySafetyChecks(
      mockConfig,
      { pool_address: "poolNEW", bin_step: 100, amount_y: 1.0 },
      mockGetMyPositions,
      mockGetWalletBalances,
      false
    );

    expect(result.pass).toBe(false);
    expect(result.reason?.includes("Max positions (3) reached")).toBeTruthy();
  });

  test("duplicate pool address is blocked", () => {
    mockConfig = {
      screening: { minBinStep: 80, maxBinStep: 125 },
      risk: { maxPositions: 3, maxDeployAmount: 50 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2 },
    };
    mockPositions = {
      total_positions: 1,
      positions: [{ position: "pos123", pool: "poolABC", base_mint: "mintXYZ" }],
    };
    mockBalances = { sol: 5.0 };

    const result = runDeploySafetyChecks(
      mockConfig,
      { pool_address: "poolABC", bin_step: 100, amount_y: 1.0 },
      mockGetMyPositions,
      mockGetWalletBalances,
      false
    );

    expect(result.pass).toBe(false);
    expect(result.reason?.includes("Already have an open position in pool poolABC")).toBeTruthy();
    expect(result.reason?.includes("Cannot open duplicate")).toBeTruthy();
  });

  test("duplicate base token is blocked", () => {
    mockConfig = {
      screening: { minBinStep: 80, maxBinStep: 125 },
      risk: { maxPositions: 3, maxDeployAmount: 50 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2 },
    };
    mockPositions = {
      total_positions: 1,
      positions: [{ position: "pos123", pool: "poolABC", base_mint: "mintXYZ" }],
    };
    mockBalances = { sol: 5.0 };

    const result = runDeploySafetyChecks(
      mockConfig,
      { pool_address: "poolNEW", bin_step: 100, amount_y: 1.0, base_mint: "mintXYZ" },
      mockGetMyPositions,
      mockGetWalletBalances,
      false
    );

    expect(result.pass).toBe(false);
    expect(result.reason?.includes("Already holding base token mintXYZ")).toBeTruthy();
    expect(result.reason?.includes("One position per token only")).toBeTruthy();
  });

  test("SOL balance below amount_y + gasReserve is blocked", () => {
    mockConfig = {
      screening: { minBinStep: 80, maxBinStep: 125 },
      risk: { maxPositions: 3, maxDeployAmount: 50 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2 },
    };
    mockPositions = {
      total_positions: 1,
      positions: [{ position: "pos123", pool: "poolABC", base_mint: "mintXYZ" }],
    };
    mockBalances = { sol: 0.5 }; // Less than 1.0 + 0.2

    const result = runDeploySafetyChecks(
      mockConfig,
      { pool_address: "poolNEW", bin_step: 100, amount_y: 1.0 },
      mockGetMyPositions,
      mockGetWalletBalances,
      false
    );

    expect(result.pass).toBe(false);
    expect(result.reason?.includes("Insufficient SOL")).toBeTruthy();
    expect(result.reason?.includes("have 0.5 SOL")).toBeTruthy();
    expect(result.reason?.includes("need 1.2 SOL")).toBeTruthy();
    expect(result.reason?.includes("1 deploy + 0.2 gas reserve")).toBeTruthy();
  });

  test("sufficient SOL balance is allowed", () => {
    mockConfig = {
      screening: { minBinStep: 80, maxBinStep: 125 },
      risk: { maxPositions: 3, maxDeployAmount: 50 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2 },
    };
    mockPositions = {
      total_positions: 1,
      positions: [{ position: "pos123", pool: "poolABC", base_mint: "mintXYZ" }],
    };
    mockBalances = { sol: 2.0 }; // More than 1.0 + 0.2

    const result = runDeploySafetyChecks(
      mockConfig,
      { pool_address: "poolNEW", bin_step: 100, amount_y: 1.0 },
      mockGetMyPositions,
      mockGetWalletBalances,
      false
    );

    expect(result.pass).toBe(true);
  });

  test("DRY_RUN mode skips balance check", () => {
    mockConfig = {
      screening: { minBinStep: 80, maxBinStep: 125 },
      risk: { maxPositions: 3, maxDeployAmount: 50 },
      management: { deployAmountSol: 0.5, gasReserve: 0.2 },
    };
    mockPositions = {
      total_positions: 1,
      positions: [{ position: "pos123", pool: "poolABC", base_mint: "mintXYZ" }],
    };
    mockBalances = { sol: 0.1 }; // Insufficient but DRY_RUN

    const result = runDeploySafetyChecks(
      mockConfig,
      { pool_address: "poolNEW", bin_step: 100, amount_y: 1.0 },
      mockGetMyPositions,
      mockGetWalletBalances,
      true // DRY_RUN
    );

    expect(result.pass).toBe(true);
  });
});

// ============================================================================
// Test Suite: Role-Based Tool Access
// ============================================================================

describe("Role-Based Tool Access", () => {
  test("SCREENER can invoke SCREENER tools (deploy_position)", () => {
    const result = checkToolAccess("SCREENER", "deploy_position");
    expect(result.allowed).toBe(true);
  });

  test("SCREENER can invoke SCREENER tools (get_top_candidates)", () => {
    const result = checkToolAccess("SCREENER", "get_top_candidates");
    expect(result.allowed).toBe(true);
  });

  test("SCREENER cannot invoke MANAGER-only tools (close_position)", () => {
    const result = checkToolAccess("SCREENER", "close_position");
    expect(result.allowed).toBe(false);
    expect(result.reason?.includes("not available to SCREENER role")).toBeTruthy();
  });

  test("SCREENER cannot invoke MANAGER-only tools (claim_fees)", () => {
    const result = checkToolAccess("SCREENER", "claim_fees");
    expect(result.allowed).toBe(false);
  });

  test("SCREENER cannot invoke MANAGER-only tools (swap_token)", () => {
    const result = checkToolAccess("SCREENER", "swap_token");
    expect(result.allowed).toBe(false);
  });

  test("SCREENER cannot invoke admin tools (update_config)", () => {
    const result = checkToolAccess("SCREENER", "update_config");
    expect(result.allowed).toBe(false);
  });

  test("MANAGER can invoke MANAGER tools (close_position)", () => {
    const result = checkToolAccess("MANAGER", "close_position");
    expect(result.allowed).toBe(true);
  });

  test("MANAGER can invoke MANAGER tools (claim_fees)", () => {
    const result = checkToolAccess("MANAGER", "claim_fees");
    expect(result.allowed).toBe(true);
  });

  test("MANAGER can invoke MANAGER tools (swap_token)", () => {
    const result = checkToolAccess("MANAGER", "swap_token");
    expect(result.allowed).toBe(true);
  });

  test("MANAGER can invoke MANAGER tools (get_position_pnl)", () => {
    const result = checkToolAccess("MANAGER", "get_position_pnl");
    expect(result.allowed).toBe(true);
  });

  test("MANAGER cannot invoke SCREENER tools (deploy_position)", () => {
    const result = checkToolAccess("MANAGER", "deploy_position");
    expect(result.allowed).toBe(false);
  });

  test("MANAGER cannot invoke admin tools (update_config)", () => {
    const result = checkToolAccess("MANAGER", "update_config");
    expect(result.allowed).toBe(false);
  });

  test("GENERAL can invoke admin tools (update_config) with matching intent", () => {
    const result = checkToolAccess("GENERAL", "update_config", "change the config settings");
    expect(result.allowed).toBe(true);
  });

  test("GENERAL cannot invoke admin tools without matching intent", () => {
    const result = checkToolAccess("GENERAL", "update_config", "hello");
    expect(result.allowed).toBe(false);
  });

  test("GENERAL can invoke SCREENER tools (deploy_position) with matching intent", () => {
    const result = checkToolAccess("GENERAL", "deploy_position", "deploy into a pool");
    expect(result.allowed).toBe(true);
  });

  test("GENERAL can invoke SCREENER tools without matching intent (non-restricted)", () => {
    // deploy_position is not in GENERAL_INTENT_ONLY_TOOLS, so it's allowed when no intent matches
    const result = checkToolAccess("GENERAL", "deploy_position", "hello");
    expect(result.allowed).toBe(true);
  });

  test("GENERAL can invoke MANAGER tools without matching intent (non-restricted)", () => {
    // close_position is not in GENERAL_INTENT_ONLY_TOOLS, so it's allowed when no intent matches
    const result = checkToolAccess("GENERAL", "close_position", "hello");
    expect(result.allowed).toBe(true);
  });

  test("GENERAL can invoke MANAGER tools (close_position) with matching intent", () => {
    const result = checkToolAccess("GENERAL", "close_position", "close my position");
    expect(result.allowed).toBe(true);
  });

  test("GENERAL can invoke MANAGER tools without matching intent (non-restricted)", () => {
    // close_position is not in GENERAL_INTENT_ONLY_TOOLS, so it's allowed when no intent matches
    const result = checkToolAccess("GENERAL", "close_position", "hello");
    expect(result.allowed).toBe(true);
  });

  test("GENERAL can invoke balance tools with matching intent", () => {
    const result = checkToolAccess("GENERAL", "get_wallet_balance", "check my balance");
    expect(result.allowed).toBe(true);
  });

  test("GENERAL falls back to non-restricted tools when no intent matches", () => {
    // get_wallet_balance is not in GENERAL_INTENT_ONLY_TOOLS, so it should be allowed
    const result = checkToolAccess("GENERAL", "get_wallet_balance", "hello");
    expect(result.allowed).toBe(true);
  });

  test("GENERAL cannot invoke restricted tools when no intent matches", () => {
    // update_config is in GENERAL_INTENT_ONLY_TOOLS, so it requires intent
    const result = checkToolAccess("GENERAL", "update_config", "hello");
    expect(result.allowed).toBe(false);
  });

  test("GENERAL uses intent-based filtering per agent.ts:199", () => {
    // Test that GENERAL role uses intent matching, not unlimited access
    const deployResult = checkToolAccess("GENERAL", "deploy_position", "find pools to invest in");
    expect(deployResult.allowed).toBe(true);

    const closeResult = checkToolAccess("GENERAL", "close_position", "exit my position");
    expect(closeResult.allowed).toBe(true);

    const claimResult = checkToolAccess("GENERAL", "claim_fees", "harvest my fees");
    expect(claimResult.allowed).toBe(true);
  });
});

// ============================================================================
// Test Suite: Real Intent Module Integration
// ============================================================================

describe("Real Intent Module Integration", () => {
  test("INTENTS array is exported and populated", () => {
    expect(INTENTS !== undefined && INTENTS !== null).toBe(true);
    expect(INTENTS.length > 0).toBe(true);
    expect(INTENTS.some((i) => i.intent === "deploy")).toBe(true);
    expect(INTENTS.some((i) => i.intent === "close")).toBe(true);
    expect(INTENTS.some((i) => i.intent === "config")).toBe(true);
  });

  test("detectIntent returns correct intent for deploy patterns", () => {
    expect(detectIntent("deploy into a pool")).toBe("deploy");
    expect(detectIntent("open a new position")).toBe("deploy");
    expect(detectIntent("add liquidity to this pool")).toBe("deploy");
    expect(detectIntent("lp into this token")).toBe("deploy");
    expect(detectIntent("invest in this pool")).toBe("deploy");
  });

  test("detectIntent returns correct intent for close patterns", () => {
    expect(detectIntent("close my position")).toBe("close");
    expect(detectIntent("exit this pool")).toBe("close");
    expect(detectIntent("withdraw my liquidity")).toBe("close");
    expect(detectIntent("remove liquidity now")).toBe("close");
    expect(detectIntent("shut down this position")).toBe("close");
  });

  test("detectIntent returns correct intent for claim patterns", () => {
    expect(detectIntent("claim my fees")).toBe("claim");
    expect(detectIntent("harvest the fees")).toBe("claim");
    expect(detectIntent("collect fees from position")).toBe("claim");
  });

  test("detectIntent returns correct intent for config patterns", () => {
    expect(detectIntent("change the config")).toBe("config");
    expect(detectIntent("update settings")).toBe("config");
    expect(detectIntent("set threshold to 100")).toBe("config");
  });

  test("detectIntent returns null for unmatched goals", () => {
    expect(detectIntent("hello")).toBe(null);
    expect(detectIntent("random text")).toBe(null);
    expect(detectIntent("")).toBe(null);
  });

  test("getToolsForIntent returns correct tools for deploy intent", () => {
    const tools = getToolsForIntent("deploy");
    expect(tools.includes("deploy_position")).toBe(true);
    expect(tools.includes("get_top_candidates")).toBe(true);
    expect(tools.includes("get_active_bin")).toBe(true);
    expect(tools.includes("close_position")).toBe(false);
  });

  test("getToolsForIntent returns correct tools for close intent", () => {
    const tools = getToolsForIntent("close");
    expect(tools.includes("close_position")).toBe(true);
    expect(tools.includes("get_my_positions")).toBe(true);
    expect(tools.includes("swap_token")).toBe(true);
    expect(tools.includes("deploy_position")).toBe(false);
  });

  test("getToolsForIntent returns empty array for unknown intent", () => {
    const tools = getToolsForIntent("unknown_intent");
    expect(tools.length === 0).toBe(true);
  });

  test("getRoleForIntent returns correct role for each intent", () => {
    expect(getRoleForIntent("deploy")).toBe("SCREENER");
    expect(getRoleForIntent("close")).toBe("MANAGER");
    expect(getRoleForIntent("claim")).toBe("MANAGER");
    expect(getRoleForIntent("swap")).toBe("MANAGER");
    expect(getRoleForIntent("config")).toBe("GENERAL");
    expect(getRoleForIntent("balance")).toBe("GENERAL");
    expect(getRoleForIntent("lessons")).toBe("GENERAL");
  });

  test("getRoleForIntent returns null for unknown intent", () => {
    expect(getRoleForIntent("unknown")).toBe(null);
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
  runTests();
}

export type {
  AgentRole,
  MockConfig,
  MockPositionsResult,
  MockWalletBalances,
  RoleCheckResult,
  SafetyCheckResult,
};
export { checkToolAccess, runDeploySafetyChecks };
