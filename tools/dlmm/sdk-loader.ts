// tools/dlmm/sdk-loader.ts
// Lazy SDK loader for @meteora-ag/dlmm
// Dynamic import defers loading until an actual on-chain call is needed

import type { PublicKey, Transaction } from "@solana/web3.js";

/** Meteora DLMM SDK pool interface */
export interface DLMMPool {
  lbPair: {
    tokenXMint: PublicKey;
    tokenYMint: PublicKey;
    binStep: number;
    parameters?: { baseFactor: number };
  };
  getActiveBin: () => Promise<{ binId: number; price: unknown }>;
  getPosition: (pubkey: PublicKey) => Promise<unknown>;
  createExtendedEmptyPosition: (
    minBinId: number,
    maxBinId: number,
    positionPubKey: PublicKey,
    userPubKey: PublicKey
  ) => Promise<Transaction | Transaction[]>;
  addLiquidityByStrategyChunkable: (params: unknown) => Promise<Transaction | Transaction[]>;
  initializePositionAndAddLiquidityByStrategy: (params: unknown) => Promise<Transaction>;
  addLiquidityByStrategy: (params: unknown) => Promise<Transaction>;
  removeLiquidity: (params: unknown) => Promise<Transaction | Transaction[]>;
  claimSwapFee: (params: { owner: PublicKey; position: unknown }) => Promise<Transaction[]>;
  closePosition: (params: {
    owner: PublicKey;
    position: { publicKey: PublicKey };
  }) => Promise<Transaction>;
  fromPricePerLamport: (price: number) => number;
}

/** Strategy type mapping from SDK */
export interface StrategyTypeMap {
  Spot: string;
  Curve: string;
  BidAsk: string;
  [key: string]: string;
}

/** SDK module interface */
export interface DLMMModule {
  default: unknown;
  StrategyType: StrategyTypeMap;
}

// Module-level cache for lazy loading
let _dlmmModule: DLMMModule | null = null;
let _strategyType: StrategyTypeMap | null = null;

/**
 * Lazy load the Meteora DLMM SDK
 * Uses dynamic import to defer loading until needed (never triggered in dry-run)
 */
export async function loadDlmmSdk(): Promise<{
  DLMM: unknown;
  StrategyType: StrategyTypeMap | null;
}> {
  if (!_dlmmModule) {
    const mod = await import("@meteora-ag/dlmm");
    _dlmmModule = mod as unknown as DLMMModule;
    _strategyType = (mod as unknown as { StrategyType: StrategyTypeMap }).StrategyType;
  }
  return { DLMM: _dlmmModule.default, StrategyType: _strategyType };
}

/**
 * Get the cached StrategyType enum from SDK
 * Throws if SDK not loaded
 */
export function getStrategyType(): StrategyTypeMap {
  if (!_strategyType) {
    throw new Error("StrategyType not initialized - call loadDlmmSdk() first");
  }
  return _strategyType;
}

/**
 * Reset the SDK cache (useful for testing)
 */
export function resetSdkCache(): void {
  _dlmmModule = null;
  _strategyType = null;
}

/**
 * Check if SDK is loaded
 */
export function isSdkLoaded(): boolean {
  return _dlmmModule !== null;
}
