/**
 * Smart Wallets — track KOL/alpha wallets for signal detection.
 *
 * Wallets are checked during screening to see if they're in a pool.
 * Provides confidence boost when smart money is already positioned.
 *
 * NOTE: Migrated from JSON to SQLite for data persistence across deployments.
 */

import { registerTool } from "../../tools/registry.js";
import { get, query, run } from "../infrastructure/db.js";
import { log } from "../infrastructure/logger.js";
import type {
  AddSmartWalletInput,
  CachedWalletPositions,
  CheckSmartWalletsInput,
  RemoveSmartWalletInput,
  SmartWalletList,
  SmartWalletResult,
  WalletCategory,
  WalletInPool,
  WalletPositionCheck,
  WalletType,
} from "../types/smart-wallets.js";

// ═══════════════════════════════════════════════════════════════════════════
// Database Types
// ═══════════════════════════════════════════════════════════════════════════

interface SmartWalletRow {
  address: string;
  name: string;
  category: string;
  type: string;
  added_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const SOLANA_PUBKEY_RE: RegExp = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Cache wallet positions for 5 minutes to avoid hammering RPC
const _cache: Map<string, CachedWalletPositions> = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// Core Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Add a smart wallet to track.
 */
export function addSmartWallet({
  name,
  address,
  category = "alpha",
  type = "lp",
}: AddSmartWalletInput): SmartWalletResult {
  if (!SOLANA_PUBKEY_RE.test(address)) {
    return { success: false, error: "Invalid Solana address format" };
  }

  // Check if already exists
  const existing = get<SmartWalletRow>("SELECT * FROM smart_wallets WHERE address = ?", address);
  if (existing) {
    return { success: false, error: `Already tracked as "${existing.name}"` };
  }

  try {
    run(
      "INSERT INTO smart_wallets (address, name, category, type, added_at) VALUES (?, ?, ?, ?, ?)",
      address,
      name,
      category,
      type,
      new Date().toISOString()
    );
    log("smart_wallets", `Added wallet: ${name} (${category}, type=${type})`);
    return {
      success: true,
      wallet: {
        name,
        address,
        category: category as WalletCategory,
        type: type as WalletType,
        addedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("smart_wallets_error", `Failed to add wallet ${address}: ${errorMsg}`);
    return { success: false, error: `Failed to add wallet: ${errorMsg}` };
  }
}

/**
 * Remove a tracked smart wallet.
 */
export function removeSmartWallet({ address }: RemoveSmartWalletInput): SmartWalletResult {
  const existing = get<SmartWalletRow>("SELECT * FROM smart_wallets WHERE address = ?", address);
  if (!existing) {
    return { success: false, error: "Wallet not found" };
  }

  try {
    run("DELETE FROM smart_wallets WHERE address = ?", address);
    log("smart_wallets", `Removed wallet: ${existing.name}`);
    return { success: true, removed: existing.name };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("smart_wallets_error", `Failed to remove wallet ${address}: ${errorMsg}`);
    return { success: false, error: `Failed to remove wallet: ${errorMsg}` };
  }
}

/**
 * List all tracked smart wallets.
 */
export function listSmartWallets(): SmartWalletList {
  const rows = query<SmartWalletRow>("SELECT * FROM smart_wallets ORDER BY added_at DESC");
  const wallets = rows.map((row) => ({
    name: row.name,
    address: row.address,
    category: row.category as WalletCategory,
    type: row.type as WalletType,
    addedAt: row.added_at,
  }));
  return { total: wallets.length, wallets };
}

/**
 * Check which smart wallets are in a specific pool.
 */
export async function checkSmartWalletsOnPool({
  pool_address,
}: CheckSmartWalletsInput): Promise<WalletPositionCheck> {
  const allWallets = listSmartWallets().wallets;
  // Only check LP-type wallets — holder wallets don't have positions
  const wallets = allWallets.filter((w) => !w.type || w.type === "lp");

  if (wallets.length === 0) {
    return {
      pool: pool_address,
      tracked_wallets: 0,
      in_pool: [],
      confidence_boost: false,
      signal: "No smart wallets tracked yet — neutral signal",
    };
  }

  const { getWalletPositions } = await import("../../tools/dlmm.js");

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const cached = _cache.get(wallet.address);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
          return { wallet, positions: cached.positions };
        }
        const { positions } = await getWalletPositions({
          wallet_address: wallet.address,
        });
        _cache.set(wallet.address, {
          positions: positions || [],
          fetchedAt: Date.now(),
        });
        return { wallet, positions: positions || [] };
      } catch {
        return { wallet, positions: [] };
      }
    })
  );

  const inPool: WalletInPool[] = results
    .filter((r) => r.positions.some((p) => (p as { pool: string }).pool === pool_address))
    .map((r) => ({
      name: r.wallet.name,
      category: r.wallet.category,
      address: r.wallet.address,
    }));

  return {
    pool: pool_address,
    tracked_wallets: wallets.length,
    in_pool: inPool,
    confidence_boost: inPool.length > 0,
    signal:
      inPool.length > 0
        ? `${inPool.length}/${wallets.length} smart wallet(s) are in this pool: ${inPool.map((w) => w.name).join(", ")} — STRONG signal`
        : `0/${wallets.length} smart wallets in this pool — neutral, rely on fundamentals`,
  };
}

/**
 * Clear all smart wallets (useful for testing).
 */
export function clearSmartWallets(): { cleared: number } {
  const result = run("DELETE FROM smart_wallets");
  log("smart_wallets", `Cleared ${result.changes} smart wallets`);
  return { cleared: Number(result.changes) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Registrations
// ═══════════════════════════════════════════════════════════════════════════

registerTool({
  name: "add_smart_wallet",
  handler: addSmartWallet,
  roles: ["GENERAL"],
});

registerTool({
  name: "remove_smart_wallet",
  handler: removeSmartWallet,
  roles: ["GENERAL"],
});

registerTool({
  name: "list_smart_wallets",
  handler: listSmartWallets,
  roles: ["GENERAL"],
});

registerTool({
  name: "check_smart_wallets_on_pool",
  handler: checkSmartWalletsOnPool,
  roles: ["SCREENER", "GENERAL"],
});
