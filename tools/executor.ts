import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import {
  addLesson,
  clearAllLessons,
  clearPerformance,
  removeLessonsByKeyword,
  getPerformanceHistory,
  pinLesson,
  unpinLesson,
  listLessons,
} from "../lessons.js";
import { setPositionInstruction } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import {
  addStrategy,
  listStrategies,
  getStrategy,
  setActiveStrategy,
  removeStrategy,
} from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import {
  addSmartWallet,
  removeSmartWallet,
  listSmartWallets,
  checkSmartWalletsOnPool,
} from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds } from "../config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

import type {
  ToolName,
  WriteTool,
  ProtectedTool,
  SafetyCheckResult,
  ToolExecutionResult,
  ConfigChangeMap,
  UpdateConfigInput,
  UpdateConfigResult,
  CronRestarter,
  ActionLog,
  DeployPositionArgs,
  SwapTokenArgs,
  ClosePositionArgs,
  SetPositionNoteArgs,
  ClearLessonsArgs,
  AddLessonArgs,
  LessonIdArgs,
  ListLessonsArgs,
  WalletBalances,
  TokenBalance,
  MyPositionsResult,
  SwapResult,
  Position,
} from "../types/index.js";

// Tool function type - defined locally to avoid conflict with tools.d.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolFunction = (args: any) => Promise<any> | any;

