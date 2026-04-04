// types/api.d.ts

// Token info from Jupiter API
export interface TokenAudit {
  bot_holders_pct?: number;
  top_holders_pct?: number;
  common_funder?: boolean;
  funded_same_window?: boolean;
}

export interface TokenStats1h {
  price_change?: number;
  net_buyers?: number;
}

export interface TokenInfo {
  address: string;
  symbol?: string;
  name?: string;
  launchpad?: string | null;
  global_fees_sol?: number;
  audit?: TokenAudit;
  stats_1h?: TokenStats1h;
}

export interface TokenInfoResult {
  results?: TokenInfo[];
}

export interface TokenNarrative {
  narrative?: string;
  source?: string;
}

// Smart wallet types
export interface SmartWallet {
  address: string;
  name?: string;
  tags?: string[];
}

export interface SmartWalletCheck {
  in_pool: SmartWallet[];
  total_tracked: number;
}

// Study/LPer types
export interface LPerPosition {
  address: string;
  value_usd: number;
  pnl_pct: number;
  hold_duration_hours: number;
}

export interface TopLPerStudy {
  pool: string;
  lpers: LPerPosition[];
  patterns?: string[];
}

// Lessons types
export interface PerformanceRecord {
  position: string;
  pool: string;
  pnl_pct: number;
  hold_duration_hours: number;
  timestamp: number;
  exit_reason?: string;
}

export interface Lesson {
  id: string;
  text: string;
  category: string;
  pinned: boolean;
  created_at: number;
}

export interface PerformanceSummary {
  total_positions_closed: number;
  win_rate_pct: number;
  avg_pnl_pct: number;
  avg_hold_duration_hours: number;
}
