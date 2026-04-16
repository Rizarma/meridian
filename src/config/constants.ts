/**
 * Constants — Centralized location for all hardcoded values.
 *
 * This module consolidates magic numbers from across the codebase
 * to make them discoverable and maintainable.
 *
 * Pattern: Single Responsibility Principle — configuration values
 * that don't need runtime mutation are defined here.
 */

// ═══════════════════════════════════════════
//  TIME CONSTANTS (milliseconds)
// ═══════════════════════════════════════════

export const TIME = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
} as const;

// ═══════════════════════════════════════════
//  CYCLE INTERVALS
// ═══════════════════════════════════════════

export const CYCLE = {
  /** Cooldown between management-triggered screening (milliseconds) */
  SCREENING_COOLDOWN_MS: 5 * TIME.MINUTE,
  /** Polling interval for trailing TP checks (milliseconds) */
  PNL_POLL_INTERVAL_MS: 30 * TIME.SECOND,
  /** Default health check interval (minutes) */
  HEALTH_CHECK_INTERVAL_MIN: 60,
  /** Default briefing hour in UTC (1 = 1:00 AM UTC) */
  BRIEFING_HOUR_UTC: 1,
  /** Briefing watchdog interval (hours) */
  BRIEFING_WATCHDOG_INTERVAL_HOURS: 6,
} as const;

// ═══════════════════════════════════════════
//  TIMEOUTS
// ═══════════════════════════════════════════

export const TIMEOUT = {
  /** Shutdown timeout (milliseconds) */
  SHUTDOWN_MS: 5 * TIME.SECOND,
  /** RPC/LLM timeout (milliseconds) */
  RPC_TIMEOUT_MS: 5 * TIME.MINUTE,
  /** API timeout (milliseconds) */
  API_TIMEOUT_MS: 10 * TIME.SECOND,
  /** Log flush delay on shutdown (milliseconds) */
  LOG_FLUSH_MS: 100,
  /** Startup warning display delay (milliseconds) */
  STARTUP_WARN_MS: 2000,
} as const;

// ═══════════════════════════════════════════
//  RETRY CONFIGURATION
// ═══════════════════════════════════════════

export const RETRY = {
  /** Max consecutive PnL poll failures before backing off */
  MAX_PNL_POLL_FAILURES: 5,
  /** Max retries for RPC calls */
  MAX_RPC_RETRIES: 3,
  /** Max retries for API calls */
  MAX_API_RETRIES: 3,
  /** Backoff multiplier for retries */
  BACKOFF_MULTIPLIER: 2,
  /** Base wait time for retries (milliseconds) */
  BASE_RETRY_WAIT_MS: 5 * TIME.SECOND,
  /** Max no-tool retries before giving up */
  MAX_NO_TOOL_RETRIES: 2,
} as const;

// ═══════════════════════════════════════════
//  SCREENING DEFAULTS
// ═══════════════════════════════════════════

export const SCREENING = {
  /** Default minimum bin step */
  DEFAULT_MIN_BIN_STEP: 20,
  /** Default maximum bin step */
  DEFAULT_MAX_BIN_STEP: 200,
  /** Default max positions */
  DEFAULT_MAX_POSITIONS: 5,
  /** Default max candidates to enrich */
  DEFAULT_MAX_CANDIDATES_ENRICHED: 10,
  /** Default max bot holders percentage */
  DEFAULT_MAX_BOT_HOLDERS_PCT: 30,
  /** Delay between recon calls (milliseconds) */
  RECON_DELAY_MS: 150,
  /** Default max candidates to show */
  DEFAULT_MAX_CANDIDATES: 20,
} as const;

// ═══════════════════════════════════════════
//  RISK LIMITS
// ═══════════════════════════════════════════

export const RISK = {
  /** Default max deploy amount (SOL) */
  DEFAULT_MAX_DEPLOY_AMOUNT: 50,
  /** Default min deploy amount (SOL) */
  DEFAULT_MIN_DEPLOY_AMOUNT: 0.1,
  /** Default gas reserve (SOL) */
  DEFAULT_GAS_RESERVE: 0.2,
  /** Minimum gas reserve fallback (SOL) */
  MIN_GAS_RESERVE_FALLBACK: 0.01,
  /** Default position size percentage */
  DEFAULT_POSITION_SIZE_PCT: 0.35,
} as const;

// ═══════════════════════════════════════════
//  LLM CONFIGURATION
// ═══════════════════════════════════════════

