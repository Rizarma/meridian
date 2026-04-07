// types/screening.d.ts
// Pool screening and discovery types

import type { PoolMemoryEntry } from "./pool-memory.js";

// Pool Discovery
export interface DiscoverPoolsInput {
  page_size?: number;
}

export interface PoolTokenInfo {
  symbol: string;
  mint: string;
  organic: number;
  warnings: number;
}

export interface CondensedPool {
  pool: string;
  name: string;
  base: PoolTokenInfo;
  quote: {
    symbol: string;
    mint: string;
  };
  pool_type: string;
  bin_step: number | null;
  fee_pct: number;
  active_tvl: number | null;
  fee_window: number | null;
  volume_window: number | null;
  fee_active_tvl_ratio: number | null;
  volatility: number | null;
  holders: number;
  mcap: number | null;
  organic_score: number;
  token_age_hours: number | null;
  dev: string | null;
  active_positions: number;
  active_pct: number | null;
  open_positions: number;
  price: number;
  price_change_pct: number | null;
  price_trend: string | null;
  min_price: number;
  max_price: number;
  volume_change_pct: number | null;
  fee_change_pct: number | null;
  swap_count: number;
  unique_traders: number;
  // OKX enriched fields
  risk_level?: number | null;
  bundle_pct?: number | null;
  sniper_pct?: number | null;
  suspicious_pct?: number | null;
  new_wallet_pct?: number | null;
  smart_money_buy?: boolean;
  dev_sold_all?: boolean;
  dex_boost?: boolean;
  dex_screener_paid?: boolean;
  is_rugpull?: boolean;
  is_wash?: boolean;
  price_vs_ath_pct?: number | null;
  ath?: number | null;
  kol_in_clusters?: boolean;
  top_cluster_trend?: string | null;
  top_cluster_hold_pct?: number | null;
}

export interface DiscoverPoolsResult {
  total: number;
  pools: CondensedPool[];
}

// Top Candidates
export interface TopCandidatesInput {
  limit?: number;
}

export interface FilteredExample {
  pool_address: string;
  name: string;
  filter_reason: string;
}

export interface TopCandidatesResult {
  candidates: CondensedPool[];
  total_eligible: number;
  total_screened: number;
  filtered_examples: FilteredExample[];
}

// Pool Detail
export interface PoolDetailInput {
  pool_address: string;
  timeframe?: string;
}

// Raw pool data from API (for internal use)
export interface RawPoolData {
  pool_address: string;
  name: string;
  token_x?: {
    symbol: string;
    address: string;
    organic_score?: number;
    warnings?: unknown[];
    market_cap?: number;
    created_at?: number;
    dev?: string;
  };
  token_y?: {
    symbol: string;
    address: string;
  };
  pool_type: string;
  dlmm_params?: {
    bin_step?: number;
  };
  fee_pct: number;
  active_tvl?: number;
  fee?: number;
  volume?: number;
  fee_active_tvl_ratio?: number;
  volatility?: number;
  base_token_holders?: number;
  organic_score?: number;
  active_positions?: number;
  active_positions_pct?: number;
  open_positions?: number;
  pool_price: number;
  pool_price_change_pct?: number;
  price_trend?: string;
  min_price: number;
  max_price: number;
  volume_change_pct?: number;
  fee_change_pct?: number;
  swap_count?: number;
  unique_traders?: number;
}
