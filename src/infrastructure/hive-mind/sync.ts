/**
 * Hive Mind — sync, registration, and heartbeat.
 *
 * Handles data upload (syncToHive), one-time registration,
 * bootstrap sync, periodic heartbeat, and original-compatible
 * push functions (pushLesson, pushPerformance).
 *
 * Phase 4: Legacy functions (syncToHive, bootstrapSync, register, getHivePulse)
 * are soft-deprecated with JSDoc and one-time runtime warnings.
 * Path telemetry records usage of legacy batch sync and registration paths.
 */

import { listLessons } from "../../domain/lessons.js";
import { getAllPoolDeploys } from "../../domain/pool-memory.js";
import type {
  AgentRegistrationPayload,
  AgentRegistrationResponse,
  LessonPushPayload,
  PerformancePushPayload,
  PushResponse,
  RegistrationResult,
  SyncPayload,
  SyncResult,
} from "../../types/hive-mind.js";
import { getErrorMessage } from "../../utils/errors.js";
import { fetchWithTimeout, hivePost } from "./client.js";
import {
  _lastSyncTime,
  isEnabled,
  isLegacyBatchSyncEnabled,
  POST_TIMEOUT_MS,
  readConfig,
  recordPathUsage,
  SYNC_DEBOUNCE_MS,
  setLastSyncTime,
  warnDeprecation,
} from "./config.js";
import { getHivePulse } from "./consensus.js";

// ─── Original-Compatible Payload Builders ──────────────────────────

/**
 * Build an AgentRegistrationPayload matching the original JS contract.
 */
export function buildRegistrationPayload(params: {
  agentId: string;
  version: string;
  reason: string;
  capabilities: { telegram?: boolean; lpagent?: boolean; dryRun?: boolean };
}): AgentRegistrationPayload {
  return {
    agentId: params.agentId,
    version: params.version,
    timestamp: new Date().toISOString(),
    reason: params.reason,
    capabilities: {
      telegram: Boolean(params.capabilities.telegram),
      lpagent: Boolean(params.capabilities.lpagent),
      dryRun: Boolean(params.capabilities.dryRun),
    },
  };
}

/**
 * Build a LessonPushPayload for a single lesson.
 */
export function buildLessonPayload(params: {
  agentId: string;
  rule: string;
  tags: string[];
  outcome: string;
  context?: string;
}): LessonPushPayload {
  return {
    agentId: params.agentId,
    lesson: {
      rule: params.rule,
      tags: params.tags,
      outcome: params.outcome,
      context: params.context,
    },
  };
}

/**
 * Build a PerformancePushPayload for a closed-position record.
 */
export function buildPerformancePayload(params: {
  agentId: string;
  poolAddress: string;
  pnlPct: number;
  pnlUsd: number;
  holdTimeMinutes: number;
  closeReason: string;
  rangeEfficiency?: number;
  strategy?: string;
}): PerformancePushPayload {
  return {
    agentId: params.agentId,
    performance: {
      poolAddress: params.poolAddress,
      pnlPct: params.pnlPct,
      pnlUsd: params.pnlUsd,
      holdTimeMinutes: params.holdTimeMinutes,
      closeReason: params.closeReason,
      rangeEfficiency: params.rangeEfficiency,
      strategy: params.strategy,
    },
  };
}

// ─── Original-Compatible Registration ──────────────────────────────

/**
 * Register with the Hive Mind server using the original-compatible
 * endpoint: POST /api/hivemind/agents/register
 *
 * This is the Phase 1 registration path aligned to the original JS contract.
 * The legacy `register()` function is preserved for backward compatibility.
 *
 * Fail-open: returns null on any error instead of throwing.
 */
