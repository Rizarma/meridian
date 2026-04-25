// tools/dlmm/pnl-api.ts
// PnL API fetching functions for Meteora DLMM

import { fetchWithRetry } from "../../src/utils/retry.js";
import { log } from "../../src/infrastructure/logger.js";
import { isArray, isObject } from "../../src/utils/validation.js";
import type { RawPnLData, PositionPnL } from "../../src/types/dlmm.js";
import { config } from "../../src/config/config.js";

/**
 * Safely parse a number from unknown value
 * Returns 0 for invalid/undefined values
 */
function safeNum(value: unknown): number {
  const n = parseFloat(String(value ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Derive open PnL percentage from bin data
 * Used when API-reported PnL seems suspicious
 * @param binData - Raw PnL data from API
 * @param solMode - Use SOL-denominated values
 * @returns Derived PnL percentage or null
 */
export function deriveOpenPnlPct(binData: RawPnLData | null, solMode = false): number | null {
  if (!binData) return null;

  const deposit = solMode
    ? safeNum(binData.allTimeDeposits?.total?.sol)
    : safeNum(binData.allTimeDeposits?.total?.usd);
  if (deposit <= 0) return null;

  const balances = solMode
    ? safeNum(binData.unrealizedPnl?.balancesSol)
    : safeNum(binData.unrealizedPnl?.balances);
  const unclaimedFees = solMode
    ? safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) +
      safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
    : safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd) +
      safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const withdrawals = solMode
    ? safeNum(binData.allTimeWithdrawals?.total?.sol)
    : safeNum(binData.allTimeWithdrawals?.total?.usd);
  const fees = solMode
    ? safeNum(binData.allTimeFees?.total?.sol)
    : safeNum(binData.allTimeFees?.total?.usd);

  const pnl = balances + unclaimedFees + withdrawals + fees - deposit;
  return (pnl / deposit) * 100;
}

/**
 * Fetch PnL data for all positions in a pool
 * @param poolAddress - Pool address
 * @param walletAddress - Wallet address
 * @returns Map of position address to PnL data
 */
export async function fetchDlmmPnlForPool(
  poolAddress: string,
  walletAddress: string
): Promise<Record<string, RawPnLData>> {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  
  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }

    const rawData = await res.json();
    if (!isObject(rawData)) {
      log("pnl_api", `Invalid response for pool ${poolAddress.slice(0, 8)}: not an object`);
      return {};
    }

    const data = rawData as { positions?: RawPnLData[]; data?: RawPnLData[] };
    const rawPositions = data.positions || data.data || [];
    
    if (!isArray(rawPositions)) {
      log("pnl_api", `Invalid positions array for pool ${poolAddress.slice(0, 8)}`);
      return {};
    }

    if (rawPositions.length === 0) {
      log("pnl_api", `No positions returned for pool ${poolAddress.slice(0, 8)} — keys: ${Object.keys(data).join(", ")}`);
    }

    const byAddress: Record<string, RawPnLData> = {};
    for (const p of rawPositions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${message}`);
    return {};
  }
}

/**
 * Get position PnL from Meteora API
 * @param poolAddress - Pool address
 * @param positionAddress - Position address
 * @param walletAddress - Wallet address
 * @returns Position PnL data or error object
 */
export async function getPositionPnlFromApi(
  poolAddress: string,
  positionAddress: string,
  walletAddress: string
): Promise<PositionPnL | { error: string }> {
  try {
    const byAddress = await fetchDlmmPnlForPool(poolAddress, walletAddress);
    const p = byAddress[positionAddress];
    
    if (!p) {
      return { error: "Position not found in PnL API" };
    }

    const unclaimedUsd =
      Number(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) +
      Number(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0);
    const currentValueUsd = Number(p.unrealizedPnl?.balances || 0);
    
    return {
      pnl_usd: Math.round((p.pnlUsd ?? 0) * 100) / 100,
      pnl_pct: Math.round((p.pnlPctChange ?? 0) * 100) / 100,
      current_value_usd: Math.round(currentValueUsd * 100) / 100,
      unclaimed_fee_usd: Math.round(unclaimedUsd * 100) / 100,
      all_time_fees_usd: Math.round(Number(p.allTimeFees?.total?.usd || 0) * 100) / 100,
      fee_per_tvl_24h: Math.round(Number(p.feePerTvl24h || 0) * 100) / 100,
      in_range: !p.isOutOfRange,
      lower_bin: p.lowerBinId ?? null,
      upper_bin: p.upperBinId ?? null,
      active_bin: p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log("pnl_error", message);
    return { error: message };
  }
}

/**
 * Fetch closed positions PnL data
 * @param poolAddress - Pool address
 * @param walletAddress - Wallet address
 * @returns Map of position address to closed PnL data
 */
export async function fetchClosedPnlForPool(
  poolAddress: string,
  walletAddress: string
): Promise<Record<string, RawPnLData>> {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=closed&pageSize=50&page=1`;
  
  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      log("pnl_api", `Closed PnL fetch failed for pool ${poolAddress.slice(0, 8)}: HTTP ${res.status}`);
      return {};
    }

    const rawData = await res.json();
    if (!isObject(rawData)) {
      log("pnl_api", `Invalid closed positions response for pool ${poolAddress.slice(0, 8)}`);
      return {};
    }

    const data = rawData as { positions?: RawPnLData[] };
    const positions = data.positions || [];
    
    const byAddress: Record<string, RawPnLData> = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log("pnl_api", `Closed PnL fetch error for pool ${poolAddress.slice(0, 8)}: ${message}`);
    return {};
  }
}
