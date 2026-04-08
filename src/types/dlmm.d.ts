// types/dlmm.d.ts
// DLMM (Meteora) pool and position types

import type BN from "bn.js";
import type { PublicKey } from "@solana/web3.js";

// ─── SDK Types (external - use any with JSDoc) ─────────────────

/** Meteora DLMM SDK pool object - external SDK type */
export type DLMMPool = any;

/** Meteora DLMM SDK StrategyType enum - external SDK type */
export type StrategyType = any;

/** Meteora LB pair parameters */
export interface LbPair {
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  binStep: number;
  parameters?: {
    baseFactor: number;
  };
}

/** Bin array data from DLMM SDK */
export interface BinArray {
  binId: number;
  price: BN;
}

/** Active bin information */
export interface ActiveBin {
  binId: number;
  price: BN;
}

// ─── Deploy Parameters ─────────────────────────────────────────

export interface DeployParams {
  pool_address: string;
  amount_sol?: number;
  amount_x?: number;
  amount_y?: number;
  strategy?: string;
  bins_below?: number;
  bins_above?: number;
  pool_name?: string;
  bin_step?: number;
  base_fee?: number;
  volatility?: number;
  fee_tvl_ratio?: number;
  organic_score?: number;
  initial_value_usd?: number;
}

export interface DeployResult {
  success?: boolean;
  position?: string;
  pool?: string;
  pool_name?: string | null;
  bin_range?: {
    min: number;
    max: number;
    active?: number;
  };
  price_range?: {
    min: number;
    max: number;
  };
  bin_step?: number;
  base_fee?: number | null;
  strategy?: string;
  wide_range?: boolean;
  amount_x?: number;
  amount_y?: number;
  txs?: string[];
  error?: string;
  dry_run?: boolean;
  would_deploy?: Record<string, unknown>;
  message?: string;
  // Additional fields for persistence (trackPosition)
  volatility?: number;
  fee_tvl_ratio?: number;
  organic_score?: number;
  initial_value_usd?: number;
  active_bin?: number;
  amount_sol?: number;
}

// ─── Add Liquidity Types ────────────────────────────────────────

export interface AddLiquidityParams {
  position_address: string;
  pool_address: string;
  amount_x?: number;
  amount_y?: number;
  strategy?: string;
  single_sided_x?: boolean;
}

export interface AddLiquidityResult {
  success: boolean;
  position?: string;
  pool?: string;
  amount_x?: number;
  amount_y?: number;
  txs?: string[];
  error?: string;
}

// ─── Withdraw Liquidity Types ───────────────────────────────────

export interface WithdrawLiquidityParams {
  position_address: string;
  pool_address: string;
  bps?: number;
  claim_fees?: boolean;
}

export interface WithdrawLiquidityResult {
  success: boolean;
  position?: string;
  pool?: string;
  bps?: number;
  amount_x_withdrawn?: number;
  amount_y_withdrawn?: number;
  fees_claimed?: number;
  txs?: string[];
  error?: string;
}

// ─── Position PnL Types ─────────────────────────────────────────

export interface PositionPnL {
  pnl_usd: number;
  pnl_pct: number;
  current_value_usd: number;
  unclaimed_fee_usd: number;
  all_time_fees_usd: number;
  fee_per_tvl_24h: number;
  in_range: boolean;
  lower_bin: number | null;
  upper_bin: number | null;
  active_bin: number | null;
  age_minutes: number | null;
  error?: string;
}

/** Raw PnL data from Meteora API */
export interface RawPnLData {
  positionAddress?: string;
  address?: string;
  position?: string;
  pnlUsd?: number;
  pnlPctChange?: number;
  pnlSol?: number;
  pnlSolPctChange?: number;
  unrealizedPnl?: {
    balances?: number;
    balancesSol?: number;
    unclaimedFeeTokenX?: {
      usd?: number;
      amountSol?: number;
    };
    unclaimedFeeTokenY?: {
      usd?: number;
      amountSol?: number;
    };
  };
  allTimeFees?: {
    total?: {
      usd?: number;
      sol?: number;
    };
  };
  allTimeDeposits?: {
    total?: {
      usd?: number;
      sol?: number;
    };
  };
  allTimeWithdrawals?: {
    total?: {
      usd?: number;
      sol?: number;
    };
  };
  feePerTvl24h?: number;
  isOutOfRange?: boolean;
  lowerBinId?: number;
  upperBinId?: number;
  poolActiveBinId?: number;
  createdAt?: number;
}

