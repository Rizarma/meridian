// tools/dlmm/withdraw-liquidity.ts
// Withdraws liquidity from a DLMM position
//
// SAFETY: Uses simulateAndSend from transactions.ts — the simulate-then-send
// pattern is enforced there. No transaction is ever sent without simulation.

import { PublicKey, type Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { getSharedConnection } from "../../src/infrastructure/connection.js";
import { log } from "../../src/infrastructure/logger.js";
import { getTrackedPosition } from "../../src/infrastructure/state.js";
import type { WithdrawLiquidityParams, WithdrawLiquidityResult } from "../../src/types/dlmm.js";
import { recordActivity } from "../../src/utils/health-check.js";
import { getWallet } from "../../src/utils/wallet.js";
import { normalizeMint } from "../wallet.js";
import {
  deletePoolFromCache,
  fetchDlmmPnlForPool,
  getPool,
  invalidatePositionsCache,
} from "./index.js";
import { simulateAndSend } from "./transactions.js";

/**
 * Withdraw liquidity (and optionally claim fees) from a position.
 *
 * Steps:
 * 1. Claim fees (optional) — simulated + sent individually
 * 2. Check position has liquidity
 * 3. Remove liquidity via SDK — simulated + sent individually
 * 4. Calculate withdrawn amounts from on-chain data comparison
 * 5. Invalidate cache and return results
 */
export async function withdrawLiquidity({
  position_address,
  pool_address,
  bps = 10000,
  claim_fees = false,
}: WithdrawLiquidityParams): Promise<WithdrawLiquidityResult> {
  position_address = normalizeMint(position_address);
  pool_address = normalizeMint(pool_address);

  // ─── Parameter Validation ───────────────────────────────────
  // Validate Solana addresses (base58, 32-44 chars)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  if (
    !base58Regex.test(position_address) ||
    position_address.length < 32 ||
    position_address.length > 44
  ) {
    return { success: false, error: `Invalid position_address: ${position_address}` };
  }
  if (!base58Regex.test(pool_address) || pool_address.length < 32 || pool_address.length > 44) {
    return { success: false, error: `Invalid pool_address: ${pool_address}` };
  }

  // Validate bps (1-10000, where 10000 = 100%)
  if (bps < 1 || bps > 10000) {
    return {
      success: false,
      error: `Invalid bps: ${bps}. Must be between 1 and 10000 (10000 = 100%)`,
    };
  }

  // ─── Dry Run Mode ─────────────────────────────────────────────
  if (process.env.DRY_RUN === "true") {
    return {
      success: true,
      position: position_address,
      pool: pool_address,
      bps,
      amount_x_withdrawn: 0,
      amount_y_withdrawn: 0,
      fees_claimed: claim_fees ? 0 : undefined,
      txs: [],
    };
  }

  const tracked = await getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — no liquidity to withdraw" };
  }

  try {
    log("withdraw", `Withdrawing ${bps / 100}% liquidity from position: ${position_address}`);
    const wallet = getWallet();

    // Clear cached pool so SDK loads fresh position state
    deletePoolFromCache(pool_address.toString());
    const pool = await getPool(pool_address);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes: string[] = [];
    let feesClaimedUsd = 0;

    // ─── Step 1: Claim Fees (optional) ─────────────────────────
    if (claim_fees) {
      const recentlyClaimed =
        tracked?.last_claim_at && Date.now() - new Date(tracked.last_claim_at).getTime() < 60_000;
      try {
        if (recentlyClaimed) {
          log(
            "withdraw",
            `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at!).getTime()) / 1000)}s ago`
          );
        } else {
          log("withdraw", `Step 1: Claiming fees for ${position_address}`);
          const positionData = await pool.getPosition(positionPubKey);
          const claimTxs: Transaction[] = await pool.claimSwapFee({
            owner: wallet.publicKey,
            position: positionData,
          });
          if (claimTxs && claimTxs.length > 0) {
            for (const tx of claimTxs) {
              const claimHash = await simulateAndSend(
                getSharedConnection(),
                tx,
                [wallet],
                "withdraw"
              );
              claimTxHashes.push(claimHash);
            }
            log("withdraw", `Step 1 OK (claim): ${claimTxHashes.join(", ")}`);

            // Get fees claimed from position data
            const binData = await fetchDlmmPnlForPool(pool_address, wallet.publicKey.toString());
            const posData = binData[position_address];
            if (posData?.unrealizedPnl) {
              feesClaimedUsd =
                Number(posData.unrealizedPnl.unclaimedFeeTokenX?.usd ?? 0) +
                Number(posData.unrealizedPnl.unclaimedFeeTokenY?.usd ?? 0);
            }
          }
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        log("withdraw_warn", `Step 1 (Claim) failed or nothing to claim: ${message}`);
      }
    }

    // ─── Step 2: Get Position Data & Check Liquidity ────────────
    let fromBinId = -887272;
    let toBinId = 887272;
    let hasLiquidity = false;
    let preBinData: Array<{
      positionLiquidity?: string;
      positionXAmount?: string;
      positionYAmount?: string;
      positionX?: string;
      positionY?: string;
    }> = [];

    try {
      const positionData = await pool.getPosition(positionPubKey);
      const processed = (
        positionData as {
          positionData?: { lowerBinId?: number; upperBinId?: number; positionBinData?: unknown[] };
        }
      )?.positionData;
      if (processed) {
        fromBinId = processed.lowerBinId ?? fromBinId;
        toBinId = processed.upperBinId ?? toBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        preBinData = bins as Array<{
          positionLiquidity?: string;
          positionXAmount?: string;
          positionYAmount?: string;
          positionX?: string;
          positionY?: string;
        }>;
        hasLiquidity = bins.some((bin) =>
          new BN((bin as { positionLiquidity?: string })?.positionLiquidity || "0").gt(new BN(0))
        );
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log("withdraw_warn", `Could not check liquidity state: ${message}`);
    }

    if (!hasLiquidity) {
      return { success: false, error: "Position has no liquidity to withdraw" };
    }

    // Get token decimals for amount conversion
    let decimalsX = 9;
    let decimalsY = 9;
    try {
      const mintXInfo = await getSharedConnection().getParsedAccountInfo(
        new PublicKey(pool.lbPair.tokenXMint)
      );
      const parsedDataX = mintXInfo.value?.data as
        | { parsed?: { info?: { decimals?: number } } }
        | undefined;
      decimalsX = parsedDataX?.parsed?.info?.decimals ?? 9;
      const mintYInfo = await getSharedConnection().getParsedAccountInfo(
        new PublicKey(pool.lbPair.tokenYMint)
      );
      const parsedDataY = mintYInfo.value?.data as
        | { parsed?: { info?: { decimals?: number } } }
        | undefined;
      decimalsY = parsedDataY?.parsed?.info?.decimals ?? 9;
    } catch {
      log("withdraw_warn", "Could not fetch token decimals, using default 9");
    }

    // ─── Step 3: Remove Liquidity ───────────────────────────────
    // Note: removeLiquidity is deterministic — removes bps/10000 of existing
    // position liquidity from each bin. No slippage parameter needed (unlike
    // addLiquidity which converts new capital at current prices).
    log("withdraw", `Step 2: Removing ${bps / 100}% liquidity`);
    const withdrawTxs: Transaction | Transaction[] = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId,
      toBinId,
      bps: new BN(bps),
      shouldClaimAndClose: false, // Don't close position, just withdraw
    });

    const withdrawTxHashes: string[] = [];
    for (const tx of Array.isArray(withdrawTxs) ? withdrawTxs : [withdrawTxs]) {
      const txHash = await simulateAndSend(getSharedConnection(), tx, [wallet], "withdraw");
      withdrawTxHashes.push(txHash);
    }
    log("withdraw", `Step 2 OK (withdraw): ${withdrawTxHashes.join(", ")}`);

    // ─── Step 4: Calculate Withdrawn Amounts ────────────────────
    // Use on-chain position data comparison (pre vs post) instead of wallet
    // balance delta. The wallet balance approach has a race condition — other
    // transactions (auto-swap, concurrent claims) can change balances between
    // the pre and post snapshots, producing incorrect amounts.
    // sendAndConfirmTransaction already waits for confirmation, so the RPC
    // state should reflect the withdrawal immediately (no sleep needed).
    let amountXWithdrawn = 0;
    let amountYWithdrawn = 0;

    try {
      // Re-fetch position data after confirmed withdrawal
      const postPositionData = await pool.getPosition(positionPubKey);
      const postProcessed = (postPositionData as { positionData?: { positionBinData?: unknown[] } })
        ?.positionData;
      const postBins = Array.isArray(postProcessed?.positionBinData)
        ? postProcessed.positionBinData
        : [];

      // Sum pre-withdrawal liquidity across all bins
      let preTotalLiquidity = new BN(0);
      for (const bin of preBinData) {
        preTotalLiquidity = preTotalLiquidity.add(new BN(bin.positionLiquidity || "0"));
      }

      // Sum post-withdrawal liquidity across all bins
      let postTotalLiquidity = new BN(0);
      for (const bin of postBins) {
        postTotalLiquidity = postTotalLiquidity.add(
          new BN((bin as { positionLiquidity?: string })?.positionLiquidity || "0")
        );
      }

      const liquidityDelta = preTotalLiquidity.sub(postTotalLiquidity);

      if (liquidityDelta.gt(new BN(0)) && preTotalLiquidity.gt(new BN(0))) {
        // We know how much liquidity was removed. Estimate token amounts
        // from the bps ratio applied to pre-withdrawal bin composition.
        const bpsRatio = bps / 10000;

        // Use per-bin X/Y amounts if available (Meteora SDK provides these)
        let preTotalX = new BN(0);
        let preTotalY = new BN(0);
        for (const bin of preBinData) {
          preTotalX = preTotalX.add(new BN(bin.positionXAmount || bin.positionX || "0"));
          preTotalY = preTotalY.add(new BN(bin.positionYAmount || bin.positionY || "0"));
        }

        if (preTotalX.gt(new BN(0)) || preTotalY.gt(new BN(0))) {
          // SDK provides per-token amounts — use bps ratio directly
          amountXWithdrawn = (preTotalX.toNumber() * bpsRatio) / 10 ** decimalsX;
          amountYWithdrawn = (preTotalY.toNumber() * bpsRatio) / 10 ** decimalsY;
        } else {
          // Fallback: estimate from total liquidity change ratio applied to
          // current wallet balance. NOTE: This may be inaccurate if other
          // transactions (auto-swap, claims) modify the wallet concurrently.
          const removedRatio = liquidityDelta.toNumber() / preTotalLiquidity.toNumber();
          log(
            "withdraw",
            `Using fallback estimate (removedRatio=${removedRatio.toFixed(4)}) — amounts are approximate`
          );
          const tokenXAccount = await getSharedConnection().getTokenAccountsByOwner(
            wallet.publicKey,
            {
              mint: pool.lbPair.tokenXMint,
            }
          );
          const tokenYAccount = await getSharedConnection().getTokenAccountsByOwner(
            wallet.publicKey,
            {
              mint: pool.lbPair.tokenYMint,
            }
          );
          if (tokenXAccount.value.length > 0) {
            const info = await getSharedConnection().getParsedAccountInfo(
              tokenXAccount.value[0].pubkey
            );
            const parsedData = info.value?.data as
              | { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } }
              | undefined;
            const parsed = parsedData?.parsed?.info;
            amountXWithdrawn = parsed
              ? Number(parsed.tokenAmount?.uiAmount ?? 0) * removedRatio
              : 0;
          }
          if (tokenYAccount.value.length > 0) {
            const info = await getSharedConnection().getParsedAccountInfo(
              tokenYAccount.value[0].pubkey
            );
            const parsedData = info.value?.data as
              | { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } }
              | undefined;
            const parsed = parsedData?.parsed?.info;
            amountYWithdrawn = parsed
              ? Number(parsed.tokenAmount?.uiAmount ?? 0) * removedRatio
              : 0;
          }
        }
      }

      amountXWithdrawn = Math.max(0, amountXWithdrawn);
      amountYWithdrawn = Math.max(0, amountYWithdrawn);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log("withdraw_warn", `Could not calculate withdrawn amounts: ${message}`);
    }

    // ─── Step 5: Invalidate Cache & Return ──────────────────────
    await invalidatePositionsCache();
    recordActivity();

    const allTxs = [...claimTxHashes, ...withdrawTxHashes];
    log(
      "withdraw",
      `SUCCESS — withdrawn ~${amountXWithdrawn.toFixed(6)} X, ~${amountYWithdrawn.toFixed(6)} Y (txs: ${allTxs.length})`
    );

    return {
      success: true,
      position: position_address,
      pool: pool_address,
      bps,
      amount_x_withdrawn: amountXWithdrawn,
      amount_y_withdrawn: amountYWithdrawn,
      fees_claimed: claim_fees ? feesClaimedUsd : undefined,
      txs: allTxs,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log("withdraw_error", message);
    return { success: false, error: message };
  }
}
