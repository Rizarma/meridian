/**
 * Hive Mind — opt-in collective intelligence for meridian agents.
 *
 * When enabled, agents share anonymized performance data (lessons, deploy
 * outcomes, screening thresholds) with a central server. In return, they
 * receive consensus wisdom from other agents — weighted by credibility
 * and freshness — to inform screening and management decisions.
 *
 * Setup:
 *   1. Run: node -e "import('./hive-mind.js').then(m => m.register('https://your-hive-url'))"
 *   2. Save the API key shown — it won't be shown again.
 *   3. Agent auto-syncs on each position close and queries during screening.
 *
 * Disable: clear hiveMindUrl and hiveMindApiKey in user-config.json.
 *
 * Privacy: NO wallet addresses or private keys are ever sent.
 *          Only pool addresses (public on-chain data), performance stats,
 *          and lessons are shared. Agent IDs are anonymous UUIDs.
 *
 * Zero dependencies — uses only Node.js stdlib + native fetch().
 */

import fs from "node:fs";
import { config } from "../config/config.js";
import { USER_CONFIG_PATH } from "../config/paths.js";
import { listLessons } from "../domain/lessons.js";
import { getAllPoolDeploys } from "../domain/pool-memory.js";
import type {
  HiveMindConfig,
  HivePulse,
  LessonConsensus,
  PatternConsensus,
  PoolConsensus,
  RegistrationResult,
  SyncPayload,
  SyncResult,
  ThresholdConsensus,
} from "../types/hive-mind.js";
import { getErrorMessage } from "../utils/errors.js";

const SYNC_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const GET_TIMEOUT_MS = 5_000;
const POST_TIMEOUT_MS = 10_000;
const MIN_AGENTS_FOR_CONSENSUS = 3;
const MAX_CONSENSUS_CHARS = 500;

let _lastSyncTime = 0;

// ─── Helpers ────────────────────────────────────────────────────

function readConfig(): HiveMindConfig {
  try {
    const fileConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    return {
      hiveMindUrl: process.env.HIVE_MIND_URL || fileConfig.hiveMindUrl || "",
      hiveMindApiKey: process.env.HIVE_MIND_API_KEY || fileConfig.hiveMindApiKey || "",
      hiveMindAgentId: fileConfig.hiveMindAgentId || "",
    };
  } catch {
    return {
      hiveMindUrl: process.env.HIVE_MIND_URL || "",
      hiveMindApiKey: process.env.HIVE_MIND_API_KEY || "",
    };
  }
}

function writeConfig(patch: Record<string, unknown>): void {
  const current = readConfig();
  const merged = { ...current, ...patch };
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(merged, null, 2));
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = GET_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Check whether Hive Mind is configured and enabled.
 */
export function isEnabled(): boolean {
  if (!config.features.hiveMind) return false;
  const cfg = readConfig();
  return Boolean(cfg.hiveMindUrl && cfg.hiveMindApiKey);
}

/**
 * One-time registration with a Hive Mind server.
 * Stores hiveMindUrl and hiveMindApiKey in user-config.json.
 * @param url - Base URL of the hive server (e.g. "https://hive.example.com")
 * @param registrationToken - Token provided by the hive operator
 * @returns The raw API key (shown once, save it!)
 */
export async function register(url: string, registrationToken: string): Promise<string> {
  if (!registrationToken) {
    throw new Error("Registration token required. Get it from the hive operator.");
  }

  const baseUrl = url.replace(/\/+$/, "");
  const cfg = readConfig();
  const displayName = cfg.displayName || `agent-${Date.now().toString(36)}`;

  console.log("[hive]", `Registering with ${baseUrl} as "${displayName}"...`);

  const res = await fetchWithTimeout(
    `${baseUrl}/api/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName, registration_token: registrationToken }),
    },
    POST_TIMEOUT_MS
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Registration failed (${res.status}): ${text}`);
  }

  const { agent_id, api_key } = (await res.json()) as RegistrationResult;
  writeConfig({ hiveMindUrl: baseUrl, hiveMindApiKey: api_key, hiveMindAgentId: agent_id });
  console.log("[hive]", `Registered! agent_id=${agent_id}`);
  console.log(
    "[hive]",
    "API key saved to user-config.json — view it there (will NOT be shown again)"
  );

  return api_key;
}

