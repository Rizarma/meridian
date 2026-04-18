/**
 * Hive Mind — configuration and constants.
 *
 * Centralises all env-only config reads and module-level constants
 * so other hive-mind modules share a single source of truth.
 */

import { config } from "../../config/config.js";
import { HIVE_MIND } from "../../config/constants.js";
import type { HiveMindConfig } from "../../types/hive-mind.js";

// ─── Timeouts & Limits ────────────────────────────────────────────

export const SYNC_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
export const GET_TIMEOUT_MS = 5_000;
export const POST_TIMEOUT_MS = 10_000;
export const MIN_AGENTS_FOR_CONSENSUS = 3;
export const MAX_CONSENSUS_CHARS = 500;
export const MAX_THRESHOLD_ADVISORY_CHARS = 300;
export const MAX_SHARED_LESSONS = 5;
export const MAX_SHARED_LESSON_CHARS = 400;
export const MIN_AGENTS_THRESHOLD_ADVISORY = 3;

// ─── Re-exported constants from central config ────────────────────

export const CONSENSUS_CACHE_TTL_MS = HIVE_MIND.CONSENSUS_CACHE_TTL_MS;

// ─── Cache Key Prefixes ───────────────────────────────────────────

export const CACHE_KEY = {
  POOL: "hive:pool:",
  LESSON: "hive:lesson:",
  PATTERN: "hive:pattern:",
  THRESHOLD: "hive:threshold:",
} as const;

// ─── Debounce State ───────────────────────────────────────────────

export let _lastSyncTime = 0;
export function setLastSyncTime(t: number): void {
  _lastSyncTime = t;
}

// ─── Config Reader ────────────────────────────────────────────────

/**
 * Read Hive Mind config from environment variables ONLY.
 * SECURITY: Never reads from user-config.json.
 */
export function readConfig(): HiveMindConfig {
  return {
    hiveMindUrl: process.env.HIVE_MIND_URL || "",
    hiveMindApiKey: process.env.HIVE_MIND_API_KEY || "",
    hiveMindAgentId: process.env.HIVE_MIND_AGENT_ID || "",
    hiveMindLegacyBatchSync: process.env.HIVE_MIND_LEGACY_BATCH_SYNC === "true",
  };
}

/**
 * Check whether Hive Mind is configured and enabled.
 */
export function isEnabled(): boolean {
  if (!config.features.hiveMind) return false;
  const cfg = readConfig();
  return Boolean(cfg.hiveMindUrl && cfg.hiveMindApiKey);
}

/**
 * Check whether legacy batch syncToHive() is explicitly enabled.
 *
 * Phase 2 migration guard — defaults to false because event-driven
 * pushes (pushLesson/pushPerformance) now deliver the same data in
 * real time. Set HIVE_MIND_LEGACY_BATCH_SYNC=true in .env to
 * re-enable the batch path (e.g. for rollback or dual-write testing).
 *
 * When false, syncToHive() returns immediately (no-op). This prevents
 * duplicate sends between event-driven pushes and the legacy batch path.
 */
export function isLegacyBatchSyncEnabled(): boolean {
  const cfg = readConfig();
  return cfg.hiveMindLegacyBatchSync === true;
}
