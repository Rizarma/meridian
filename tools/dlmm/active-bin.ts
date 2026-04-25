// tools/dlmm/active-bin.ts
// Get active bin for a DLMM pool — pure read operation

import type BN from "bn.js";
import { getPool } from "./pool-cache.js";
import { normalizeMint } from "../wallet.js";
import type { ActiveBinParams, ActiveBinResult } from "../../src/types/dlmm.js";

/**
 * Get the active bin for a DLMM pool
 * @param params - Pool address
 * @returns Active bin data (bin ID, price, price per lamport)
 */
export async function getActiveBin({ pool_address }: ActiveBinParams): Promise<ActiveBinResult> {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price as BN)),
    pricePerLamport: (activeBin.price as BN).toString(),
  };
}