/**
 * Batch-upload local data to the hive mind server.
 * Debounced (5 min), fire-and-forget, never throws.
 */
export async function syncToHive(): Promise<void> {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return;

    // Debounce
    const now = Date.now();
    if (now - _lastSyncTime < SYNC_DEBOUNCE_MS) return;

    // ── Collect local data ──────────────────────────

    // Lessons from SQLite
    const lessonsResult = listLessons({ limit: 1000, fullData: true });
    const lessons = lessonsResult.lessons.map((lesson) => ({
      id: lesson.id,
      rule: lesson.rule,
      tags: lesson.tags,
      outcome: lesson.outcome,
      created_at: lesson.created_at,
      pinned: lesson.pinned,
      role: lesson.role,
    }));

    // Pool deploys from SQLite (convert null to undefined for API compatibility)
    const deploys = getAllPoolDeploys().map((d) => ({
      pool_address: d.pool_address,
      pool_name: d.pool_name ?? undefined,
      deployed_at: d.deployed_at ?? undefined,
      closed_at: d.closed_at ?? undefined,
      pnl_pct: d.pnl_pct ?? undefined,
      pnl_usd: d.pnl_usd ?? undefined,
      range_efficiency: d.range_efficiency ?? undefined,
      minutes_held: d.minutes_held ?? undefined,
      close_reason: d.close_reason ?? undefined,
      strategy: d.strategy ?? undefined,
      volatility: d.volatility ?? undefined,
      base_mint: d.base_mint ?? undefined,
    }));

    // Screening thresholds from config
    const thresholds = {
      minFeeActiveTvlRatio: cfg.minFeeActiveTvlRatio,
      minTvl: cfg.minTvl,
      maxTvl: cfg.maxTvl,
      minOrganic: cfg.minOrganic,
      minHolders: cfg.minHolders,
      minBinStep: cfg.minBinStep,
      maxBinStep: cfg.maxBinStep,
      minVolume: cfg.minVolume,
      minMcap: cfg.minMcap,
      stopLossPct: cfg.stopLossPct ?? cfg.emergencyPriceDropPct,
      takeProfitFeePct: cfg.takeProfitFeePct,
    };

    // Agent stats via dynamic import (avoids circular deps)
    let agentStats: import("../types/lessons.js").PerformanceMetrics | null = null;
    try {
      const { getPerformanceSummary } = await import("../domain/lessons.js");
      agentStats = getPerformanceSummary();
    } catch (e) {
      console.log("[hive]", `Could not load agent stats: ${getErrorMessage(e)}`);
    }

    // Update debounce timer after successful data collection
    _lastSyncTime = now;

    // ── POST to /api/sync ───────────────────────────

    const payload: SyncPayload = { lessons, deploys, thresholds, agentStats };

    console.log("[hive]", `Syncing ${lessons.length} lessons, ${deploys.length} deploys...`);

    const res = await fetchWithTimeout(
      `${cfg.hiveMindUrl}/api/sync`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.hiveMindApiKey}`,
        },
        body: JSON.stringify(payload),
      },
      POST_TIMEOUT_MS
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.log("[hive]", `Sync failed (${res.status}): ${text}`);
      return;
    }

    const result = (await res.json()) as SyncResult;
    console.log(
      "[hive]",
      `Sync complete — ${result.lessons_upserted} lessons, ${result.deploys_upserted} deploys`
    );
  } catch (e) {
    console.log("[hive]", `Sync error: ${getErrorMessage(e)}`);
  }
}

/**
 * Query pool consensus from the hive.
 */
export async function queryPoolConsensus(poolAddress: string): Promise<PoolConsensus | null> {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const res = await fetchWithTimeout(
      `${cfg.hiveMindUrl}/api/consensus/pool/${encodeURIComponent(poolAddress)}`,
      { headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` } }
    );

    if (!res.ok) return null;
    return (await res.json()) as PoolConsensus;
  } catch {
    return null;
  }
}

