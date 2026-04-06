// types/cli.d.ts
// CLI types for meridian command-line interface

import { PoolCandidate } from "./screening.js";
import { PositionInfo } from "./dlmm.js";
import { TokenInfoResult } from "./token.js";
import { SmartWalletInPool } from "./smart-wallets.js";
import { PoolMemoryEntry } from "./pool-memory.js";

/** CLI flag definitions from parseArgs */
export interface CLIFlags {
  pool?: string;
  amount?: string;
  position?: string;
  from?: string;
  to?: string;
  strategy?: string;
  query?: string;
  mint?: string;
  wallet?: string;
  timeframe?: string;
  reason?: string;
  "bins-below"?: string;
  "bins-above"?: string;
  "amount-x"?: string;
  "amount-y"?: string;
  bps?: string;
  "no-claim"?: boolean;
  "skip-swap"?: boolean;
  "dry-run"?: boolean;
  silent?: boolean;
  limit?: string;
}

/** Valid CLI subcommands */
export type CLISubcommand =
  | "balance"
  | "positions"
  | "pnl"
  | "candidates"
  | "token-info"
  | "token-holders"
  | "token-narrative"
  | "pool-detail"
  | "search-pools"
  | "active-bin"
  | "wallet-positions"
  | "deploy"
  | "claim"
  | "close"
  | "swap"
  | "screen"
  | "manage"
  | "config"
  | "study"
  | "start"
  | "lessons"
  | "pool-memory"
  | "evolve"
  | "blacklist"
  | "performance"
  | "withdraw-liquidity"
  | "add-liquidity"
  | "help";

/** Enriched candidate with full metadata */
export interface EnrichedCandidate {
  pool: string;
  name: string;
  bin_step: number;
  fee_pct: number;
  fee_active_tvl_ratio?: number;
  volume: number;
  tvl: number;
  volatility?: number;
  mcap?: number;
  organic_score?: number;
  active_pct?: number;
  price_change_pct?: number;
  active_bin: number | null;
  smart_wallets: string[];
  token: {
    mint?: string;
    symbol?: string;
    holders?: number;
    mcap?: number;
    launchpad?: string;
    global_fees_sol?: number;
    price_change_1h?: number;
    net_buyers_1h?: number;
    audit?: {
      top10_pct?: number;
      bots_pct?: number;
    };
  };
  holders: unknown;
  narrative: string | null;
  pool_memory: string | null;
}

/** CLI output helper function type */
export type CLIOutputFn = (data: unknown) => void;

/** CLI error helper function type */
export type CLIDieFn = (msg: string, extra?: Record<string, unknown>) => never;

/** Candidates command output */
export interface CandidatesOutput {
  candidates: EnrichedCandidate[];
  total_screened: number;
}

/** Config get output */
export interface ConfigGetOutput {
  [key: string]: unknown;
}

/** Config set output */
export interface ConfigSetOutput {
  success: boolean;
  changes: Record<string, unknown>;
  reason: string;
}

/** Lessons list output */
export interface LessonsListOutput {
  total: number;
  lessons: Array<{
    id: string;
    rule: string;
    tags: string[];
    outcome: string;
    pinned: boolean;
    role: string | null;
    created_at: string;
  }>;
}

/** Lessons add output */
export interface LessonsAddOutput {
  saved: boolean;
  rule: string;
  outcome: string;
  role: string | null;
}

/** Pool memory output */
export interface PoolMemoryOutput {
  pool_address: string;
  known: boolean;
  name?: string;
  total_deploys: number;
  win_rate: number;
  avg_pnl_pct: number;
  last_outcome?: string;
  notes?: string[];
  history?: unknown[];
}

/** Evolve output */
export interface EvolveOutput {
  evolved: boolean;
  changes?: Record<string, unknown>;
  rationale?: string;
  reason?: string;
}

/** Blacklist add output */
export interface BlacklistAddOutput {
  blacklisted: boolean;
  mint: string;
  reason: string;
}

/** Blacklist list output */
export interface BlacklistListOutput {
  count: number;
  blacklist: Array<{
    mint: string;
    symbol?: string;
    reason: string;
    added_at: string;
  }>;
}

/** Performance output */
export interface PerformanceOutput {
  summary: {
    total_positions_closed: number;
    total_pnl_usd: number;
    avg_pnl_pct: number;
    win_rate_pct: number;
    total_lessons: number;
  };
  count: number;
  positions: unknown[];
}

/** Screen/manage output */
export interface CycleOutput {
  done: boolean;
  report: string;
}
