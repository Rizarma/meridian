// tools/dlmm/positions.ts
// Read-only position queries: getMyPositions, getWalletPositions, getPositionPnl

import { config } from "../../src/config/config.js";
import { log } from "../../src/infrastructure/logger.js";
import {
  getTrackedPosition,
  markInRange,
  markOutOfRange,
  minutesOutOfRange,
  syncOpenPositions,
} from "../../src/infrastructure/state.js";
import type {
  EnrichedPosition,
  PositionPnL,
  PositionsResult,
  RawPnLData,
  WalletPositionsParams,
  WalletPositionsResult,
} from "../../src/types/dlmm.js";
import { getErrorMessage } from "../../src/utils/errors.js";
import { fetchWithRetry } from "../../src/utils/retry.js";
import { getWallet } from "../../src/utils/wallet.js";
import { normalizeMint } from "../wallet.js";
import { deriveOpenPnlPct, fetchDlmmPnlForPool, getPositionPnlFromApi } from "./pnl-api.js";
import { getAllPositionsForWallet } from "./position-sdk.js";
import {
  getCachedPositions,
  getPositionsInflight,
  setPositionsCache,
  setPositionsInflight,
} from "./positions-cache.js";

// ─── Get Position PnL (Meteora API) ─────────────────────────────
/**
 * Get PnL for a specific position from the Meteora API
 */
export async function getPositionPnl({
  pool_address,
  position_address,
}: {
  pool_address: string;
  position_address: string;
}): Promise<PositionPnL | { error: string }> {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  return getPositionPnlFromApi(pool_address, position_address, walletAddress);
}

// ─── Get My Positions ──────────────────────────────────────────
/**
 * Get all open positions for the configured wallet with enrichment
 * (PnL data, OOR tracking, fee information)
 */
export async function getMyPositions({
  force = false,
  silent = false,
} = {}): Promise<PositionsResult> {
  const cached = getCachedPositions(force);
  if (cached) return cached;

  const inflight = getPositionsInflight();
  if (inflight) return inflight;

  let walletAddress: string;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  const fetchPromise = (async () => {
    try {
      // Single portfolio API call — returns all positions with full PnL data
      if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
      const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
      const res = await fetchWithRetry(portfolioUrl);
      if (!res.ok)
        throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
      const portfolio = (await res.json()) as { pools?: any[] };

      const pools = portfolio.pools || [];
      if (!silent) log("positions", `Found ${pools.length} pool(s) with open positions`);

      // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
      // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
      const binDataByPool: Record<string, Record<string, RawPnLData>> = {};
      const pnlMaps = await Promise.all(
        pools.map((pool: any) => fetchDlmmPnlForPool(pool.poolAddress, walletAddress))
      );
      pools.forEach((pool: any, i: number) => {
        binDataByPool[pool.poolAddress] = pnlMaps[i];
      });

      const positions: EnrichedPosition[] = [];
      for (const pool of pools) {
        for (const positionAddress of pool.listPositions || []) {
          const tracked = await getTrackedPosition(positionAddress);
          const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

          // Mark OOR state and capture the effective out_of_range_since to
          // avoid a duplicate DB read in minutesOutOfRange below.
          const oorSince = isOOR
            ? await markOutOfRange(positionAddress)
            : await markInRange(positionAddress);

          // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
          const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
          if (!binData) {
            log(
              "positions_warn",
              `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`
            );
          }
          const lowerBin = binData?.lowerBinId ?? tracked?.bin_range?.min ?? null;
          const upperBin = binData?.upperBinId ?? tracked?.bin_range?.max ?? null;
          const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;

          const ageFromState = tracked?.deployed_at
            ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
            : null;
          const reportedPnlPct = binData
            ? Number(
                config.features.solMode
                  ? (binData.pnlSolPctChange ?? 0)
                  : (binData.pnlPctChange ?? 0)
              )
            : null;
          const derivedPnlPct = binData ? deriveOpenPnlPct(binData, config.features.solMode) : null;
          const pnlPctDiff =
            reportedPnlPct != null && derivedPnlPct != null
              ? Math.abs(reportedPnlPct - derivedPnlPct)
              : null;
          const pnlPctSuspicious =
            pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5);
          if (pnlPctSuspicious) {
            log(
              "positions_warn",
              `Suspicious pnl_pct for ${positionAddress.slice(0, 8)}: reported=${reportedPnlPct?.toFixed(2)} derived=${derivedPnlPct?.toFixed(2)} diff=${pnlPctDiff?.toFixed(2)}`
            );
          }

          positions.push({
            position: positionAddress,
            pool: pool.poolAddress,
            pair: tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
            base_mint: pool.tokenXMint,
            lower_bin: lowerBin,
            upper_bin: upperBin,
            active_bin: activeBin,
            in_range: binData ? !binData.isOutOfRange : !isOOR,
            unclaimed_fees_usd: binData
              ? Math.round(
                  (config.features.solMode
                    ? Number(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol ?? 0) +
                      Number(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol ?? 0)
                    : Number(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd ?? 0) +
                      Number(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd ?? 0)) * 10000
                ) / 10000
              : null,
            total_value_usd: binData
              ? Math.round(
                  (config.features.solMode
                    ? Number(binData.unrealizedPnl?.balancesSol ?? 0)
                    : Number(binData.unrealizedPnl?.balances ?? 0)) * 10000
                ) / 10000
              : null,
            // Always-USD fields for internal accounting and lesson recording.
            total_value_true_usd: binData
              ? Math.round(Number(binData.unrealizedPnl?.balances ?? 0) * 10000) / 10000
              : null,
            collected_fees_usd: binData
              ? Math.round(
                  Number(
                    config.features.solMode
                      ? (binData.allTimeFees?.total?.sol ?? 0)
                      : (binData.allTimeFees?.total?.usd ?? 0)
                  ) * 10000
                ) / 10000
              : null,
            collected_fees_true_usd: binData
              ? Math.round(Number(binData.allTimeFees?.total?.usd ?? 0) * 10000) / 10000
              : null,
            pnl_usd: binData
              ? Math.round(
                  Number(config.features.solMode ? (binData.pnlSol ?? 0) : (binData.pnlUsd ?? 0)) *
                    10000
                ) / 10000
              : null,
            pnl_true_usd: binData ? Math.round(Number(binData.pnlUsd ?? 0) * 10000) / 10000 : null,
            pnl_pct: binData ? Math.round((reportedPnlPct || 0) * 100) / 100 : null,
            pnl_pct_derived: derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
            pnl_pct_diff: pnlPctDiff != null ? Math.round(pnlPctDiff * 100) / 100 : null,
            pnl_pct_suspicious: !!pnlPctSuspicious,
            unclaimed_fees_true_usd: binData
              ? Math.round(
                  (Number(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd ?? 0) +
                    Number(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd ?? 0)) *
                    10000
                ) / 10000
              : null,
            fee_per_tvl_24h: binData
              ? Math.round(Number(binData.feePerTvl24h ?? 0) * 100) / 100
              : null,
            age_minutes: binData?.createdAt
              ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000)
              : ageFromState,
            minutes_out_of_range: await minutesOutOfRange(positionAddress, oorSince),
            instruction: tracked?.instruction ?? null,
            tracked_state: tracked,
          });
        }
      }

      const result: PositionsResult = {
        wallet: walletAddress,
        total_positions: positions.length,
        positions,
      };
      syncOpenPositions(positions.map((p) => p.position));
      await setPositionsCache(result);
      return result;
    } catch (error: unknown) {
      log(
        "positions_error",
        `Portfolio fetch failed: ${error instanceof Error ? error.stack || error.message : String(error)}`
      );
      return {
        wallet: walletAddress,
        total_positions: 0,
        positions: [] as EnrichedPosition[],
        error: getErrorMessage(error),
      };
    } finally {
      setPositionsInflight(null);
    }
  })();

  setPositionsInflight(fetchPromise);
  return fetchPromise;
}