export const LLM = {
  /** Default max ReAct steps */
  DEFAULT_MAX_STEPS: 20,
  /** Default temperature */
  DEFAULT_TEMPERATURE: 0.373,
  /** Default max tokens */
  DEFAULT_MAX_TOKENS: 4096,
  /** Default max output tokens for screening */
  DEFAULT_SCREENING_MAX_TOKENS: 2048,
  /** Max prompt length for sanitization */
  MAX_PROMPT_LENGTH: 10000,
} as const;

// ═══════════════════════════════════════════
//  VALIDATION LIMITS
// ═══════════════════════════════════════════

export const LIMITS = {
  /** Max log length before truncation */
  MAX_LOG_LENGTH: 1000,
  /** Max note/reason length */
  MAX_NOTE_LENGTH: 500,
  /** Max sanitized prompt length */
  MAX_PROMPT_SANITIZE_LENGTH: 500,
  /** Max candidate name length */
  MAX_CANDIDATE_NAME_LENGTH: 100,
  /** Max slippage bps */
  MAX_SLIPPAGE_BPS: 10000,
  /** Min slippage bps */
  MIN_SLIPPAGE_BPS: 0,
  /** Max instruction length */
  MAX_INSTRUCTION_LENGTH: 280,
  /** Max recent events to keep */
  MAX_RECENT_EVENTS: 20,
} as const;

// Re-export individual limits for backward compatibility
export const MAX_INSTRUCTION_LENGTH = LIMITS.MAX_INSTRUCTION_LENGTH;
export const MAX_RECENT_EVENTS = LIMITS.MAX_RECENT_EVENTS;

// ═══════════════════════════════════════════
//  CACHE CONFIGURATION
// ═══════════════════════════════════════════

export const CACHE = {
  /** Cleanup interval (milliseconds) */
  CLEANUP_INTERVAL_MS: 60000,
} as const;

// ═══════════════════════════════════════════
//  TRAILING TAKE-PROFIT TIMING
// ═══════════════════════════════════════════

/** Delay before confirming a peak PnL for trailing TP (milliseconds) */
export const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;

/** Tolerance ratio for peak confirmation (0.85 = 85% of peak must hold) */
export const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;

/** Delay before confirming a trailing drop for exit (milliseconds) */
export const TRAILING_DROP_CONFIRM_DELAY_MS = 15_000;

/** Tolerance percentage for trailing drop confirmation */
export const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;

/** Trailing exit cooldown after confirmation (milliseconds) */
export const TRAILING_EXIT_COOLDOWN_MS = 5 * TIME.MINUTE;

// ═══════════════════════════════════════════
//  STATE MANAGEMENT
// ═══════════════════════════════════════════

/** Grace period after deployment before auto-close sync (milliseconds) */
export const SYNC_GRACE_PERIOD_MS = 5 * TIME.MINUTE;

// ═══════════════════════════════════════════
//  AGENT LOOP
// ═══════════════════════════════════════════

/** Maximum number of ReAct steps before forcing termination */
export const MAX_REACT_STEPS = 20;

/** Fallback LLM models to try on 502/503/529 errors */
export const FALLBACK_MODELS: string[] = ["stepfun/step-3.5-flash:free", "xiaomi/mimo-v2-omni"];

// ═══════════════════════════════════════════
//  TELEGRAM / UI
// ═══════════════════════════════════════════

/** Progress bar width in characters */
export const PROGRESS_BAR_WIDTH = 20;

// ═══════════════════════════════════════════
//  SAFETY & SANITY CHECKS
// ═══════════════════════════════════════════

/** PnL percentage threshold for suspect data flagging */
export const PNL_SUSPECT_THRESHOLD = -90;

/** Minimum position value in USD to consider for suspect PnL check */
export const MIN_POSITION_VALUE_USD = 0.01;

// ═══════════════════════════════════════════
//  BIN STEP LIMITS
// ═══════════════════════════════════════════

export const BIN_STEP = {
  MIN: 1,
  MAX: 1000,
} as const;

// ═══════════════════════════════════════════
//  BASIS POINTS
// ═══════════════════════════════════════════

export const BPS = {
  MIN: 1,
  MAX: 10000,
  FULL: 10000,
} as const;

// ═══════════════════════════════════════════
//  SOLANA ADDRESS
// ═══════════════════════════════════════════

export const SOLANA = {
  MIN_ADDRESS_LENGTH: 32,
  MAX_ADDRESS_LENGTH: 44,
} as const;