export async function registerAgent(params: {
  agentId: string;
  version: string;
  reason: string;
  capabilities: { telegram?: boolean; lpagent?: boolean; dryRun?: boolean };
}): Promise<AgentRegistrationResponse | null> {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const payload = buildRegistrationPayload(params);
    const url = `${cfg.hiveMindUrl.replace(/\/+$/, "")}/api/hivemind/agents/register`;

    console.log("[hive]", `Registering agent "${params.agentId}" v${params.version}...`);

    const result = await hivePost<AgentRegistrationResponse>(
      url,
      cfg.hiveMindApiKey,
      payload,
      POST_TIMEOUT_MS
    );

    if (result) {
      console.log(
        "[hive]",
        `Registration ${result.registered ? "confirmed" : "pending"} for agent ${result.agentId}`
      );
    }
    return result;
  } catch (e) {
    console.log("[hive]", `registerAgent error (non-fatal): ${getErrorMessage(e)}`);
    return null;
  }
}

// ─── Original-Compatible Push Functions ────────────────────────────

/**
 * Push a single lesson to the Hive Mind server.
 *
 * Fail-open: logs and returns null on any error.
 * Does NOT replace the legacy syncToHive batch path in Phase 1.
 */
export async function pushLesson(params: {
  agentId: string;
  rule: string;
  tags: string[];
  outcome: string;
  context?: string;
}): Promise<PushResponse | null> {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const payload = buildLessonPayload(params);
    const url = `${cfg.hiveMindUrl.replace(/\/+$/, "")}/api/hivemind/lessons`;

    return await hivePost<PushResponse>(url, cfg.hiveMindApiKey, payload, POST_TIMEOUT_MS);
  } catch (e) {
    console.log("[hive]", `pushLesson error (non-fatal): ${getErrorMessage(e)}`);
    return null;
  }
}

/**
 * Push a performance record to the Hive Mind server.
 *
 * Fail-open: logs and returns null on any error.
 * Does NOT replace the legacy syncToHive batch path in Phase 1.
 */
export async function pushPerformance(params: {
  agentId: string;
  poolAddress: string;
  pnlPct: number;
  pnlUsd: number;
  holdTimeMinutes: number;
  closeReason: string;
  rangeEfficiency?: number;
  strategy?: string;
}): Promise<PushResponse | null> {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const payload = buildPerformancePayload(params);
    const url = `${cfg.hiveMindUrl.replace(/\/+$/, "")}/api/hivemind/performance`;

    return await hivePost<PushResponse>(url, cfg.hiveMindApiKey, payload, POST_TIMEOUT_MS);
  } catch (e) {
    console.log("[hive]", `pushPerformance error (non-fatal): ${getErrorMessage(e)}`);
    return null;
  }
}

// ─── Legacy Registration (preserved for backward compatibility) ────

/**
 * One-time registration with a Hive Mind server.
 * IMPORTANT: You must manually add HIVE_MIND_URL, HIVE_MIND_API_KEY, and HIVE_MIND_AGENT_ID to your .env file.
 * @param url - Base URL of the hive server (e.g. "https://hive.example.com")
 * @param registrationToken - Token provided by the hive operator
 * @returns The raw API key (shown once, save it to .env!)
 *
 * @legacy This uses the legacy /api/register endpoint and Authorization: Bearer header.
 *         For new code, prefer registerAgent() which uses the original-compatible contract.
 * @deprecated Phase 4: Legacy registration path. Prefer registerAgent() for new code.
 *             This function is preserved for backward compatibility.
 */
export async function register(url: string, registrationToken: string): Promise<string> {
  warnDeprecation("register");
  recordPathUsage("legacy_register");

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
  console.log("[hive]", `Registered! agent_id=${agent_id}`);

  const nodeFs = await import("node:fs");
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");
  const tmpFile = nodePath.join(nodeOs.tmpdir(), `hive-api-key-${agent_id}.txt`);
  nodeFs.writeFileSync(tmpFile, api_key, { mode: 0o600 });

  console.log("[hive]", "IMPORTANT: Add the following to your .env file:");
  console.log("[hive]", `  HIVE_MIND_URL=${baseUrl}`);
  console.log("[hive]", `  HIVE_MIND_API_KEY=<see ${tmpFile}>`);
  console.log("[hive]", `  HIVE_MIND_AGENT_ID=${agent_id}`);
  console.log(
    "[hive]",
    `Full API key saved to: ${tmpFile} (restricted perms, delete after copying)`
  );

  return api_key;
}

