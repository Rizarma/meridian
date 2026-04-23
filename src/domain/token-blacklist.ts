/**
 * Token blacklist — mints the agent should never deploy into.
 *
 * Agent can blacklist via Telegram ("blacklist this token, it rugged").
 * Screening filters blacklisted tokens before passing pools to the LLM.
 *
 * NOTE: Migrated from JSON to SQLite for data persistence across deployments.
 */

import { registerTool } from "../../tools/registry.js";
import { getInfrastructure } from "../di-container.js";
import { log } from "../infrastructure/logger.js";
import type { BlacklistEntry } from "../types/blocklist.js";

const infra = () => getInfrastructure();

// ═══════════════════════════════════════════════════════════════════════════
// Database Types
// ═══════════════════════════════════════════════════════════════════════════

interface TokenBlacklistRow {
  mint: string;
  symbol: string;
  reason: string;
  added_at: string;
  added_by: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns true if the mint is on the blacklist.
 * Used in screening.js before returning pools to the LLM.
 */
export async function isBlacklisted(mint: string): Promise<boolean> {
  if (!mint) return false;
  const row = await infra().db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM token_blacklist WHERE mint = ?",
    mint
  );
  return (row?.count ?? 0) > 0;
}

/**
 * Get a single blacklist entry.
 */
export async function getBlacklistEntry(mint: string): Promise<(BlacklistEntry & { mint: string }) | null> {
  if (!mint) return null;
  const row = await infra().db.get<TokenBlacklistRow>("SELECT * FROM token_blacklist WHERE mint = ?", mint);
  if (!row) return null;
  return {
    mint: row.mint,
    symbol: row.symbol,
    reason: row.reason,
    added_at: row.added_at,
    added_by: row.added_by,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Handlers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tool handler: add_to_blacklist
 */
export async function addToBlacklist({
  mint,
  symbol,
  reason,
}: {
  mint: string;
  symbol?: string;
  reason?: string;
}): Promise<
  | { blacklisted: true; mint: string; symbol: string; reason: string }
  | { already_blacklisted: true; mint: string; symbol: string; reason: string }
  | { error: string }
> {
  if (!mint) return { error: "mint required" };

  // Check if already blacklisted
  const existing = await getBlacklistEntry(mint);
  if (existing) {
    return {
      already_blacklisted: true,
      mint,
      symbol: existing.symbol,
      reason: existing.reason,
    };
  }

  const entry = {
    mint,
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
    added_by: "agent",
  };

  try {
    await infra().db.run(
      "INSERT INTO token_blacklist (mint, symbol, reason, added_at, added_by) VALUES (?, ?, ?, ?, ?)",
      entry.mint,
      entry.symbol,
      entry.reason,
      entry.added_at,
      entry.added_by
    );
    log("blacklist", `Blacklisted ${entry.symbol} (${mint}): ${entry.reason}`);
    return {
      blacklisted: true,
      mint,
      symbol: entry.symbol,
      reason: entry.reason,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("blacklist_error", `Failed to blacklist ${mint}: ${errorMsg}`);
    return { error: `Failed to blacklist: ${errorMsg}` };
  }
}

/**
 * Tool handler: remove_from_blacklist
 */
export async function removeFromBlacklist({
  mint,
}: {
  mint: string;
}): Promise<{ removed: true; mint: string; was: BlacklistEntry } | { error: string }> {
  if (!mint) return { error: "mint required" };

  const existing = await getBlacklistEntry(mint);
  if (!existing) {
    return { error: `Mint ${mint} not found on blacklist` };
  }

  try {
    await infra().db.run("DELETE FROM token_blacklist WHERE mint = ?", mint);
    log("blacklist", `Removed ${existing.symbol} (${mint}) from blacklist`);
    return {
      removed: true,
      mint,
      was: {
        symbol: existing.symbol,
        reason: existing.reason,
        added_at: existing.added_at,
        added_by: existing.added_by,
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("blacklist_error", `Failed to remove ${mint} from blacklist: ${errorMsg}`);
    return { error: `Failed to remove from blacklist: ${errorMsg}` };
  }
}

/**
 * Tool handler: list_blacklist
 */
export async function listBlacklist(): Promise<{
  count: number;
  blacklist: Array<BlacklistEntry & { mint: string }>;
}> {
  const rows = await infra().db.query<TokenBlacklistRow>("SELECT * FROM token_blacklist ORDER BY added_at DESC");

  const entries = rows.map((row) => ({
    mint: row.mint,
    symbol: row.symbol,
    reason: row.reason,
    added_at: row.added_at,
    added_by: row.added_by,
  }));

  return {
    count: entries.length,
    blacklist: entries,
  };
}

/**
 * Clear all blacklist entries (useful for testing).
 */
export async function clearBlacklist(): Promise<{ cleared: number }> {
  const result = await infra().db.run("DELETE FROM token_blacklist");
  log("blacklist", `Cleared ${result.changes} blacklist entries`);
  return { cleared: Number(result.changes) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Registrations
// ═══════════════════════════════════════════════════════════════════════════

registerTool({
  name: "add_to_blacklist",
  handler: addToBlacklist,
  roles: ["GENERAL"],
});

registerTool({
  name: "remove_from_blacklist",
  handler: removeFromBlacklist,
  roles: ["GENERAL"],
});

registerTool({
  name: "list_blacklist",
  handler: listBlacklist,
  roles: ["GENERAL"],
});
