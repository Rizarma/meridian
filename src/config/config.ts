import fs from "fs";
import { registerTool } from "../../tools/registry.js";
import { log } from "../infrastructure/logger.js";
import type {
  Config,
  ConfigChangeMap,
  UpdateConfigInput,
  UpdateConfigResult,
  UserConfigPartial,
} from "../types/index.js";
import { USER_CONFIG_PATH } from "./paths.js";

/**
 * Sanitize parsed JSON to prevent prototype pollution.
 * Removes __proto__, constructor, and prototype keys from objects.
 */
function sanitizeJson<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeJson) as unknown as T;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Block prototype pollution keys
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    sanitized[key] = sanitizeJson(value);
  }
  return sanitized as T;
}

let u: UserConfigPartial = {};
if (fs.existsSync(USER_CONFIG_PATH)) {
  try {
    const raw = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) as UserConfigPartial;
    u = sanitizeJson(raw);
  } catch (e) {
    log(
      "config_warn",
      `Failed to parse user-config.json: ${(e as Error).message}. Using empty config.`
    );
    u = {};
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration Precedence:
//   1. Environment variables (.env) - for secrets and deployment overrides
//   2. user-config.json - for user preferences and tuning
//   3. Hardcoded defaults - sensible fallbacks
//
// This follows 12-Factor App best practices:
//   - .env = secrets + environment-specific settings (never committed)
//   - user-config.json = user preferences (portable, can be shared)
// ═══════════════════════════════════════════════════════════════════════════

// Copy user-config values to process.env if not already set (maintains precedence)
// These are needed by code that reads directly from process.env (agent.ts, tools/)
if (u.rpcUrl) process.env.RPC_URL ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmBaseUrl) process.env.LLM_BASE_URL ||= u.llmBaseUrl;
if (u.llmApiKey) process.env.LLM_API_KEY ||= u.llmApiKey;

// Helper to check if env value is meaningfully set
function hasEnvValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

// Helper to check for non-empty env values
function hasNonEmptyEnv(...keys: string[]): boolean {
  return keys.every((key) => {
    const val = process.env[key];
    return val !== undefined && val.trim() !== "";
  });
}

/**
 * Get the effective RPC_URL with fallback chain:
 * 1. process.env.RPC_URL (if set and non-empty)
 * 2. user-config.json rpcUrl
 * 3. Default Solana mainnet
 *
 * This is needed because tools read RPC_URL directly from process.env,
 * and we need to ensure they get a valid URL even if .env has an empty value.
 */
export function getRpcUrl(): string {
  return hasEnvValue(process.env.RPC_URL)
    ? process.env.RPC_URL
    : u.rpcUrl || "https://api.mainnet-beta.solana.com";
}

