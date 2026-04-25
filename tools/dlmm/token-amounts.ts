// tools/dlmm/token-amounts.ts
// Token amount conversion utilities for DLMM operations

import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { getSharedConnection } from "../../src/infrastructure/connection.js";

/**
 * Convert token amount to lamports (BN)
 * @param amount - Token amount in UI units
 * @param decimals - Token decimals (default 9)
 * @returns BN representing lamports
 */
export function toLamports(amount: number, decimals = 9): BN {
  if (amount <= 0) return new BN(0);
  return new BN((amount * 10 ** decimals).toFixed(0), 10);
}

/**
 * Convert lamports (BN) to UI amount
 * @param lamports - BN representing lamports
 * @param decimals - Token decimals (default 9)
 * @returns Number in UI units
 */
export function fromLamports(lamports: BN, decimals = 9): number {
  return lamports.toNumber() / 10 ** decimals;
}

/**
 * Fetch token decimals from on-chain mint account
 * @param mintAddress - Token mint address
 * @returns Decimals (defaults to 9 if fetch fails)
 */
export async function fetchTokenDecimals(mintAddress: string | PublicKey): Promise<number> {
  try {
    const mint = typeof mintAddress === "string" 
      ? new PublicKey(mintAddress) 
      : mintAddress;
    
    const mintInfo = await getSharedConnection().getParsedAccountInfo(mint);
    const parsedData = mintInfo.value?.data as
      | { parsed?: { info?: { decimals?: number } } }
      | undefined;
    
    return parsedData?.parsed?.info?.decimals ?? 9;
  } catch {
    return 9; // Default to 9 decimals on failure
  }
}

/**
 * Fetch both token decimals for a pool
 * @param tokenXMint - Token X mint address
 * @param tokenYMint - Token Y mint address
 * @returns Object with decimalsX and decimalsY
 */
export async function fetchPoolTokenDecimals(
  tokenXMint: string | PublicKey,
  tokenYMint: string | PublicKey
): Promise<{ decimalsX: number; decimalsY: number }> {
  const [decimalsX, decimalsY] = await Promise.all([
    fetchTokenDecimals(tokenXMint),
    fetchTokenDecimals(tokenYMint),
  ]);
  return { decimalsX, decimalsY };
}

/**
 * Safely parse a number from unknown value
 * Returns 0 for invalid/undefined values
 */
export function safeParseNumber(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const n = parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Calculate total value from token amounts
 * @param amountX - Amount of token X
 * @param amountY - Amount of token Y
 * @param priceX - Price of token X in USD
 * @param priceY - Price of token Y in USD (usually 1 for SOL/USDC)
 * @returns Total value in USD
 */
export function calculateTotalValue(
  amountX: number,
  amountY: number,
  priceX: number,
  priceY: number
): number {
  return amountX * priceX + amountY * priceY;
}
