import { getWallet } from "../../tools/wallet.js";
import { getSharedConnection } from "../infrastructure/connection.js";
import { log } from "../infrastructure/logger.js";
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
 * Run full health check
 */
export async function runHealthCheck(): Promise<HealthStatus> {
  const [rpc, wallet, jupiter, helius, datapi] = await Promise.all([
    checkRpc(),
    Promise.resolve(checkWallet()),
    checkApi("jupiter", "https://api.jup.ag/price/v3"),
    checkApi("helius", "https://api.helius.xyz/v0/status"),
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
  ];

  return lines.join("\n");
}
