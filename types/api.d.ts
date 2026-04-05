// types/api.d.ts

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
