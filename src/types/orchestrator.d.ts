// types/orchestrator.d.ts
// Types for index.js - cron orchestration, cycles, and REPL

import type { ScheduledTask } from "node-cron";
import type { Interface as ReadlineInterface } from "readline";
import type { CondensedPool } from "./screening.js";
import type { EnrichedPosition } from "./dlmm.js";

/** Cycle timer tracking */
export interface CycleTimers {
  managementLastRun: number | null;
  screeningLastRun: number | null;
}

/** Action decisions for position management */
export type ActionType = "CLOSE" | "CLAIM" | "STAY" | "INSTRUCTION";

export interface ActionDecision {
  action: ActionType;
  rule?: number | string;
  reason?: string;
}

/** Telegram message structure */
export interface TelegramMessage {
  text?: string;
  chat?: {
    id: number;
  };
  message_id?: number;
  [key: string]: unknown;
}

/** Cron task from node-cron */
export interface CronTask extends ScheduledTask {
  stop: () => void;
  start: () => void;
}

/** Cron task array */
export interface CronTaskList extends Array<CronTask> {}

/** Candidate with recon data */
export interface ReconCandidate {
  pool: CondensedPool;
  sw: unknown;
  n: unknown;
  ti: unknown;
  mem: string | null;
}

/** Active bin result from promise settlement */
export interface ActiveBinResult {
  status: "fulfilled" | "rejected";
  value?: {
    binId: number;
    price: number;
  } | null;
}

/** Smart wallet check result */
export interface SmartWalletResult {
  status: "fulfilled" | "rejected";
  value?: {
    in_pool: Array<{ name: string; address: string }>;
  } | null;
}

/** Token narrative result */
export interface NarrativeResult {
  status: "fulfilled" | "rejected";
  value?: {
    narrative?: string;
  } | null;
}

/** Token info result */
export interface TokenInfoResult {
  status: "fulfilled" | "rejected";
  value?: {
    results?: Array<{
      launchpad?: string;
      audit?: {
        bot_holders_pct?: number;
        top_holders_pct?: number;
      };
      global_fees_sol?: number;
      stats_1h?: {
        price_change?: number;
        net_buyers?: number;
      };
    }>;
  } | null;
}

/** Cycle run options */
export interface CycleOptions {
  silent?: boolean;
}

/** Management cycle report */
export interface ManagementReport {
  report: string;
  positions: EnrichedPosition[];
}

/** Screening cycle result */
export interface ScreeningResult {
  report: string | null;
  candidates: ReconCandidate[];
}

/** REPL session state */
export interface SessionState {
  cronStarted: boolean;
  busy: boolean;
  telegramQueue: TelegramMessage[];
  sessionHistory: Array<{ role: string; content: string }>;
  startupCandidates: CondensedPool[];
}

/** Live message handler from Telegram */
export interface LiveMessageHandler {
  toolStart: (name: string) => Promise<void>;
  toolFinish: (name: string, result: unknown, success: boolean) => Promise<void>;
  note: (text: string) => Promise<void>;
  finalize: (text: string) => Promise<void>;
  fail: (error: string) => Promise<void>;
}