/**
 * Query lesson consensus by tags.
 */
export async function queryLessonConsensus(tags?: string[]): Promise<LessonConsensus[] | null> {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const qs =
      Array.isArray(tags) && tags.length > 0 ? `?tags=${encodeURIComponent(tags.join(","))}` : "";
    const res = await fetchWithTimeout(`${cfg.hiveMindUrl}/api/consensus/lessons${qs}`, {
      headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` },
    });

    if (!res.ok) return null;
    return (await res.json()) as LessonConsensus[];
  } catch {
    return null;
  }
}

/**
 * Query pattern consensus for a given volatility level.
 */
export async function queryPatternConsensus(
  volatility?: number
): Promise<PatternConsensus[] | null> {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const qs = volatility != null ? `?volatility=${encodeURIComponent(volatility)}` : "";
    const res = await fetchWithTimeout(`${cfg.hiveMindUrl}/api/consensus/patterns${qs}`, {
      headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` },
    });

    if (!res.ok) return null;
    return (await res.json()) as PatternConsensus[];
  } catch {
    return null;
  }
}

/**
 * Query median threshold consensus across all agents.
 */
export async function queryThresholdConsensus(): Promise<ThresholdConsensus | null> {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const res = await fetchWithTimeout(`${cfg.hiveMindUrl}/api/consensus/thresholds`, {
      headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` },
    });

    if (!res.ok) return null;
    return (await res.json()) as ThresholdConsensus;
  } catch {
    return null;
  }
}

/**
 * Get global hive pulse stats.
 */
export async function getHivePulse(): Promise<HivePulse | null> {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const res = await fetchWithTimeout(`${cfg.hiveMindUrl}/api/pulse`, {
      headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` },
    });

    if (!res.ok) return null;
    return (await res.json()) as HivePulse;
  } catch {
    return null;
  }
}

/**
 * Query multiple pools in parallel and format for LLM prompt injection.
 * Only shows pools with >= 3 agents reporting (filters noise).
 */
export async function formatPoolConsensusForPrompt(poolAddresses: string[]): Promise<string> {
  if (!isEnabled() || !Array.isArray(poolAddresses) || poolAddresses.length === 0) {
    return "";
  }

  try {
    const results = await Promise.all(
      poolAddresses.map(async (addr) => {
        const data = await queryPoolConsensus(addr);
        return { addr, data };
      })
    );

    const lines: string[] = [];
    let _poolsWithData = 0;

    for (const { addr, data } of results) {
      if (data && data.unique_agents >= MIN_AGENTS_FOR_CONSENSUS) {
        _poolsWithData++;
        const name = data.pool_name || addr.slice(0, 8);
        const winPct = data.weighted_win_rate ?? 0;
        const avgPnl =
          data.weighted_avg_pnl != null
            ? `${(data.weighted_avg_pnl >= 0 ? "+" : "") + data.weighted_avg_pnl.toFixed(1)}%`
            : "N/A";
        lines.push(
          `[HIVE] ${name}: ${data.unique_agents} agents, ${winPct}% win, ${avgPnl} avg PnL`
        );
      }
    }

    if (lines.length === 0) return "";

    const header = `HIVE MIND CONSENSUS (supplementary — your own analysis takes priority):`;
    let output = [header, ...lines].join("\n");

    if (output.length > MAX_CONSENSUS_CHARS) {
      output = `${output.slice(0, MAX_CONSENSUS_CHARS - 3)}...`;
    }

    return output;
  } catch (e) {
    console.log("[hive]", `formatPoolConsensusForPrompt error: ${getErrorMessage(e)}`);
    return "";
  }
}
