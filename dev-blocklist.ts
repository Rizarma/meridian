/**
 * Dev (deployer) blocklist — deployer wallet addresses that should never be deployed into.
 *
 * Agent/user can add deployers via Telegram ("block this deployer").
 * Screening hard-filters any pool whose base token was deployed by a blocked wallet
 * before the pool list reaches the LLM.
 */

import fs from "fs";
import { log } from "./logger.js";
import type { BlockedDev, DevBlocklistDB } from "./types/blocklist.d.ts";

const BLOCKLIST_FILE = "./dev-blocklist.json";

function load(): DevBlocklistDB {
  if (!fs.existsSync(BLOCKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLOCKLIST_FILE, "utf8")) as DevBlocklistDB;
  } catch {
    return {};
  }
}

function save(data: DevBlocklistDB): void {
  fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify(data, null, 2));
}

export function isDevBlocked(devWallet: string): boolean {
  if (!devWallet) return false;
  return !!load()[devWallet];
}

export function getBlockedDevs(): DevBlocklistDB {
  return load();
}

export function blockDev({
  wallet,
  reason,
  label,
}: {
  wallet: string;
  reason?: string;
  label?: string;
}):
  | { blocked: boolean; wallet: string; label?: string; reason?: string }
  | { already_blocked: boolean; wallet: string; label: string; reason: string }
  | { error: string } {
  if (!wallet) return { error: "wallet required" };
  const db = load();
  if (db[wallet])
    return {
      already_blocked: true,
      wallet,
      label: db[wallet].label,
      reason: db[wallet].reason,
    };
  db[wallet] = {
    label: label || "unknown",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
  };
  save(db);
  log("dev_blocklist", `Blocked deployer ${label || wallet}: ${reason}`);
  return { blocked: true, wallet, label, reason };
}

export function unblockDev({
  wallet,
}: {
  wallet: string;
}): { unblocked: boolean; wallet: string; was: BlockedDev } | { error: string } {
  if (!wallet) return { error: "wallet required" };
  const db = load();
  if (!db[wallet]) return { error: `Wallet ${wallet} not on dev blocklist` };
  const entry = db[wallet];
  delete db[wallet];
  save(db);
  log("dev_blocklist", `Removed deployer ${entry.label || wallet} from blocklist`);
  return { unblocked: true, wallet, was: entry };
}

export function listBlockedDevs(): {
  count: number;
  blocked_devs: Array<BlockedDev & { wallet: string }>;
} {
  const db = load();
  const entries = Object.entries(db).map(([wallet, info]) => ({
    wallet,
    ...info,
  }));
  return { count: entries.length, blocked_devs: entries };
}
