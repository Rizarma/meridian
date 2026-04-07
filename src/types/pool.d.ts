// types/pool.d.ts

export interface PoolBase {
  mint: string;
  symbol?: string;
  name?: string;
  decimals?: number;
}

export interface Pool {
  pool: string;
  name: string;
  bin_step: number;
  fee_pct: number;
  fee_active_tvl_ratio: number;
  volume_window: number;
  active_tvl: number;
  volatility: number;
  mcap: number;
  organic_score: number;
  token_age_hours?: number;
  base?: PoolBase;
  quote?: PoolBase;
  // OKX enrichment fields
  risk_level?: number;
  bundle_pct?: number;
  sniper_pct?: number;
  suspicious_pct?: number;
  new_wallet_pct?: number;
  is_rugpull?: boolean;
  is_wash?: boolean;
  smart_money_buy?: boolean;
  kol_in_clusters?: boolean;
  dex_boost?: boolean;
  dex_screener_paid?: boolean;
  dev_sold_all?: boolean;
  price_vs_ath_pct?: number;
  top_cluster_trend?: string;
}

export interface PoolCandidate extends Pool {
  active_pct?: number;
  fee_tvl_ratio?: number;
}

export interface ActiveBinResult {
  binId: number;
  price: number;
  pricePerToken: number;
}

export interface PoolMemory {
  deploys: PoolDeploy[];
  notes: string[];
  lastSnapshot?: PoolSnapshot;
}

export interface PoolDeploy {
  timestamp: string;
  amount_sol: number;
  strategy: string;
}

export interface PoolSnapshot {
  timestamp: string;
  tvl: number;
  volume_24h: number;
  fee_apr: number;
}

export interface PoolTopCandidatesResult {
  candidates: PoolCandidate[];
  total_eligible: number;
  total_screened: number;
  pools?: PoolCandidate[]; // Alternative field name
}
