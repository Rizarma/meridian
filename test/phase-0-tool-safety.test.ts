/**
 * Phase 0 Characterization Tests: Tool Safety Gating
 *
 * Tests the tool safety check logic that mimics:
 * - tools/executor.ts lines 537-621 (deploy_position safety checks)
 * - agent.ts lines 29-70 (role-based tool access)
 */

import { describe, expect, runTests, test } from "./test-harness.js";

// Intent patterns for GENERAL role (from agent.ts lines 162-197)
const INTENT_PATTERNS = [
  { intent: "deploy", re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close", re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim", re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap", re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "config", re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance", re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions", re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "screen", re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  {
    intent: "lessons",
    re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i,
  },
] as const;

// Tool sets for each intent (from agent.ts lines 75-160)
const INTENT_TOOLS: { [key: string]: Set<string> } = {
  deploy: new Set([
    "deploy_position",
    "get_top_candidates",
    "get_active_bin",
    "get_pool_memory",
    "check_smart_wallets_on_pool",
    "get_token_holders",
    "get_token_narrative",
    "get_token_info",
    "search_pools",
    "get_wallet_balance",
    "get_my_positions",
    "add_pool_note",
  ]),
  close: new Set([
    "close_position",
    "get_my_positions",
    "get_position_pnl",
    "get_wallet_balance",
    "swap_token",
  ]),
  claim: new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap: new Set(["swap_token", "get_wallet_balance"]),
  config: new Set(["update_config"]),
  balance: new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions: new Set([
    "get_my_positions",
    "get_position_pnl",
    "get_wallet_balance",
    "set_position_note",
    "get_wallet_positions",
  ]),
  screen: new Set([
    "get_top_candidates",
    "get_token_holders",
    "get_token_narrative",
    "get_token_info",
    "search_pools",
    "check_smart_wallets_on_pool",
    "get_my_positions",
  ]),
  lessons: new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};
const MANAGER_TOOLS: Set<string> = new Set([
  "close_position",
  "claim_fees",
  "swap_token",
  "get_position_pnl",
  "get_my_positions",
  "get_wallet_balance",
]);

const SCREENER_TOOLS: Set<string> = new Set([
  "deploy_position",
  "get_active_bin",
  "get_top_candidates",
  "check_smart_wallets_on_pool",
  "get_token_holders",
  "get_token_narrative",
  "get_token_info",
  "search_pools",
  "get_pool_memory",
  "get_wallet_balance",
  "get_my_positions",
]);

const GENERAL_INTENT_ONLY_TOOLS: Set<string> = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

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

type AgentRole = "SCREENER" | "MANAGER" | "GENERAL";

// Role-based tool access check mimicking agent.ts getToolsForRole logic (lines 199-216)
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

  // GENERAL role: match intent from goal, combine matched tool sets (agent.ts lines 203-215)
  if (role === "GENERAL") {
    const matched = new Set<string>();
    for (const { intent, re } of INTENT_PATTERNS) {
      if (re.test(goal)) {
        const toolSet = INTENT_TOOLS[intent];
        if (toolSet) {
          for (const t of toolSet) matched.add(t);
        }
      }
    }

    // If no intent matched, fall back to all non-restricted tools
    if (matched.size === 0) {
      const hasRestrictedTool = GENERAL_INTENT_ONLY_TOOLS.has(toolName);
      if (!hasRestrictedTool) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Tool '${toolName}' requires specific intent in goal for GENERAL role.`,
      };
    }

    // Check if tool is in matched intent set
    if (matched.has(toolName)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Tool '${toolName}' not available for the matched intent in GENERAL role.`,
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
export {
  checkToolAccess,
  GENERAL_INTENT_ONLY_TOOLS,
  MANAGER_TOOLS,
  runDeploySafetyChecks,
  SCREENER_TOOLS,
};
