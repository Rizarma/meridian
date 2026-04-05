// types/okx.d.ts
// OKX DEX API types for token analysis

export interface OKXRiskEntry {
  riskKey?: string;
  newRiskLabel?: string;
  riskType?: string;
}

export interface OKXRiskAnalysis {
  allAnalysis?: {
    highRiskList?: OKXRiskEntry[];
    middleRiskList?: OKXRiskEntry[];
    lowRiskList?: OKXRiskEntry[];
  };
  swapAnalysis?: {
    highRiskList?: OKXRiskEntry[];
    middleRiskList?: OKXRiskEntry[];
    lowRiskList?: OKXRiskEntry[];
  };
  contractAnalysis?: {
    highRiskList?: OKXRiskEntry[];
    middleRiskList?: OKXRiskEntry[];
    lowRiskList?: OKXRiskEntry[];
  };
  extraAnalysis?: {
    highRiskList?: OKXRiskEntry[];
    middleRiskList?: OKXRiskEntry[];
    lowRiskList?: OKXRiskEntry[];
  };
  riskLevel?: number;
  riskControlLevel?: number;
}

export interface OKXRiskFlags {
  is_rugpull: boolean;
  is_wash: boolean;
  risk_level: number | null;
  source: string;
}

export interface OKXAdvancedInfo {
  riskControlLevel?: string;
  bundleHoldingPercent?: string;
  sniperHoldingPercent?: string;
  suspiciousHoldingPercent?: string;
  devHoldingPercent?: string;
  top10HoldPercent?: string;
  lpBurnedPercent?: string;
  totalFee?: string;
  devRugPullTokenCount?: string;
  devCreateTokenCount?: string;
  creatorAddress?: string;
  tokenTags?: string[];
}

export interface OKXAdvancedResult {
  risk_level: number | null;
  bundle_pct: number | null;
  sniper_pct: number | null;
  suspicious_pct: number | null;
  dev_holding_pct: number | null;
  top10_pct: number | null;
  lp_burned_pct: number | null;
  total_fee_sol: number | null;
  dev_rug_count: number | null;
  dev_token_count: number | null;
  creator: string | null;
  tags: string[];
  is_honeypot: boolean;
  smart_money_buy: boolean;
  dev_sold_all: boolean;
  dev_buying_more: boolean;
  low_liquidity: boolean;
  dex_boost: boolean;
  dex_screener_paid: boolean;
}

export interface OKXClusterAddress {
  isKol?: boolean;
  address?: string;
}

export interface OKXCluster {
  holdingPercent?: string;
  trendType?:
    | {
        trendType?: string;
      }
    | string;
  averageHoldingPeriod?: string;
  pnlPercent?: string;
  buyVolume?: string;
  sellVolume?: string;
  averageBuyPriceUsd?: string;
  clusterAddressList?: OKXClusterAddress[];
}

export interface OKXClusterResult {
  holding_pct: number | null;
  trend: string | null;
  avg_hold_days: number | null;
  pnl_pct: number | null;
  buy_vol_usd: number | null;
  sell_vol_usd: number | null;
  avg_buy_price: number | null;
  has_kol: boolean;
  address_count: number;
}

export interface OKXPriceData {
  price?: string;
  maxPrice?: string;
  minPrice?: string;
  priceChange5M?: string;
  priceChange1H?: string;
  volume5M?: string;
  volume1H?: string;
  holders?: string;
  marketCap?: string;
  liquidity?: string;
}

export interface OKXPriceResult {
  price: number;
  ath: number;
  atl: number;
  price_vs_ath_pct: number | null;
  price_change_5m: number | null;
  price_change_1h: number | null;
  volume_5m: number | null;
  volume_1h: number | null;
  holders: number | null;
  market_cap: number | null;
  liquidity: number | null;
}

export interface OKXFullAnalysis {
  advanced: OKXAdvancedResult | null;
  clusters: OKXClusterResult[];
  price: OKXPriceResult | null;
}
