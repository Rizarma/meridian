// tools/dlmm/position-sdk.ts
// Position lookup helpers using SDK

import { PublicKey } from "@solana/web3.js";
import { getSharedConnection } from "../../src/infrastructure/connection.js";
import { getTrackedPosition } from "../../src/infrastructure/state.js";
import { isObject } from "../../src/utils/validation.js";
import { getPoolFromCache } from "./positions-cache.js";
import { loadDlmmSdk } from "./sdk-loader.js";

/**
 * Lookup pool address for a position
 * Tries multiple sources in order:
 * 1. State registry (fastest)
 * 2. In-memory positions cache
 * 3. SDK scan (last resort)
 *
 * @param positionAddress - Position address
 * @param walletAddress - Wallet address for SDK scan
 * @returns Pool address
 * @throws Error if position not found
 */
export async function lookupPoolForPosition(
  positionAddress: string,
  walletAddress: string
): Promise<string> {
  // Check state registry first (fast path)
  const tracked = await getTrackedPosition(positionAddress);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cachedPool = getPoolFromCache(positionAddress);
  if (cachedPool) return cachedPool;

  // SDK scan (last resort)
  return lookupPoolViaSdk(positionAddress, walletAddress);
}

/**
 * Lookup pool via SDK scan
 * Iterates through all user positions to find matching position
 * @param positionAddress - Position address
 * @param walletAddress - Wallet address
 * @returns Pool address
 * @throws Error if position not found
 */
async function lookupPoolViaSdk(positionAddress: string, walletAddress: string): Promise<string> {
  const { DLMM } = await loadDlmmSdk();

  // SDK returns all positions grouped by pool
  const allPositions = await (
    DLMM as {
      getAllLbPairPositionsByUser: (
        conn: unknown,
        user: PublicKey
      ) => Promise<Record<string, unknown>>;
    }
  ).getAllLbPairPositionsByUser(getSharedConnection(), new PublicKey(walletAddress));

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    // Validate positionData shape before accessing
    const positions = isObject(positionData)
      ? (positionData as { lbPairPositionsData?: Array<{ publicKey: PublicKey }> })
      : undefined;

    for (const pos of positions?.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === positionAddress) {
        return lbPairKey;
      }
    }
  }

  throw new Error(`Position ${positionAddress} not found in open positions`);
}

/**
 * Get all positions for a wallet via SDK
 * @param walletAddress - Wallet address
 * @returns Array of position addresses with their pools
 */
export async function getAllPositionsForWallet(
  walletAddress: string
): Promise<Array<{ position: string; pool: string }>> {
  const { DLMM } = await loadDlmmSdk();

  const allPositions = await (
    DLMM as {
      getAllLbPairPositionsByUser: (
        conn: unknown,
        user: PublicKey
      ) => Promise<Record<string, unknown>>;
    }
  ).getAllLbPairPositionsByUser(getSharedConnection(), new PublicKey(walletAddress));

  const results: Array<{ position: string; pool: string }> = [];

  for (const [poolAddress, positionData] of Object.entries(allPositions)) {
    const positions = isObject(positionData)
      ? (positionData as { lbPairPositionsData?: Array<{ publicKey: PublicKey }> })
      : undefined;

    for (const pos of positions?.lbPairPositionsData || []) {
      results.push({
        position: pos.publicKey.toString(),
        pool: poolAddress,
      });
    }
  }

  return results;
}

/**
 * Check if a position exists for a wallet
 * @param positionAddress - Position address
 * @param walletAddress - Wallet address
 * @returns True if position exists
 */
export async function positionExists(
  positionAddress: string,
  walletAddress: string
): Promise<boolean> {
  try {
    await lookupPoolViaSdk(positionAddress, walletAddress);
    return true;
  } catch {
    return false;
  }
}
