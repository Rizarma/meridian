// tools/dlmm/close-position.ts
// Close an existing LP position and record performance
// Extracted from tools/dlmm.ts (Phase G)

import { PublicKey, type Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { getSharedConnection } from "../../src/infrastructure/connection.js";
import { log } from "../../src/infrastructure/logger.js";
import { getTrackedPosition } from "../../src/infrastructure/state.js";
import type { CloseParams, CloseResult } from "../../src/types/dlmm.js";
// PositionPerformance documents the shape of _perf_data in the close result
// (cast omitted to satisfy Record<string, unknown> in CloseResult)
import type { PositionPerformance } from "../../src/types/lessons.js";
import { recordActivity } from "../../src/utils/health-check.js";
import { fetchWithRetry } from "../../src/utils/retry.js";
import { isObject } from "../../src/utils/validation.js";
import { getWallet } from "../../src/utils/wallet.js";
import { normalizeMint } from "../wallet.js";
import { deletePoolFromCache, getPool } from "./pool-cache.js";
import { lookupPoolForPosition } from "./position-sdk.js";
import { getMyPositions } from "./positions.js";
import { findPositionInCache, invalidatePositionsCache } from "./positions-cache.js";
import { simulateAndSend } from "./transactions.js";

export async function closePosition({
  position_address,
  reason,
}: CloseParams): Promise<CloseResult> {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_close: position_address,
      message: "DRY RUN — no transaction sent",
    };
  }

  const tracked = await getTrackedPosition(position_address);

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    deletePoolFromCache(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes: string[] = [];
    const closeTxHashes: string[] = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed =
      tracked?.last_claim_at && Date.now() - new Date(tracked.last_claim_at).getTime() < 60_000;
    try {
      if (recentlyClaimed) {
        log(
          "close",
          `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at!).getTime()) / 1000)}s ago`
        );
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs: Transaction[] = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const tx of claimTxs) {
            const claimHash = await simulateAndSend(getSharedConnection(), tx, [wallet], "close");
            claimTxHashes.push(claimHash);
          }
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
        }
      }
    } catch (e: any) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    let hasLiquidity = false;
    let closeFromBinId = -887272;
    let closeToBinId = 887272;
    try {
      const positionDataForClose = await pool.getPosition(positionPubKey);
      const processed = (
        positionDataForClose as {
          positionData?: { lowerBinId?: number; upperBinId?: number; positionBinData?: unknown[] };
        }
      )?.positionData;
      if (processed) {
        closeFromBinId = processed.lowerBinId ?? closeFromBinId;
        closeToBinId = processed.upperBinId ?? closeToBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        hasLiquidity = bins.some((bin) =>
          new BN((bin as { positionLiquidity?: string })?.positionLiquidity || "0").gt(new BN(0))
        );
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log("close_warn", `Could not check liquidity state: ${message}`);
    }

    if (hasLiquidity) {
      log("close", `Step 2: Removing liquidity and closing account`);
      const closeTx: Transaction | Transaction[] = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: closeFromBinId,
        toBinId: closeToBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
        const txHash = await simulateAndSend(getSharedConnection(), tx, [wallet], "close");
        closeTxHashes.push(txHash);
      }
    } else {
      log("close", `Step 2: Position is empty, forcing close account`);
      const closeTx: Transaction = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      // Simulate and send via safety primitive
      const txHash = await simulateAndSend(getSharedConnection(), closeTx, [wallet], "close");
      closeTxHashes.push(txHash);
    }
    const txHashes = [...claimTxHashes, ...closeTxHashes];
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    recordActivity();
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise((r) => setTimeout(r, 5000));
    await invalidatePositionsCache();

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log(
          "close_warn",
          `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`
        );
      } catch (e: any) {
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor(
          (Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000
        );
      }

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        const res = await fetchWithRetry(closedUrl);
        if (res.ok) {
          const rawClosedData = await res.json();
          if (!isObject(rawClosedData)) {
            log("close_warn", "Invalid closed positions response: not an object");
          } else {
            const data = rawClosedData as { positions?: any[] };
            const posEntry = (data.positions || []).find(
              (p: any) => p.positionAddress === position_address
            );
            if (posEntry) {
              pnlUsd = Number(posEntry.pnlUsd ?? 0);
              pnlPct = Number(posEntry.pnlPctChange ?? 0);
              finalValueUsd = Number(posEntry.allTimeWithdrawals?.total?.usd ?? 0);
              initialUsd = Number(posEntry.allTimeDeposits?.total?.usd ?? 0);
              feesUsd = Number(posEntry.allTimeFees?.total?.usd ?? 0) || feesUsd;
              log(
                "close",
                `Closed PnL from API: pnl=${pnlUsd.toFixed(2)} USD (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)}, deposited=${initialUsd.toFixed(2)}`
              );
            } else {
              log(
                "close_warn",
                `Position not found in status=closed response — may still be settling`
              );
            }
          }
        }
      } catch (e: any) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd === 0) {
        const cachedPos = findPositionInCache(position_address);
        if (cachedPos) {
          pnlUsd = cachedPos.pnl_true_usd ?? cachedPos.pnl_usd ?? 0;
          pnlPct = cachedPos.pnl_pct ?? 0;
          feesUsd =
            (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd = tracked.initial_value_usd || 0;
          if (initialUsd > 0) {
            // Keep fallback internally consistent using USD-only cached metrics.
            finalValueUsd = Math.max(0, initialUsd + pnlUsd - feesUsd);
            pnlPct = (pnlUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlUsd);
          }
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        base_mint: pool.lbPair.tokenXMint.toString(),
        // Additional fields for persistence (recordClose + recordPerformance)
        _recordClose: true,
        close_reason: reason || "agent decision",
        _recordPerformance: true,
        _perf_data: {
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolAddress.slice(0, 8),
          strategy: tracked.strategy,
          bin_range: tracked.bin_range,
          bin_step: tracked.bin_step || null,
          volatility: tracked.volatility || null,
          fee_tvl_ratio: tracked.fee_tvl_ratio || null,
          organic_score: tracked.organic_score || null,
          amount_sol: tracked.amount_sol,
          fees_earned_usd: feesUsd,
          final_value_usd: finalValueUsd,
          initial_value_usd: initialUsd,
          minutes_in_range: minutesHeld - minutesOOR,
          minutes_held: minutesHeld,
          close_reason: reason || "agent decision",
          base_mint: pool.lbPair.tokenXMint.toString(),
          deployed_at: tracked.deployed_at,
        },
      };
    }

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
      // Flag for middleware to record close even without tracked data
      _recordClose: true,
      close_reason: reason || "agent decision",
    };
  } catch (error: any) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}
