/**
 * Dev (deployer) blocklist — deployer wallet addresses that should never be deployed into.
 *
 * Agent/user can add deployers via Telegram ("block this deployer").
 * Screening hard-filters any pool whose base token was deployed by a blocked wallet
 * before the pool list reaches the LLM.
 *
 * NOTE: Migrated from JSON to SQLite for data persistence across deployments.
 */

import { registerTool } from "../../tools/registry.js";
import { getInfrastructure } from "../di-container.js";
import { log } from "../infrastructure/logger.js";
import type { BlockedDev } from "../types/blocklist.js";

const infra = () => getInfrastructure();

// ═══════════════════════════════════════════════════════════════════════════
// Database Types
// ═══════════════════════════════════════════════════════════════════════════

interface DevBlocklistRow {
  wallet: string;
  label: string;
  reason: string;
  added_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a deployer wallet is blocked.
 */
export async function isDevBlocked(devWallet: string): Promise<boolean> {
  if (!devWallet) return false;
  const row = await infra().db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM dev_blocklist WHERE wallet = ?",
    devWallet
  );
  return (row?.count ?? 0) > 0;
}

/**
 * Get a single blocked dev entry.
 */
export async function getBlockedDevEntry(wallet: string): Promise<(BlockedDev & { wallet: string }) | null> {
  if (!wallet) return null;
  const row = await infra().db.get<DevBlocklistRow>("SELECT * FROM dev_blocklist WHERE wallet = ?", wallet);
  if (!row) return null;
  return {
    wallet: row.wallet,
    label: row.label,
    reason: row.reason,
    added_at: row.added_at,
  };
}

/**
 * Get all blocked devs as a record (for compatibility with old API).
 */
export async function getBlockedDevs(): Promise<Record<string, BlockedDev>> {
  const rows = await infra().db.query<DevBlocklistRow>("SELECT * FROM dev_blocklist");
  const result: Record<string, BlockedDev> = {};
  for (const row of rows) {
    result[row.wallet] = {
      label: row.label,
      reason: row.reason,
      added_at: row.added_at,
    };
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Handlers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tool handler: block_deployer
 */
export async function blockDev({
  wallet,
  reason,
  label,
}: {
  wallet: string;
  reason?: string;
  label?: string;
}): Promise<
  | { blocked: boolean; wallet: string; label?: string; reason?: string }
  | { already_blocked: boolean; wallet: string; label: string; reason: string }
  | { error: string }
> {
  if (!wallet) return { error: "wallet required" };

  // Check if already blocked
  const existing = await getBlockedDevEntry(wallet);
  if (existing) {
    return {
      already_blocked: true,
      wallet,
      label: existing.label,
      reason: existing.reason,
    };
  }

  const entry = {
    wallet,
    label: label || "unknown",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
  };

  try {
    await infra().db.run(
      "INSERT INTO dev_blocklist (wallet, label, reason, added_at) VALUES (?, ?, ?, ?)",
      entry.wallet,
      entry.label,
      entry.reason,
      entry.added_at
    );
    log("dev_blocklist", `Blocked deployer ${entry.label} (${wallet}): ${entry.reason}`);
    return { blocked: true, wallet, label: entry.label, reason: entry.reason };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("dev_blocklist_error", `Failed to block deployer ${wallet}: ${errorMsg}`);
    return { error: `Failed to block deployer: ${errorMsg}` };
  }
}

/**
 * Tool handler: unblock_deployer
 */
export async function unblockDev({
  wallet,
}: {
  wallet: string;
}): Promise<{ unblocked: boolean; wallet: string; was: BlockedDev } | { error: string }> {
  if (!wallet) return { error: "wallet required" };

  const existing = await getBlockedDevEntry(wallet);
  if (!existing) {
    return { error: `Wallet ${wallet} not on dev blocklist` };
  }

  try {
    await infra().db.run("DELETE FROM dev_blocklist WHERE wallet = ?", wallet);
    log("dev_blocklist", `Removed deployer ${existing.label} (${wallet}) from blocklist`);
    return {
      unblocked: true,
      wallet,
      was: {
        label: existing.label,
        reason: existing.reason,
        added_at: existing.added_at,
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("dev_blocklist_error", `Failed to unblock deployer ${wallet}: ${errorMsg}`);
    return { error: `Failed to unblock deployer: ${errorMsg}` };
  }
}

/**
 * Tool handler: list_blocked_deployers
 */
export async function listBlockedDevs(): Promise<{
  count: number;
  blocked_devs: Array<BlockedDev & { wallet: string }>;
}> {
  const rows = await infra().db.query<DevBlocklistRow>("SELECT * FROM dev_blocklist ORDER BY added_at DESC");

  const entries = rows.map((row) => ({
    wallet: row.wallet,
    label: row.label,
    reason: row.reason,
    added_at: row.added_at,
  }));

  return { count: entries.length, blocked_devs: entries };
}

/**
 * Clear all blocked devs (useful for testing).
 */
export async function clearDevBlocklist(): Promise<{ cleared: number }> {
  const result = await infra().db.run("DELETE FROM dev_blocklist");
  log("dev_blocklist", `Cleared ${result.changes} blocked deployers`);
  return { cleared: Number(result.changes) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Registrations
// ═══════════════════════════════════════════════════════════════════════════

registerTool({
  name: "block_deployer",
  handler: blockDev,
  roles: ["GENERAL"],
});

registerTool({
  name: "unblock_deployer",
  handler: unblockDev,
  roles: ["GENERAL"],
});

registerTool({
  name: "list_blocked_deployers",
  handler: listBlockedDevs,
  roles: ["GENERAL"],
});