// ─── Legacy Sync (preserved for backward compatibility) ────────

/**
 * Batch-upload local data to the hive mind server.
 * Debounced (5 min), fire-and-forget, never throws.
 *
 * Phase 2 migration guard: this function is now DISABLED by default
 * to prevent duplicate sends. Event-driven pushes (pushLesson,
 * pushPerformance) deliver the same data in real time. Set
 * HIVE_MIND_LEGACY_BATCH_SYNC=true in .env to re-enable.
 *
 * @deprecated Phase 4: Legacy batch sync path. Prefer event-driven pushes
 *             (pushLesson, pushPerformance). This function is preserved for
 *             backward compatibility and is a no-op by default.
 */
export async function syncToHive(): Promise<void> {
  try {
    warnDeprecation("syncToHive");

    // Phase 2 guard: skip legacy batch sync when event-driven pushes
    // are active (the default). Prevents duplicate sends.
    if (!isLegacyBatchSyncEnabled()) {
      return;
    }

    recordPathUsage("legacy_batch_sync");

    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return;

    const now = Date.now();
    if (now - _lastSyncTime < SYNC_DEBOUNCE_MS) return;

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
      volatility: d.volatility_at_deploy ?? undefined,
      base_mint: d.base_mint ?? undefined,
    }));

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

    let agentStats: import("../../types/lessons.js").PerformanceMetrics | null = null;
    try {
      const { getPerformanceSummary } = await import("../../domain/lessons.js");
      agentStats = getPerformanceSummary();
    } catch (e) {
      console.log("[hive]", `Could not load agent stats: ${getErrorMessage(e)}`);
    }

    setLastSyncTime(now);

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
 * Non-blocking startup bootstrap sync.
 * Fires a sync in the background without awaiting it.
 * Never throws — errors are caught and logged internally.
 * Safe to call at app startup; failure does not block or crash the app.
 *
 * Note: No-ops when HIVE_MIND_LEGACY_BATCH_SYNC is not set (Phase 2 default).
 *
 * @deprecated Phase 4: Legacy bootstrap sync. Prefer event-driven pushes.
 *             This function is preserved for backward compatibility.
 */
export function bootstrapSync(): void {
  warnDeprecation("bootstrapSync");
  if (!isEnabled()) return;
  if (!isLegacyBatchSyncEnabled()) {
    console.log(
      "[hive]",
      "Bootstrap sync skipped — legacy batch disabled (event-driven pushes active)"
    );
    return;
  }

  console.log("[hive]", "Bootstrap sync starting (non-blocking)...");
  recordPathUsage("legacy_batch_sync");
  syncToHive().catch((e) => {
    console.log("[hive]", `Bootstrap sync failed (non-fatal): ${getErrorMessage(e)}`);
  });
}

/**
 * Periodic heartbeat — syncs local data to the hive and logs pulse status.
 * Called from cron on a regular interval. Never throws.
 *
 * Phase 2: only runs batch sync when HIVE_MIND_LEGACY_BATCH_SYNC=true.
 * Pulse check always runs (independent of legacy batch setting).
 */
export async function heartbeat(): Promise<void> {
  if (!isEnabled()) return;

  try {
    // Only run legacy batch sync when explicitly enabled
    if (isLegacyBatchSyncEnabled()) {
      await syncToHive();
    }

    const pulse = await getHivePulse();
    if (pulse) {
      console.log(
        "[hive]",
        `Heartbeat OK — ${pulse.active_agents_24h}/${pulse.total_agents} active agents, consensus ${pulse.consensus_strength}%`
      );
    }
  } catch (e) {
    console.log("[hive]", `Heartbeat error (non-fatal): ${getErrorMessage(e)}`);
  }
}
