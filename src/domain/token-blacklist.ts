/**
 * Token blacklist — mints the agent should never deploy into.
 *
 * Agent can blacklist via Telegram ("blacklist this token, it rugged").
 * Screening filters blacklisted tokens before passing pools to the LLM.
 */

import fs from "node:fs";
import { registerTool } from "../../tools/registry.js";
import { log } from "../infrastructure/logger.js";
import type { BlacklistDB, BlacklistEntry } from "../types/blocklist.js";

const BLACKLIST_FILE = "./token-blacklist.json";

function load(): BlacklistDB {
  if (!fs.existsSync(BLACKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8")) as BlacklistDB;
  } catch {
    return {};
  }
}

function save(data: BlacklistDB): void {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

// ─── Check ─────────────────────────────────────────────────────

/**
 * Returns true if the mint is on the blacklist.
 * Used in screening.js before returning pools to the LLM.
 */
export function isBlacklisted(mint: string): boolean {
  if (!mint) return false;
  const db = load();
  return !!db[mint];
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Tool handler: add_to_blacklist
 */
export function addToBlacklist({
  mint,
  symbol,
  reason,
}: {
  mint: string;
  symbol?: string;
  reason?: string;
}):
  | { blacklisted: true; mint: string; symbol: string; reason: string }
  | { already_blacklisted: true; mint: string; symbol: string; reason: string }
  | { error: string } {
  if (!mint) return { error: "mint required" };

  const db = load();

  if (db[mint]) {
    return {
      already_blacklisted: true,
      mint,
      symbol: db[mint].symbol,
      reason: db[mint].reason,
    };
  }

  db[mint] = {
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
    added_by: "agent",
  };

  save(db);
  log("blacklist", `Blacklisted ${symbol || mint}: ${reason}`);
  return {
    blacklisted: true,
    mint,
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
  };
}

/**
 * Tool handler: remove_from_blacklist
 */
export function removeFromBlacklist({
  mint,
}: {
  mint: string;
}): { removed: true; mint: string; was: BlacklistEntry } | { error: string } {
  if (!mint) return { error: "mint required" };

  const db = load();

  if (!db[mint]) {
    return { error: `Mint ${mint} not found on blacklist` };
  }

  const entry = db[mint];
  delete db[mint];
  save(db);
  log("blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

/**
 * Tool handler: list_blacklist
 */
export function listBlacklist(): {
  count: number;
  blacklist: Array<BlacklistEntry & { mint: string }>;
} {
  const db = load();
  const entries = Object.entries(db).map(([mint, info]) => ({
    mint,
    ...info,
  }));

  return {
    count: entries.length,
    blacklist: entries,
  };
}

// Tool registrations
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
