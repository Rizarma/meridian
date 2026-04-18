import { getSharedConnection } from "../infrastructure/connection.js";
import {
  getActivePathsSummary,
  getPathTelemetry,
  isEnabled as isHiveMindEnabled,
  isLegacyBatchSyncEnabled,
  isStrictCompatEnabled,
} from "../infrastructure/hive-mind.js";
import { log } from "../infrastructure/logger.js";
import { getWallet } from "../utils/wallet.js";
import { getErrorMessage } from "./errors.js";

export interface HealthStatus {
  healthy: boolean;
  checks: {
    rpc: { healthy: boolean; latencyMs: number; error?: string };
    wallet: { healthy: boolean; error?: string };
    jupiter: { healthy: boolean; latencyMs: number; error?: string };
    helius: { healthy: boolean; latencyMs: number; error?: string };
    datapi: { healthy: boolean; latencyMs: number; error?: string };
  };
  hiveMind: {
    enabled: boolean;
    strictCompat: boolean;
    legacyBatchSync: boolean;
    configured: boolean;
    activePaths: string[];
    pathTelemetry: Record<string, { lastUsed: number; useCount: number }>;
  };
  lastActivity: number; // timestamp
  uptimeSeconds: number;
}

let _lastActivity = Date.now();
const _startTime = Date.now();

/**
 * Record activity to track liveness
 */
export function recordActivity(): void {
  _lastActivity = Date.now();
}

/**
 * Check RPC connection health
 */
async function checkRpc(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const connection = getSharedConnection();
    await connection.getSlot();
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: getErrorMessage(error),
    };
  }
}

/**
 * Check wallet accessibility
 */
function checkWallet(): { healthy: boolean; error?: string } {
  try {
    const wallet = getWallet();
    if (!wallet.publicKey) {
      return { healthy: false, error: "Wallet has no public key" };
    }
    return { healthy: true };
  } catch (error) {
    return { healthy: false, error: getErrorMessage(error) };
  }
}

/**
 * Check external API health
 */
async function checkApi(
  _name: string,
  url: string,
  timeoutMs = 5000
): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Accept 200-499 (some APIs return 404 on HEAD but are healthy)
    if (res.status < 500) {
      return { healthy: true, latencyMs: Date.now() - start };
    }

    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: `HTTP ${res.status}`,
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: getErrorMessage(error),
    };
  }
}

/**
 * Build HiveMind status info for health check output.
 * Phase 4: Reports configuration + path telemetry without pretending
 * server capabilities exist. All info is locally derived.
 */
function buildHiveMindStatus(): HealthStatus["hiveMind"] {
  const enabled = isHiveMindEnabled();
  const configured = Boolean(process.env.HIVE_MIND_URL && process.env.HIVE_MIND_API_KEY);

  return {
    enabled,
    strictCompat: isStrictCompatEnabled(),
    legacyBatchSync: isLegacyBatchSyncEnabled(),
    configured,
    activePaths: enabled ? getActivePathsSummary() : [],
    pathTelemetry: enabled ? getPathTelemetry() : {},
  };
}

/**
 * Run full health check
 */
export async function runHealthCheck(): Promise<HealthStatus> {
  const heliusKey = process.env.HELIUS_API_KEY;
  const heliusUrl = heliusKey
    ? `https://api.helius.xyz/v0/status?api-key=${heliusKey}`
    : "https://api.helius.xyz/v0/status";

  const [rpc, wallet, jupiter, helius, datapi] = await Promise.all([
    checkRpc(),
    Promise.resolve(checkWallet()),
    checkApi("jupiter", "https://api.jup.ag/price/v3"),
    checkApi("helius", heliusUrl),
    checkApi("datapi", "https://api.datapi.xyz/health"),
  ]);

  const allHealthy =
    rpc.healthy && wallet.healthy && jupiter.healthy && helius.healthy && datapi.healthy;

  const status: HealthStatus = {
    healthy: allHealthy,
    checks: {
      rpc,
      wallet,
      jupiter,
      helius,
      datapi,
    },
    hiveMind: buildHiveMindStatus(),
    lastActivity: _lastActivity,
    uptimeSeconds: Math.floor((Date.now() - _startTime) / 1000),
  };

  if (!allHealthy) {
    log("health", `Health check failed: ${JSON.stringify(status.checks)}`);
  }

  return status;
}

/**
 * Check if system is stuck (no activity for threshold)
 */
export function isSystemStuck(thresholdMs = 5 * 60 * 1000): boolean {
  return Date.now() - _lastActivity > thresholdMs;
}

/**
 * Format health status for display
 */
export function formatHealthStatus(status: HealthStatus): string {
  const lines = [
    `Health: ${status.healthy ? "✅ HEALTHY" : "❌ UNHEALTHY"}`,
    `Uptime: ${Math.floor(status.uptimeSeconds / 60)}m`,
    `Last Activity: ${Math.floor((Date.now() - status.lastActivity) / 1000)}s ago`,
    "",
    "Checks:",
    `  RPC: ${status.checks.rpc.healthy ? "✅" : "❌"} ${status.checks.rpc.latencyMs}ms`,
    `  Wallet: ${status.checks.wallet.healthy ? "✅" : "❌"}`,
    `  Jupiter: ${status.checks.jupiter.healthy ? "✅" : "❌"} ${status.checks.jupiter.latencyMs}ms`,
    `  Helius: ${status.checks.helius.healthy ? "✅" : "❌"} ${status.checks.helius.latencyMs}ms`,
    `  Datapi: ${status.checks.datapi.healthy ? "✅" : "❌"} ${status.checks.datapi.latencyMs}ms`,
    "",
    "HiveMind:",
    `  Enabled: ${status.hiveMind.enabled ? "✅" : "❌"}`,
    `  Configured: ${status.hiveMind.configured ? "✅" : "❌"}`,
    `  Strict Compat: ${status.hiveMind.strictCompat ? "ON" : "off (default)"}`,
    `  Legacy Batch Sync: ${status.hiveMind.legacyBatchSync ? "ON" : "off (default)"}`,
  ];

  if (status.hiveMind.activePaths.length > 0) {
    lines.push(`  Active Paths: ${status.hiveMind.activePaths.join(", ")}`);
  } else if (status.hiveMind.enabled) {
    lines.push("  Active Paths: (none yet this session)");
  } else {
    lines.push("  Active Paths: (disabled)");
  }

  return lines.join("\n");
}

/**
 * Get a concise HiveMind-only status summary.
 * Useful for quick diagnostics without running a full health check.
 * Phase 4: Provides configuration + path telemetry at a glance.
 */
export function getHiveMindStatus(): {
  enabled: boolean;
  configured: boolean;
  strictCompat: boolean;
  legacyBatchSync: boolean;
  activePaths: string[];
  pathTelemetry: Record<string, { lastUsed: number; useCount: number }>;
} {
  return buildHiveMindStatus();
}