// ─── Position Data Types ────────────────────────────────────────

export interface PositionData {
  publicKey: PublicKey;
  positionData?: {
    lowerBinId?: number;
    upperBinId?: number;
    positionBinData?: Array<{
      positionLiquidity?: string;
    }>;
  };
}

export interface EnrichedPosition {
  position: string;
  pool: string;
  pair: string;
  base_mint: string;
  lower_bin: number | null;
  upper_bin: number | null;
  active_bin: number | null;
  in_range: boolean;
  unclaimed_fees_usd: number | null;
  total_value_usd: number | null;
  total_value_true_usd: number | null;
  collected_fees_usd: number | null;
  collected_fees_true_usd: number | null;
  pnl_usd: number | null;
  pnl_true_usd: number | null;
  pnl_pct: number | null;
  pnl_pct_derived: number | null;
  pnl_pct_diff: number | null;
  pnl_pct_suspicious: boolean;
  unclaimed_fees_true_usd: number | null;
  fee_per_tvl_24h: number | null;
  age_minutes: number | null;
  minutes_out_of_range: number;
  instruction: string | null;
}

export interface PositionsResult {
  wallet: string | null;
  total_positions: number;
  positions: EnrichedPosition[];
  error?: string;
}

// ─── Close Position Types ─────────────────────────────────────────

export interface CloseParams {
  position_address: string;
  reason?: string;
}

export interface CloseResult {
  success?: boolean;
  position?: string;
  pool?: string;
  pool_name?: string | null;
  claim_txs?: string[];
  close_txs?: string[];
  txs?: string[];
  pnl_usd?: number;
  pnl_pct?: number;
  base_mint?: string;
  error?: string;
  dry_run?: boolean;
  would_close?: string;
  message?: string;
  // Internal flags for middleware to trigger persistence
  _recordClose?: boolean;
  close_reason?: string;
  _recordPerformance?: boolean;
  _perf_data?: Record<string, unknown>;
}

// ─── Claim Fees Types ─────────────────────────────────────────────

export interface ClaimParams {
  position_address: string;
}

export interface ClaimResult {
  success?: boolean;
  position?: string;
  txs?: string[];
  base_mint?: string;
  error?: string;
  dry_run?: boolean;
  would_claim?: string;
  message?: string;
  // Internal flag for middleware to trigger recordClaim
  _recordClaim?: boolean;
}

// ─── Search Pools Types ───────────────────────────────────────────

export interface SearchPoolsParams {
  query: string;
  limit?: number;
}

export interface SearchPoolResult {
  pool: string;
  name: string;
  bin_step?: number;
  fee_pct?: number;
  tvl?: number;
  volume_24h?: number;
  token_x: {
    symbol?: string;
    mint?: string;
  };
  token_y: {
    symbol?: string;
    mint?: string;
  };
}

export interface SearchPoolsResult {
  query: string;
  total: number;
  pools: SearchPoolResult[];
}

// ─── Wallet Positions Types ───────────────────────────────────────

export interface WalletPositionsParams {
  wallet_address: string;
}

export interface WalletPosition {
  position: string;
  pool: string;
  lower_bin: number | null;
  upper_bin: number | null;
  active_bin: number | null;
  in_range: boolean | null;
  unclaimed_fees_usd: number;
  total_value_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  age_minutes: number | null;
}

export interface WalletPositionsResult {
  wallet: string;
  total_positions: number;
  positions: WalletPosition[];
  error?: string;
}

// ─── Active Bin Types ─────────────────────────────────────────────

export interface ActiveBinParams {
  pool_address: string;
}

export interface ActiveBinResult {
  binId: number;
  price: number;
  pricePerLamport: string;
}

// ─── Cache Types ──────────────────────────────────────────────────

export interface PoolCache {
  get(key: string): DLMMPool | undefined;
  set(key: string, value: DLMMPool): void;
  delete(key: string): boolean;
  clear(): void;
}
