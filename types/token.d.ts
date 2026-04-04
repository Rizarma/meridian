// types/token.d.ts
// Token information and holder analysis types

// Token Narrative
export interface TokenNarrativeInput {
  mint: string;
}

export interface TokenNarrative {
  mint: string;
  narrative: string | null;
  status: string;
}

// Token Info
export interface TokenInfoInput {
  query: string;
}

export interface TokenAudit {
  mint_disabled: boolean;
  freeze_disabled: boolean;
  top_holders_pct: string | null;
  bot_holders_pct: string | null;
  dev_migrations: unknown;
}

export interface TokenStats1h {
  price_change: string | null;
  buy_vol: string | null;
  sell_vol: string | null;
  buyers: number;
  net_buyers: number;
}

export interface TokenCluster {
  has_kol: boolean;
  trend: string;
  holding_pct: number;
  [key: string]: unknown;
}

export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  mcap: number;
  price: number;
  liquidity: number;
  holders: number;
  organic_score: number;
  organic_label: string;
  launchpad: string;
  graduated: boolean;
  global_fees_sol: number | null;
  audit: TokenAudit | null;
  stats_1h: TokenStats1h | null;
  stats_24h_net_buyers: number | null;
  // OKX enriched fields
  risk_level?: number;
  bundle_pct?: number;
  sniper_pct?: number;
  suspicious_pct?: number;
  new_wallet_pct?: number;
  smart_money_buy?: boolean;
  tags?: string[];
  kol_in_clusters?: boolean;
  top_cluster_trend?: string | null;
  clusters?: TokenCluster[];
}

export interface TokenInfoResult {
  found: boolean;
  query: string;
  results?: TokenInfo[];
}

// Token Holders
export interface TokenHoldersInput {
  mint: string;
  limit?: number;
}

export interface TokenHolderFunding {
  address: string;
  amount: number;
  slot: number;
}

export interface TokenHolder {
  address: string;
  amount: number;
  pct: number | null;
  sol_balance: number | null;
  tags?: string[];
  is_pool?: boolean;
  funding?: TokenHolderFunding;
}

export interface SmartWalletHoldingPnl {
  balance: number;
  balance_usd: number;
  avg_cost: number;
  realized_pnl: number;
  unrealized_pnl: number;
  total_pnl: number;
  total_pnl_pct: number;
  buys: number;
  sells: number;
  wins: number;
  bought_value: number;
  sold_value: number;
  first_active: string;
  last_active: string;
  holding_days: number | null;
}

export interface SmartWalletHolding {
  name: string;
  category: string;
  address: string;
  pct: number | null;
  sol_balance: number | null;
  pnl: SmartWalletHoldingPnl | null;
}

export interface TokenHoldersResult {
  mint: string;
  global_fees_sol: number | null;
  total_fetched: number;
  showing: number;
  top_10_real_holders_pct: string;
  risk_level: number | null;
  bundle_pct: number | null;
  sniper_pct: number | null;
  suspicious_pct: number | null;
  new_wallet_pct: number | null;
  smart_wallets_holding: SmartWalletHolding[];
  holders: TokenHolder[];
}