// ─── Get Positions for Any Wallet ─────────────────────────────
/**
 * Get positions for any wallet address (research tool)
 * Less enrichment than getMyPositions — no OOR tracking
 */
export async function getWalletPositions({
  wallet_address,
}: WalletPositionsParams): Promise<WalletPositionsResult> {
  try {
    const positions = await getAllPositionsForWallet(wallet_address);

    if (positions.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    // Enrich with PnL API
    const uniquePools = [...new Set(positions.map((r) => r.pool))];
    const pnlMaps = await Promise.all(
      uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address))
    );
    const pnlByPool: Record<string, Record<string, RawPnLData>> = {};
    uniquePools.forEach((pool, i) => {
      pnlByPool[pool] = pnlMaps[i];
    });

    const enrichedPositions = positions.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      return {
        position: r.position,
        pool: r.pool,
        lower_bin: p?.lowerBinId ?? null,
        upper_bin: p?.upperBinId ?? null,
        active_bin: p?.poolActiveBinId ?? null,
        in_range: p ? !p.isOutOfRange : null,
        unclaimed_fees_usd:
          Math.round(
            (p
              ? parseFloat(String(p.unrealizedPnl?.unclaimedFeeTokenX?.usd ?? 0)) +
                parseFloat(String(p.unrealizedPnl?.unclaimedFeeTokenY?.usd ?? 0))
              : 0) * 100
          ) / 100,
        total_value_usd:
          Math.round((p ? parseFloat(String(p.unrealizedPnl?.balances ?? 0)) : 0) * 100) / 100,
        pnl_usd: Math.round((p?.pnlUsd ?? 0) * 100) / 100,
        pnl_pct: Math.round((p?.pnlPctChange ?? 0) * 100) / 100,
        age_minutes: p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return {
      wallet: wallet_address,
      total_positions: enrichedPositions.length,
      positions: enrichedPositions,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log("wallet_positions_error", message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: message };
  }
}
