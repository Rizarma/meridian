// tools/dlmm/claim-fees.ts
// Claims fees from a DLMM position
//
// SAFETY: Uses simulateAndSend from transactions.ts — the simulate-then-send
// pattern is enforced there. No transaction is ever sent without simulation.

import { PublicKey, type Transaction } from "@solana/web3.js";
import { getSharedConnection } from "../../src/infrastructure/connection.js";
import { log } from "../../src/infrastructure/logger.js";
import { getTrackedPosition } from "../../src/infrastructure/state.js";
import type { ClaimParams, ClaimResult } from "../../src/types/dlmm.js";
import { recordActivity } from "../../src/utils/health-check.js";
import { getWallet } from "../../src/utils/wallet.js";
import { normalizeMint } from "../wallet.js";
import { deletePoolFromCache, getPool, invalidatePositionsCache } from "./index.js";
import { lookupPoolForPosition } from "./position-sdk.js";
import { simulateAndSend } from "./transactions.js";

/**
 * Claim accumulated swap fees from a position.
 *
 * Each transaction is individually simulated before sending via the
 * simulateAndSend safety primitive.
 */
export async function claimFees({ position_address }: ClaimParams): Promise<ClaimResult> {
  position_address = normalizeMint(position_address);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_claim: position_address,
      message: "DRY RUN — no transaction sent",
    };
  }

  const tracked = await getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    deletePoolFromCache(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs: Transaction[] = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes: string[] = [];
    for (const tx of txs) {
      const txHash = await simulateAndSend(getSharedConnection(), tx, [wallet], "claim");
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    recordActivity();
    await invalidatePositionsCache();

    return {
      success: true,
      position: position_address,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
      // Flag for middleware to record claim
      _recordClaim: true,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log("claim_error", message);
    return { success: false, error: message };
  }
}
