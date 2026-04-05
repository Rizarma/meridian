import fs from "fs";
import { log } from "./logger.js";
import { SMART_WALLETS_FILE } from "./paths.js";
import { registerTool } from "./tools/registry.js";
import type {
  AddSmartWalletInput,
  CachedWalletPositions,
  CheckSmartWalletsInput,
  RemoveSmartWalletInput,
  SmartWallet,
  SmartWalletDB,
  SmartWalletList,
  SmartWalletResult,
  WalletCategory,
  WalletInPool,
  WalletPositionCheck,
  WalletType,
} from "./types/smart-wallets.js";

function loadWallets(): SmartWalletDB {
  if (!fs.existsSync(SMART_WALLETS_FILE)) return { wallets: [] };
  try {
    return JSON.parse(fs.readFileSync(SMART_WALLETS_FILE, "utf8")) as SmartWalletDB;
  } catch {
    return { wallets: [] };
  }
}

function saveWallets(data: SmartWalletDB): void {
  fs.writeFileSync(SMART_WALLETS_FILE, JSON.stringify(data, null, 2));
}

const SOLANA_PUBKEY_RE: RegExp = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function addSmartWallet({
  name,
  address,
  category = "alpha",
  type = "lp",
}: AddSmartWalletInput): SmartWalletResult {
  if (!SOLANA_PUBKEY_RE.test(address)) {
    return { success: false, error: "Invalid Solana address format" };
  }
  const data = loadWallets();
  const existing = data.wallets.find((w: SmartWallet) => w.address === address);
  if (existing) {
    return { success: false, error: `Already tracked as "${existing.name}"` };
  }
  const newWallet: SmartWallet = {
    name,
    address,
    category: category as WalletCategory,
    type: type as WalletType,
    addedAt: new Date().toISOString(),
  };
  data.wallets.push(newWallet);
  saveWallets(data);
  log("smart_wallets", `Added wallet: ${name} (${category}, type=${type})`);
  return { success: true, wallet: newWallet };
}

export function removeSmartWallet({ address }: RemoveSmartWalletInput): SmartWalletResult {
  const data = loadWallets();
  const wallet = data.wallets.find((w: SmartWallet) => w.address === address);
  if (!wallet) return { success: false, error: "Wallet not found" };
  data.wallets = data.wallets.filter((w: SmartWallet) => w.address !== address);
  saveWallets(data);
  log("smart_wallets", `Removed wallet: ${wallet.name}`);
  return { success: true, removed: wallet.name };
}

export function listSmartWallets(): SmartWalletList {
  const { wallets } = loadWallets();
  return { total: wallets.length, wallets };
}

// Cache wallet positions for 5 minutes to avoid hammering RPC
const _cache: Map<string, CachedWalletPositions> = new Map();
const CACHE_TTL = 5 * 60 * 1000;

export async function checkSmartWalletsOnPool({
  pool_address,
}: CheckSmartWalletsInput): Promise<WalletPositionCheck> {
  const { wallets: allWallets } = loadWallets();
  // Only check LP-type wallets — holder wallets don't have positions
  const wallets = allWallets.filter((w: SmartWallet) => !w.type || w.type === "lp");
  if (wallets.length === 0) {
    return {
      pool: pool_address,
      tracked_wallets: 0,
      in_pool: [],
      confidence_boost: false,
      signal: "No smart wallets tracked yet — neutral signal",
    };
  }

  const { getWalletPositions } = await import("./tools/dlmm.js");

  const results = await Promise.all(
    wallets.map(async (wallet: SmartWallet) => {
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
    .filter((r) => r.positions.some((p: { pool: string }) => p.pool === pool_address))
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

// Tool registrations
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
