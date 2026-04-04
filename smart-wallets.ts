import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import type {
  WalletCategory,
  WalletType,
  SmartWallet,
  SmartWalletDB,
  AddSmartWalletInput,
  RemoveSmartWalletInput,
  SmartWalletResult,
  SmartWalletList,
  WalletInPool,
  CheckSmartWalletsInput,
  WalletPositionCheck,
  CachedWalletPositions,
} from "./types/smart-wallets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_PATH = path.join(__dirname, "smart-wallets.json");

function loadWallets(): SmartWalletDB {
  if (!fs.existsSync(WALLETS_PATH)) return { wallets: [] };
  try {
    return JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8")) as SmartWalletDB;
  } catch {
    return { wallets: [] };
  }
}

function saveWallets(data: SmartWalletDB): void {
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(data, null, 2));
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
