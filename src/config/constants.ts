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

// ═══════════════════════════════════════════
//  STATE MANAGEMENT
// ═══════════════════════════════════════════

/** Maximum number of recent events to keep in state.json */
export const MAX_RECENT_EVENTS = 20;

/** Maximum length for stored instruction strings */
export const MAX_INSTRUCTION_LENGTH = 280;

/** Grace period after deployment before auto-close sync (milliseconds) */
export const SYNC_GRACE_PERIOD_MS = 5 * 60_000; // 5 minutes

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

/** Maximum length for sanitized prompt text */
export const MAX_SANITIZED_PROMPT_LENGTH = 500;

/** Progress bar width in characters */
export const PROGRESS_BAR_WIDTH = 20;

// ═══════════════════════════════════════════
//  SCREENING & MANAGEMENT CYCLES
// ═══════════════════════════════════════════

/** Cooldown between management-triggered screening (milliseconds) */
export const SCREENING_COOLDOWN_MS = 5 * 60_000; // 5 minutes

/** Polling interval for trailing TP checks (milliseconds) */
export const TRAILING_TP_POLL_INTERVAL_MS = 30_000; // 30 seconds

/** Default briefing hour in UTC (1 = 1:00 AM UTC) */
export const DEFAULT_BRIEFING_HOUR_UTC = 1;

// ═══════════════════════════════════════════
//  SAFETY & SANITY CHECKS
// ═══════════════════════════════════════════

/** PnL percentage threshold for suspect data flagging */
export const PNL_SUSPECT_THRESHOLD = -90;

/** Minimum position value in USD to consider for suspect PnL check */
export const MIN_POSITION_VALUE_USD = 0.01;

/** Trailing exit cooldown after confirmation (milliseconds) */
export const TRAILING_EXIT_COOLDOWN_MS = 5 * 60_000; // 5 minutes
