// tools/dlmm/add-liquidity.ts
// Adds liquidity to an existing DLMM position
//
// SAFETY: Uses simulateAndSend from transactions.ts — the simulate-then-send
// pattern is enforced there. No transaction is ever sent without simulation.

import { PublicKey, type Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "../../src/config/config.js";
import { getSharedConnection } from "../../src/infrastructure/connection.js";
import { log } from "../../src/infrastructure/logger.js";
import { getTrackedPosition } from "../../src/infrastructure/state.js";
import type { AddLiquidityParams, AddLiquidityResult } from "../../src/types/dlmm.js";
import { recordActivity } from "../../src/utils/health-check.js";
import { isObject } from "../../src/utils/validation.js";
import { getWallet } from "../../src/utils/wallet.js";
import { normalizeMint } from "../wallet.js";
import {
  deletePoolFromCache,
  fetchTokenDecimals,
  getPool,
  invalidatePositionsCache,
} from "./index.js";
import { resolveStrategy } from "./strategy.js";
import { simulateAndSend } from "./transactions.js";

// Default slippage in basis points (1000 bps = 10%)
const DEFAULT_SLIPPAGE_BPS = 1000;

/**
 * Add liquidity to an existing DLMM position.
 *
 * Supports standard and wide-range (>69 bins) positions using the appropriate
 * SDK method. Each transaction is individually simulated before sending.
 */
export async function addLiquidity({
  position_address,
  pool_address,
  amount_x,
  amount_y,
  strategy,
  single_sided_x,
}: AddLiquidityParams): Promise<AddLiquidityResult> {
  position_address = normalizeMint(position_address);
  pool_address = normalizeMint(pool_address);

  // ─── Validation ──────────────────────────────────────────────
  // Validate addresses
  try {
    new PublicKey(position_address);
    new PublicKey(pool_address);
  } catch {
    return { success: false, error: "Invalid Solana address format" };
  }

  // Validate at least one amount is provided and > 0
  const finalAmountX = amount_x ?? 0;
  const finalAmountY = amount_y ?? 0;
  if (finalAmountX <= 0 && finalAmountY <= 0) {
    return { success: false, error: "At least one amount (amount_x or amount_y) must be > 0" };
  }

  // Validate single_sided_x requires amount_x > 0
  if (single_sided_x && finalAmountX <= 0) {
    return {
      success: false,
      error:
        "single_sided_x requires amount_x > 0 — cannot do single-sided X deposit without X amount",
    };
  }

  // ─── DRY RUN ─────────────────────────────────────────────────
  if (process.env.DRY_RUN === "true") {
    return {
      success: true,
      position: position_address,
      pool: pool_address,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: [],
      error: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("add_liquidity", `Adding liquidity to position: ${position_address}`);
    const wallet = getWallet();

    // Resolve strategy via module
    const { strategyType } = await resolveStrategy(strategy);

    // ─── Load Pool & Position ──────────────────────────────────
    deletePoolFromCache(pool_address); // Clear cache for fresh state
    const pool = await getPool(pool_address);

    // Get position data to determine bin range
    const positionPubKey = new PublicKey(position_address);
    let positionData: unknown;
    try {
      positionData = await pool.getPosition(positionPubKey);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: `Position not found: ${message}` };
    }

    // Check if position is closed
    const tracked = await getTrackedPosition(position_address);
    if (tracked?.closed) {
      return { success: false, error: "Position already closed — cannot add liquidity" };
    }

    // Get bin range from position data
    // Validate positionData has expected shape before accessing
    if (!isObject(positionData)) {
      return { success: false, error: "Invalid position data from SDK" };
    }
    const processed = (
      positionData as { positionData?: { lowerBinId?: number; upperBinId?: number } }
    )?.positionData;
    const minBinId = processed?.lowerBinId ?? -887272;
    const maxBinId = processed?.upperBinId ?? 887272;

    // Check if position is in range
    const activeBin = await pool.getActiveBin();
    const isInRange = activeBin.binId >= minBinId && activeBin.binId <= maxBinId;
    if (!isInRange) {
      return {
        success: false,
        error: `Position out of range — active bin ${activeBin.binId} is outside position range [${minBinId}, ${maxBinId}]`,
      };
    }

    // ─── Convert Amounts to Lamports ─────────────────────────────
    // Get token decimals via module
    const decimalsX = await fetchTokenDecimals(pool.lbPair.tokenXMint);
    const decimalsY = await fetchTokenDecimals(pool.lbPair.tokenYMint);

    // Convert to lamports
    const totalXLamports =
      finalAmountX > 0 ? new BN((finalAmountX * 10 ** decimalsX).toFixed(0), 10) : new BN(0);
    const totalYLamports =
      finalAmountY > 0 ? new BN((finalAmountY * 10 ** decimalsY).toFixed(0), 10) : new BN(0);

    // Handle single-sided liquidity
    const finalXLamports = totalXLamports;
    let finalYLamports = totalYLamports;
    if (single_sided_x && finalAmountX > 0) {
      if (finalAmountY > 0) {
        log("add_liquidity", `Note: single_sided_x=true — ignoring amount_y (${finalAmountY})`);
      }
      finalYLamports = new BN(0);
    }

    log("add_liquidity", `Pool: ${pool_address}`);
    log(
      "add_liquidity",
      `Strategy: ${strategy || config.strategy.strategy}, Bin range: ${minBinId} to ${maxBinId}`
    );
    log("add_liquidity", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
    log("add_liquidity", `Active bin: ${activeBin.binId}`);

    // ─── Execute Add Liquidity ─────────────────────────────────
    const txHashes: string[] = [];
    const totalBins = maxBinId - minBinId + 1;
    const isWideRange = totalBins > 69;

    if (isWideRange) {
      // Wide range: use chunkable method
      const addTxs: Transaction | Transaction[] = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: positionPubKey,
        user: wallet.publicKey,
        totalXAmount: finalXLamports,
        totalYAmount: finalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: DEFAULT_SLIPPAGE_BPS,
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        const txHash = await simulateAndSend(
          getSharedConnection(),
          addTxArray[i],
          [wallet],
          "add_liquidity"
        );
        txHashes.push(txHash);
        log("add_liquidity", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
      }
    } else {
      // Standard range: use single transaction method
      const addTx: Transaction = await pool.addLiquidityByStrategy({
        positionPubKey: positionPubKey,
        user: wallet.publicKey,
        totalXAmount: finalXLamports,
        totalYAmount: finalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: DEFAULT_SLIPPAGE_BPS,
      });
      // Simulate and send via safety primitive
      const txHash = await simulateAndSend(getSharedConnection(), addTx, [wallet], "add_liquidity");
      txHashes.push(txHash);
      log("add_liquidity", `Add liquidity tx: ${txHash}`);
    }

    log("add_liquidity", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);
    recordActivity();

    // Invalidate positions cache
    await invalidatePositionsCache();

    return {
      success: true,
      position: position_address,
      pool: pool_address,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log("add_liquidity_error", message);

    // Handle specific error cases
    if (message.includes("insufficient")) {
      return { success: false, error: `Insufficient balance: ${message}` };
    }
    if (message.includes("0x1")) {
      return { success: false, error: `Insufficient balance or invalid account: ${message}` };
    }
    if (message.includes("range") || message.includes("bin")) {
      return { success: false, error: `Out of range or invalid bin: ${message}` };
    }

    return { success: false, error: message };
  }
}
