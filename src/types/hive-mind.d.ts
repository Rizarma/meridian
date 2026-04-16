// types/hive-mind.d.ts
// Hive Mind collective intelligence types

// ─── Configuration Types ─────────────────────────────────────────

export interface HiveMindConfig {
  // SECURITY: All Hive Mind config is ONLY read from environment variables.
  // Never stored in user-config.json. Set in .env:
  //   HIVE_MIND_URL, HIVE_MIND_API_KEY, HIVE_MIND_AGENT_ID
  hiveMindUrl?: string; // From process.env.HIVE_MIND_URL only
  hiveMindApiKey?: string; // From process.env.HIVE_MIND_API_KEY only
  hiveMindAgentId?: string; // From process.env.HIVE_MIND_AGENT_ID only
  displayName?: string;
  // Screening thresholds (copied from config for sync)
  minFeeActiveTvlRatio?: number;
  minTvl?: number;
  maxTvl?: number;
  minOrganic?: number;
  minHolders?: number;
  minBinStep?: number;
  maxBinStep?: number;
  minVolume?: number;
  minMcap?: number;
  stopLossPct?: number;
  emergencyPriceDropPct?: number;
  takeProfitFeePct?: number;
}

// ─── Sync Payload Types ────────────────────────────────────────────

export interface HiveThresholds {
  minFeeActiveTvlRatio?: number;
  minTvl?: number;
  maxTvl?: number;
  minOrganic?: number;
  minHolders?: number;
  minBinStep?: number;
  maxBinStep?: number;
  minVolume?: number;
  minMcap?: number;
  stopLossPct?: number;
  takeProfitFeePct?: number;
}

export interface HiveDeploy {
  pool_address: string;
  pool_name?: string;
  deployed_at?: string;
  closed_at?: string;
  pnl_pct?: number;
  pnl_usd?: number;
  range_efficiency?: number;
  minutes_held?: number;
  close_reason?: string;
  strategy?: string;
  volatility?: number;
  base_mint?: string;
}

export interface HiveLesson {
  id: number;
  rule: string;
  tags: string[];
  outcome: string;
  created_at: string;
  pinned?: boolean;
  role?: string | null;
}

export interface HiveAgentStats {
  total_positions_closed: number;
  total_pnl_usd: number;
  avg_pnl_pct: number;
  avg_range_efficiency_pct: number;
  win_rate_pct: number;
  total_lessons: number;
}

export interface SyncPayload {
  lessons: HiveLesson[];
  deploys: HiveDeploy[];
  thresholds: HiveThresholds;
  agentStats: HiveAgentStats | null;
}

export interface SyncResult {
  lessons_upserted: number;
  deploys_upserted: number;
}

// ─── Consensus Types ─────────────────────────────────────────────

export interface PoolConsensus {
  pool_address: string;
  pool_name?: string;
  unique_agents: number;
  weighted_win_rate?: number;
  weighted_avg_pnl?: number;
  total_deploys?: number;
  avg_hold_time_minutes?: number;
}

export interface LessonConsensus {
  id: string;
  rule: string;
  consensus_score: number;
  agent_count: number;
  tags: string[];
}

export interface PatternConsensus {
  volatility_range: string;
  avg_pnl_pct: number;
  win_rate_pct: number;
  recommended_strategy?: string;
  agent_count: number;
}

export interface ThresholdConsensus {
  minFeeActiveTvlRatio: { median: number; spread: number };
  minOrganic: { median: number; spread: number };
  minVolume: { median: number; spread: number };
  minTvl: { median: number; spread: number };
  agent_count: number;
}

// ─── Hive Pulse Types ────────────────────────────────────────────

export interface HivePulse {
  total_agents: number;
  active_agents_24h: number;
  total_lessons: number;
  total_deploys: number;
  avg_agent_pnl_pct: number;
  top_performing_pools: Array<{
    pool_address: string;
    pool_name: string;
    avg_pnl_pct: number;
  }>;
  consensus_strength: number;
}

// ─── Registration Types ───────────────────────────────────────────

export interface RegistrationParams {
  display_name: string;
  registration_token: string;
}

export interface RegistrationResult {
  agent_id: string;
  api_key: string;
}