// Helper: Get value with precedence env > user-config > default
const getConfig = <T>(envKey: string, userKey: keyof UserConfigPartial, defaultValue: T): T => {
  const envValue = process.env[envKey];
  if (hasEnvValue(envValue)) {
    // Try to parse as the same type as default
    if (typeof defaultValue === "boolean") return (envValue === "true") as unknown as T;
    if (typeof defaultValue === "number") {
      const parsed = parseFloat(envValue);
      return (Number.isNaN(parsed) ? defaultValue : parsed) as unknown as T;
    }
    return envValue as unknown as T;
  }
  return (u[userKey] as T) ?? defaultValue;
};

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
    allowedLaunchpads: u.allowedLaunchpads ?? [], // e.g. ["pump.fun"] - if set, only allow these
    minTokenAgeHours: u.minTokenAgeHours ?? null, // null = no minimum
    maxTokenAgeHours: u.maxTokenAgeHours ?? null, // null = no maximum
    athFilterPct: u.athFilterPct ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    maxCandidatesEnriched: u.maxCandidatesEnriched ?? 10, // max pools to enrich with OKX + sent to recon per cycle
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
    // Trailing take-profit settings (feature flag in features.trailingTakeProfit)
    trailingTriggerPct: u.trailingTriggerPct ?? 3, // activate trailing at X% PnL
    trailingDropPct: u.trailingDropPct ?? 1.5, // close when drops X% from peak
    pnlSanityMaxDiffPct: u.pnlSanityMaxDiffPct ?? 5, // max allowed diff between reported and derived pnl % before ignoring a tick
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
    // Precedence: .env LLM_MODEL > user-config role-specific > user-config llmModel > defaults
    // Default models updated after healer-alpha/hunter-alpha were removed from OpenRouter
    managementModel:
      process.env.LLM_MODEL ?? u.managementModel ?? u.llmModel ?? "xiaomi/mimo-v2-omni",
    screeningModel:
      process.env.LLM_MODEL ?? u.screeningModel ?? u.llmModel ?? "xiaomi/mimo-v2-omni",
    generalModel: process.env.LLM_MODEL ?? u.generalModel ?? u.llmModel ?? "xiaomi/mimo-v2-omni",
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── Darwin Evolution Config ───────────
  darwin: {
    windowDays: u.darwin?.windowDays ?? 30,
    minSamples: u.darwin?.minSamples ?? 10,
    boostFactor: u.darwin?.boostFactor ?? 1.5,
    decayFactor: u.darwin?.decayFactor ?? 0.95,
    weightFloor: u.darwin?.weightFloor ?? 0.5,
    weightCeiling: u.darwin?.weightCeiling ?? 2.0,
  },

  // ─── Feature Flags ─────────────────────
  features: {
    // Trailing take-profit: migrated from management.trailingTakeProfit
    trailingTakeProfit: u.features?.trailingTakeProfit ?? u.trailingTakeProfit ?? true,
    // Hive Mind sync: requires HIVE_MIND_URL and HIVE_MIND_API_KEY env vars
    hiveMind:
      u.features?.hiveMind ?? u.hiveMind ?? hasNonEmptyEnv("HIVE_MIND_URL", "HIVE_MIND_API_KEY"),
    // Darwin evolution: enabled via features.darwinEvolution or flat darwinEvolution key
    darwinEvolution: u.features?.darwinEvolution ?? u.darwinEvolution ?? false,
    // SOL mode: migrated from management.solMode
    solMode: u.features?.solMode ?? u.solMode ?? false,
    // OKX integration: requires OKX_API_KEY and OKX_API_SECRET env vars
    okx: u.features?.okx ?? u.okx ?? hasNonEmptyEnv("OKX_API_KEY", "OKX_API_SECRET"),
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
    const raw = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) as UserConfigPartial;
    const fresh = sanitizeJson(raw);
    const s = config.screening;

    // Dynamically update all screening fields that exist in both fresh config and current config
    for (const key of Object.keys(fresh)) {
      const value = fresh[key as keyof UserConfigPartial];
      if (value !== undefined && key in s) {
        // Type-safe assignment: only copy if types match or value is null
        const currentValue = s[key as keyof typeof s];
        const typeofCurrent = typeof currentValue;
        const typeofFresh = typeof value;

        // Allow: same type, or null replacing nullable field, or number for null field
        if (
          typeofCurrent === typeofFresh ||
          (currentValue === null && typeofFresh === "number") ||
          (value === null && currentValue !== undefined)
        ) {
          (s as unknown as Record<string, unknown>)[key] = value;
        }
      }
    }
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
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
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
      // features
      trailingTakeProfit: ["features", "trailingTakeProfit"],
      hiveMind: ["features", "hiveMind"],
      darwinEvolution: ["features", "darwinEvolution"],
      solMode: ["features", "solMode"],
      okx: ["features", "okx"],
    };

    const applied: Record<string, string | number | boolean> = {};
    const unknown: string[] = [];

    const VALID_CONFIG_SECTIONS = [
      "screening",
      "management",
      "risk",
      "features",
      "llm",
      "schedule",
    ] as const;
    type ValidConfigSection = (typeof VALID_CONFIG_SECTIONS)[number];

    function isValidConfigSection(section: string): section is ValidConfigSection {
      return VALID_CONFIG_SECTIONS.includes(section as ValidConfigSection);
    }

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

    // Persist to user-config.json FIRST (atomic write), then apply to live config
    type UserConfig = Record<string, unknown> & { _lastAgentTune?: string };
    let userConfig: UserConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        const raw = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) as UserConfig;
        userConfig = sanitizeJson(raw);
      } catch {
        /* ignore parse errors */
      }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();

    try {
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
    } catch (e) {
      log("config_error", `Failed to write user-config.json: ${(e as Error).message}`);
      return { success: false, unknown, reason, applied: {} } as UpdateConfigResult;
    }

    // Apply to live config AFTER successful disk write
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      if (!isValidConfigSection(section)) {
        log("config_error", `Invalid config section: ${section}`);
        continue;
      }
      const configSection = config[section] as unknown as Record<string, unknown>;
      if (!(field in configSection)) {
        log("config_error", `Invalid config field: ${section}.${field}`);
        continue;
      }
      const before = configSection[field];
      configSection[field] = val;
      log(
        "config",
        `update_config: config.${section}.${field} ${before} → ${val} (verify: ${configSection[field]})`
      );
    }

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
