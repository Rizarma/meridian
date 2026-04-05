// types/study.d.ts
// LPAgent API study types for top LPer analysis

export interface LPerSummary {
  owner: string;
  total_lp: number;
  win_rate: number;
  total_inflow: number;
  roi: number;
  avg_age_hour: number;
  fee_percent: number;
  total_pnl: number;
}

export interface HistoricalPosition {
  pool: string;
  pairName?: string;
  tokenName0?: string;
  tokenName1?: string;
  ageHour?: number;
  pnl?: {
    value?: number;
    percent?: number;
  };
  collectedFee?: number;
  inRangePct?: number;
  strategy?: string;
  closeReason?: string;
}

export interface LPerHistoricalSample {
  owner: string;
  owner_short: string;
  summary: {
    total_positions: number;
    win_rate: string;
    avg_hold_hours: number | null;
    roi: string;
    fee_pct_of_capital: string;
    total_pnl_usd: number;
  };
  positions: Array<{
    pool: string;
    pair: string;
    hold_hours: number | null;
    pnl_usd: number;
    pnl_pct: string;
    fee_usd: number;
    in_range_pct: string | null;
    strategy: string | null;
    closed_reason: string | null;
  }>;
}

export interface StudyPatterns {
  top_lper_count: number;
  avg_hold_hours: number | null;
  avg_win_rate: number | null;
  avg_roi_pct: number | null;
  avg_fee_pct_of_capital: number | null;
  best_roi: string;
  scalper_count: number;
  holder_count: number;
}

export interface StudyResult {
  pool: string;
  message?: string;
  patterns: StudyPatterns | Record<string, never>;
  lpers: LPerHistoricalSample[];
}

export interface StudyOptions {
  pool_address: string;
  limit?: number;
}