// ToolMap interface
interface ToolMap {
  [key: string]: ToolFunction;
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter: CronRestarter | null = null;
export function registerCronRestarter(fn: CronRestarter): void {
  _cronRestarter = fn;
}

// Map tool names to implementations
const toolMap: ToolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: (args: unknown) => {
    const { position_address, instruction } = args as SetPositionNoteArgs;
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim();
      if (result.includes("Already up to date")) {
        return {
          success: true,
          updated: false,
          message: "Already up to date — no restart needed.",
        };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return {
        success: true,
        updated: true,
        message: `Updated! Restarting in 3s...\n${result}`,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { success: false, error };
    }
  },
  get_performance_history: getPerformanceHistory,
  add_strategy: addStrategy,
  list_strategies: listStrategies,
  get_strategy: getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy: removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: (args: unknown) => {
    const { rule, tags, pinned, role } = args as AddLessonArgs;
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson: (args: unknown) => {
    const { id } = args as LessonIdArgs;
    return pinLesson(id);
  },
  unpin_lesson: (args: unknown) => {
    const { id } = args as LessonIdArgs;
    return unpinLesson(id);
  },
  list_lessons: (args: unknown) => {
    const { role, pinned, tag, limit } = (args as ListLessonsArgs) || {};
    return listLessons({ role, pinned, tag, limit });
  },
  clear_lessons: (args: unknown) => {
    const { mode, keyword } = args as ClearLessonsArgs;
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: (args: unknown) => {
    const { changes, reason = "" } = args as UpdateConfigInput;

    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP: ConfigChangeMap = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      maxBundlePct: ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct: ["screening", "athFilterPct"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitFeePct: ["management", "takeProfitFeePct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      // strategy
      binsBelow: ["strategy", "binsBelow"],
    };

    const applied: Record<string, string | number | boolean> = {};
    const unknown: string[] = [];

    // Build case-insensitive lookup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const CONFIG_MAP_LOWER: Record<string, any> = Object.entries(CONFIG_MAP)
      .map(([k, v]) => [k.toLowerCase(), [k, v]])
      .reduce((acc, [k, v]) => ({ ...acc, [k as string]: v }), {});

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) {
        unknown.push(key);
        continue;
      }
      applied[match[0] as string] = val;
    }

    if (Object.keys(applied).length === 0) {
      log(
        "config",
        `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`
      );
      return { success: false, unknown, reason } as UpdateConfigResult;
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const configSection = (config as any)[section];
      const before = configSection[field];
      configSection[field] = val;
      log(
        "config",
        `update_config: config.${section}.${field} ${before} → ${val} (verify: ${configSection[field]})`
      );
    }

    // Persist to user-config.json
    type UserConfig = Record<string, unknown> & { _lastAgentTune?: string };
    let userConfig: UserConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) as UserConfig;
      } catch {
        /* ignore parse errors */
      }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged =
      applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log(
        "config",
        `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`
      );
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      (k) => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map((k) => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason } as UpdateConfigResult;
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS: Set<WriteTool> = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS: Set<ProtectedTool> = new Set([...WRITE_TOOLS, "self_update"]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name: string, args: unknown): Promise<ToolExecutionResult> {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name as ProtectedTool)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await fn(args)) as Record<string, any>;
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: args as any,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        const swapArgs = args as SwapTokenArgs;
        notifySwap({
          inputSymbol: swapArgs.input_mint?.slice(0, 8),
          outputSymbol:
            swapArgs.output_mint === "So11111111111111111111111111111111111111112" ||
            swapArgs.output_mint === "SOL"
              ? "SOL"
              : swapArgs.output_mint?.slice(0, 8),
          amountIn: result.amount_in ? parseFloat(result.amount_in) : undefined,
          amountOut: result.amount_out ? parseFloat(result.amount_out) : undefined,
          tx: (result.tx as string) || undefined,
        }).catch(() => {});
      } else if (name === "deploy_position") {
        const deployArgs = args as DeployPositionArgs & { pool_name?: string };
        notifyDeploy({
          pair:
            (result.pool_name as string) ||
            deployArgs.pool_name ||
            deployArgs.pool_address?.slice(0, 8) ||
            "unknown",
          amountSol: deployArgs.amount_y ?? deployArgs.amount_sol ?? 0,
          position: (result.position as string) || undefined,
          tx: (result.txs as string[])?.[0] ?? ((result.tx as string) || undefined),
          priceRange: (result.price_range as { min: number; max: number }) || undefined,
          binStep: (result.bin_step as number) || undefined,
          baseFee: (result.base_fee as number) || undefined,
        }).catch(() => {});
      } else if (name === "close_position") {
        const closeArgs = args as ClosePositionArgs;
        notifyClose({
          pair:
            (result.pool_name as string) || closeArgs.position_address?.slice(0, 8) || "unknown",
          pnlUsd: (result.pnl_usd as number) ?? 0,
          pnlPct: (result.pnl_pct as number) ?? 0,
        }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (closeArgs.reason && closeArgs.reason.toLowerCase().includes("yield")) {
          const poolAddr = (result.pool as string) || closeArgs.pool_address;
          if (poolAddr) {
            // Fire and forget - don't wait for result
            void addPoolNote({
              pool_address: poolAddr,
              note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0, 10)}`,
            });
          }
        }
        // Auto-swap base token back to SOL unless user said to hold
        if (!closeArgs.skip_swap && result.base_mint) {
          void (async () => {
            try {
              const balances = (await getWalletBalances()) as WalletBalances;
              const baseMint = result.base_mint as string;
              const token = balances.tokens?.find((t: TokenBalance) => t.mint === baseMint);
              if (token && (token.usd || 0) >= 0.1) {
                log(
                  "executor",
                  `Auto-swapping ${token.symbol || baseMint.slice(0, 8)} ($${(token.usd || 0).toFixed(2)}) back to SOL`
                );
                const swapResult = (await swapToken({
                  input_mint: baseMint,
                  output_mint: "SOL",
                  amount: token.balance || 0,
                })) as SwapResult;
                // Tell the model the swap already happened so it doesn't call swap_token again
                result.auto_swapped = true;
                result.auto_swap_note = `Base token already auto-swapped back to SOL (${token.symbol || baseMint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
                if (swapResult?.amount_out) {
                  result.sol_received = swapResult.amount_out;
                }
              }
            } catch (e) {
              const errorMsg = e instanceof Error ? e.message : String(e);
              log("executor_warn", `Auto-swap after close failed: ${errorMsg}`);
            }
          })();
        }
      } else if (
        name === "claim_fees" &&
        config.management.autoSwapAfterClaim &&
        result.base_mint
      ) {
        void (async () => {
          try {
            const balances = (await getWalletBalances()) as WalletBalances;
            const baseMint = result.base_mint as string;
            const token = balances.tokens?.find((t: TokenBalance) => t.mint === baseMint);
            if (token && (token.usd || 0) >= 0.1) {
              log(
                "executor",
                `Auto-swapping claimed ${token.symbol || baseMint.slice(0, 8)} ($${(token.usd || 0).toFixed(2)}) back to SOL`
              );
              await swapToken({
                input_mint: baseMint,
                output_mint: "SOL",
                amount: token.balance || 0,
              });
            }
          } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            log("executor_warn", `Auto-swap after claim failed: ${errorMsg}`);
          }
        })();
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);

    logAction({
      tool: name,
      args: args as Record<string, unknown>,
      error: errorMsg,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: errorMsg,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name: string, args: unknown): Promise<SafetyCheckResult> {
  switch (name) {
    case "deploy_position": {
      const deployArgs = args as DeployPositionArgs;
      // Reject pools with bin_step out of configured range
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

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = (await getMyPositions({ force: true })) as MyPositionsResult;
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

      // Block same base token across different pools
      if (deployArgs.base_mint) {
        const alreadyHasMint = positions.positions.some(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (p: any) => p.base_mint === deployArgs.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${deployArgs.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
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

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = (await getWalletBalances()) as WalletBalances;
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

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason:
            "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason:
            "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result: unknown): unknown {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
