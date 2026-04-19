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

// ─── Phase 4: Strict Compatibility Flag ───────────────────────────
//
// When HIVE_MIND_STRICT_COMPAT=true, the adapters disable legacy
// fallback paths and require pull-based data sources exclusively.
// This is opt-in only (default false) so existing consumers keep
// working without changes.
//

/**
 * Check whether strict compatibility mode is enabled.
 *
 * When true, adapter fallbacks to legacy consensus read paths are
 * disabled. Only pull-based endpoints are used. If pull data is
 * unavailable, the adapter returns empty rather than falling back.
 *
 * Opt-in only: set HIVE_MIND_STRICT_COMPAT=true in .env.
 */
export function isStrictCompatEnabled(): boolean {
  return process.env.HIVE_MIND_STRICT_COMPAT === "true";
}

// ─── Phase 4: Path Telemetry ──────────────────────────────────────

/** Path-type identifiers used in telemetry. */
export type PathType =
  | "pull"
  | "legacy_consensus"
  | "legacy_batch_sync"
  | "legacy_pulse"
  | "legacy_register";

interface PathTelemetryEntry {
  pathType: PathType;
  lastUsed: number;
  useCount: number;
}

const _pathTelemetry = new Map<PathType, PathTelemetryEntry>();

/**
 * Record that a specific path type was used.
 * Called internally by adapters, sync, and consensus functions.
 */
export function recordPathUsage(pathType: PathType): void {
  const existing = _pathTelemetry.get(pathType);
  if (existing) {
    existing.lastUsed = Date.now();
    existing.useCount++;
  } else {
    _pathTelemetry.set(pathType, { pathType, lastUsed: Date.now(), useCount: 1 });
  }
}

/**
 * Get a snapshot of all recorded path usage telemetry.
 * Returns a plain object keyed by PathType with lastUsed and useCount.
 */
export function getPathTelemetry(): Record<string, { lastUsed: number; useCount: number }> {
  const result: Record<string, { lastUsed: number; useCount: number }> = {};
  for (const [key, entry] of _pathTelemetry) {
    result[key] = { lastUsed: entry.lastUsed, useCount: entry.useCount };
  }
  return result;
}

/**
 * Get a human-readable summary of active path types.
 * A path is considered "active" if used within the last 30 minutes.
 */
export function getActivePathsSummary(): string[] {
  const now = Date.now();
  const THIRTY_MIN = 30 * 60 * 1000;
  const active: string[] = [];

  for (const [key, entry] of _pathTelemetry) {
    if (now - entry.lastUsed < THIRTY_MIN) {
      active.push(`${key} (${entry.useCount} uses)`);
    }
  }

  return active;
}

/**
 * Reset all telemetry state (useful for tests).
 */
export function resetPathTelemetry(): void {
  _pathTelemetry.clear();
}

// ─── Phase 4: One-Time Deprecation Warnings ───────────────────────

const _deprecationWarned = new Set<string>();

/**
 * Emit a one-time deprecation warning for the given API name.
 * Only logs once per process lifetime per API name.
 */
export function warnDeprecation(apiName: string): void {
  if (_deprecationWarned.has(apiName)) return;
  _deprecationWarned.add(apiName);
  console.log(
    "[hive][deprecation]",
    `${apiName}() is a legacy HiveMind API. Prefer pull-based endpoints for new code. (This warning prints once.)`
  );
}

/**
 * Reset deprecation warning state (for tests only).
 */
export function resetDeprecationWarnings(): void {
  _deprecationWarned.clear();
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
