import fs from "fs";
import { log } from "./logger.js";
import { USER_CONFIG_PATH } from "./paths.js";
import { registerTool } from "./tools/registry.js";
import type {
  Config,
  ConfigChangeMap,
  UpdateConfigInput,
  UpdateConfigResult,
  UserConfigPartial,
} from "./types/index.js";

const u: UserConfigPartial = fs.existsSync(USER_CONFIG_PATH)
  ? (JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) as UserConfigPartial)
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl) process.env.RPC_URL ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel) process.env.LLM_MODEL ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL ||= u.llmBaseUrl;
if (u.llmApiKey) process.env.LLM_API_KEY ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter: (() => void) | null = null;
export function registerCronRestarter(fn: () => void): void {
  _cronRestarter = fn;
}

export const config: Config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions: u.maxPositions ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl: u.minTvl ?? 10_000,
    maxTvl: u.maxTvl ?? 150_000,
    minVolume: u.minVolume ?? 500,
    minOrganic: u.minOrganic ?? 60,
    minHolders: u.minHolders ?? 500,
    minMcap: u.minMcap ?? 150_000,
    maxMcap: u.maxMcap ?? 10_000_000,
    minBinStep: u.minBinStep ?? 80,
    maxBinStep: u.maxBinStep ?? 125,
    maxVolatility: u.maxVolatility ?? null, // null = no max volatility ceiling
    timeframe: u.timeframe ?? "5m",
    category: u.category ?? "trending",
    minTokenFeesSol: u.minTokenFeesSol ?? 30, // global fees paid (priority+jito tips). below = bundled/scam
    maxBundlePct: u.maxBundlePct ?? 30, // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct: u.maxBotHoldersPct ?? 30, // max bot holder addresses % (Jupiter audit)
    maxTop10Pct: u.maxTop10Pct ?? 60, // max top 10 holders concentration
    blockedLaunchpads: u.blockedLaunchpads ?? [], // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours: u.minTokenAgeHours ?? null, // null = no minimum
    maxTokenAgeHours: u.maxTokenAgeHours ?? null, // null = no maximum
    athFilterPct: u.athFilterPct ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount: u.minClaimAmount ?? 5,
    autoSwapAfterClaim: u.autoSwapAfterClaim ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours: u.oorCooldownHours ?? 12,
    minVolumeToRebalance: u.minVolumeToRebalance ?? 1000,
    stopLossPct: u.stopLossPct ?? u.emergencyPriceDropPct ?? -50,
    takeProfitFeePct: u.takeProfitFeePct ?? 5,
    minFeePerTvl24h: u.minFeePerTvl24h ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen: u.minSolToOpen ?? 0.55,
    deployAmountSol: u.deployAmountSol ?? 0.5,
    gasReserve: u.gasReserve ?? 0.2,
    positionSizePct: u.positionSizePct ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit: u.trailingTakeProfit ?? true,
    trailingTriggerPct: u.trailingTriggerPct ?? 3, // activate trailing at X% PnL
    trailingDropPct: u.trailingDropPct ?? 1.5, // close when drops X% from peak
    pnlSanityMaxDiffPct: u.pnlSanityMaxDiffPct ?? 5, // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode: u.solMode ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy: u.strategy ?? "bid_ask",
    binsBelow: u.binsBelow ?? 69,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin: u.managementIntervalMin ?? 10,
    screeningIntervalMin: u.screeningIntervalMin ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens: u.maxTokens ?? 4096,
    maxSteps: u.maxSteps ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel: u.screeningModel ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel: u.generalModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── Darwin Evolution Config ───────────
  darwin: {
    enabled: u.darwin?.enabled ?? false,
    windowDays: u.darwin?.windowDays ?? 30,
    minSamples: u.darwin?.minSamples ?? 10,
    boostFactor: u.darwin?.boostFactor ?? 1.5,
    decayFactor: u.darwin?.decayFactor ?? 0.95,
    weightFloor: u.darwin?.weightFloor ?? 0.5,
    weightCeiling: u.darwin?.weightCeiling ?? 2.0,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 *
 * @param walletSol - Wallet SOL balance
 * @returns Computed deploy amount in SOL
 */
export function computeDeployAmount(walletSol: number): number {
  const reserve = config.management.gasReserve ?? 0.2;
  const pct = config.management.positionSizePct ?? 0.35;
  const floor = config.management.deployAmountSol;
  const ceil = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic = deployable * pct;
  const result = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds(): void {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) as UserConfigPartial;
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minOrganic != null) s.minOrganic = fresh.minOrganic;
    if (fresh.minHolders != null) s.minHolders = fresh.minHolders;
    if (fresh.minMcap != null) s.minMcap = fresh.minMcap;
    if (fresh.maxMcap != null) s.maxMcap = fresh.maxMcap;
    if (fresh.minTvl != null) s.minTvl = fresh.minTvl;
    if (fresh.maxTvl != null) s.maxTvl = fresh.maxTvl;
    if (fresh.minVolume != null) s.minVolume = fresh.minVolume;
    if (fresh.minBinStep != null) s.minBinStep = fresh.minBinStep;
    if (fresh.maxBinStep != null) s.maxBinStep = fresh.maxBinStep;
    if (fresh.timeframe != null) s.timeframe = fresh.timeframe;
    if (fresh.category != null) s.category = fresh.category;
    if (fresh.minTokenAgeHours !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct !== undefined) s.athFilterPct = fresh.athFilterPct;
    if (fresh.maxBundlePct != null) s.maxBundlePct = fresh.maxBundlePct;
    if (fresh.maxBotHoldersPct != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
  } catch {
    /* ignore */
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Registrations
// ═══════════════════════════════════════════════════════════════════════════

registerTool({
  name: "update_config",
  handler: (args: unknown) => {
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

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason } as UpdateConfigResult;
  },
  roles: ["GENERAL"],
});
