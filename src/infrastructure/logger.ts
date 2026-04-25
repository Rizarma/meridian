import type { WriteStream } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import type { LogAction, LogCategory, LogSnapshot } from "../types/index.js";

const LOG_DIR = "./logs";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// Patterns to redact from logs (PII/secrets)
// SECURITY: These patterns must be kept in sync with test/regression/sanitize-message.test.ts
const SENSITIVE_PATTERNS = [
  // Solana keypair arrays: [12, 34, 56, ...] - 64+ byte arrays
  { pattern: /\[\s*(?:\d{1,3}\s*,\s*){63,}\d{1,3}\s*\]/g, replacement: "[REDACTED_KEYPAIR]" },
  // Solana private keys (base58) - 32-44 chars
  { pattern: /[1-9A-HJ-NP-Za-km-z]{32,44}/g, replacement: "[REDACTED_KEY]" },
  // API keys (OpenAI/OpenRouter format: sk-...)
  { pattern: /sk-[a-zA-Z0-9_-]{20,}/g, replacement: "[REDACTED_API_KEY]" },
  // Generic API tokens (32+ alphanumeric with dashes/underscores)
  { pattern: /\b[a-zA-Z0-9_-]{32,}\b/g, replacement: "[REDACTED_TOKEN]" },
  // Hex secrets (32-64 chars)
  { pattern: /\b[a-f0-9]{32,64}\b/gi, replacement: "[REDACTED_HASH]" },
  // Long numbers (10+ digits, potentially IDs)
  { pattern: /\b\d{10,}\b/g, replacement: "[REDACTED_NUMBER]" },
];

/**
 * Sanitize log message by redacting sensitive patterns.
 * Exported for testing - DO NOT use outside of logging infrastructure.
 * @internal
 */
export function sanitizeMessage(message: string): string {
  let sanitized = message;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

/**
 * Validate timezone string. Returns the timezone if valid, otherwise falls back to UTC.
 */
function validateTimezone(tz: string): string {
  if (tz === "UTC") return tz;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    console.warn(`[logger] Invalid timezone "${tz}", falling back to UTC`);
    return "UTC";
  }
}
const LOG_TIMEZONE = validateTimezone(process.env.TZ || "UTC");

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? 1;

// Cache the Intl.DateTimeFormat instance for non-UTC timezones
const timestampFormatter =
  LOG_TIMEZONE === "UTC"
    ? null
    : new Intl.DateTimeFormat("en-US", {
        timeZone: LOG_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });

/**
 * Format timestamp in ISO-style with configured timezone.
 * Format: YYYY-MM-DDTHH:mm:ss (no Z suffix for local time)
 */
function formatTimestamp(date: Date = new Date()): string {
  if (LOG_TIMEZONE === "UTC") {
    return date.toISOString().replace("Z", "");
  }
  const parts = timestampFormatter!.formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Get UTC date string for file rotation (consistent across timezones).
 */
function getUTCDateString(date: Date = new Date()): string {
  return date.toISOString().split("T")[0];
}

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Module-level stream cache for file descriptor management
const _logStreams: Map<string, WriteStream> = new Map();
let _currentLogDate: string | null = null;

function getLogStream(dateStr: string, type: "agent" | "actions" | "snapshots"): WriteStream {
  const key = `${type}-${dateStr}`;
  const logFile = path.join(LOG_DIR, `${type}-${dateStr}.${type === "agent" ? "log" : "jsonl"}`);

  // Close streams from previous dates when date changes
  if (_currentLogDate !== dateStr && _currentLogDate !== null) {
    for (const [streamKey, stream] of _logStreams.entries()) {
      if (streamKey.endsWith(_currentLogDate)) {
        stream.end();
        _logStreams.delete(streamKey);
      }
    }
  }
  _currentLogDate = dateStr;

  // Create new stream if needed
  if (!_logStreams.has(key)) {
    const stream = fs.createWriteStream(logFile, { flags: "a" });
    _logStreams.set(key, stream);
  }

  const stream = _logStreams.get(key);
  if (!stream) {
    throw new Error(`Failed to create log stream for ${key}`);
  }
  return stream;
}

/**
 * Close all open log streams. Call this for graceful shutdown.
 */
export function closeLogStreams(): void {
  for (const stream of _logStreams.values()) {
    stream.end();
  }
  _logStreams.clear();
  _currentLogDate = null;
}

/**
 * General log function.
 *
 * @param category - Log category (e.g., 'startup', 'cron', 'error')
 * @param message - Log message
 */
export function log(category: LogCategory, message: string): void {
  const level = category.includes("error") ? "error" : category.includes("warn") ? "warn" : "info";

  if (LEVELS[level] < currentLevel) return;

  const now = new Date();
  const timestamp = formatTimestamp(now);
  const sanitizedMessage = sanitizeMessage(message);
  const line = `[${timestamp}] [${category.toUpperCase()}] ${sanitizedMessage}`;

  // Console output - data already sanitized via sanitizeMessage() above
  // CodeQL[js/clear-text-logging]: Intentional console output for user visibility with PII redaction
  console.log(line);

  // File output (daily rotation) - using persistent stream (UTC date for consistency)
  const dateStr = getUTCDateString(now);
  const stream = getLogStream(dateStr, "agent");
  stream.write(`${line}\n`);
}

/**
 * Generate a human-readable hint for an action log entry.
 */
function actionHint(action: LogAction): string {
  const a = (action.args ?? {}) as Record<string, unknown>;
  const r = (action.result ?? {}) as Record<string, unknown>;
  switch (action.tool) {
    case "deploy_position":
      return ` ${(a.pool_name as string) || (a.pool_address as string)?.slice(0, 8)} ${a.amount_sol} SOL`;
    case "close_position":
      return ` ${(a.position_address as string)?.slice(0, 8)}${r.pnl_usd != null ? ` | PnL $${(r.pnl_usd as number) >= 0 ? "+" : ""}${r.pnl_usd} (${r.pnl_pct}%)` : ""}`;
    case "claim_fees":
      return ` ${(a.position_address as string)?.slice(0, 8)}`;
    case "get_active_bin":
      return ` bin ${r.binId ?? ""}`;
    case "get_pool_detail":
      return ` ${(r.name as string) || (a.pool_address as string)?.slice(0, 8) || ""}`;
    case "get_my_positions":
      return ` ${(r.total_positions as number) ?? ""} positions`;
    case "get_wallet_balance":
      return ` ${(r.sol as number) ?? ""} SOL`;
    case "get_top_candidates":
      return ` ${(r?.candidates as unknown[])?.length ?? ""} pools`;
    case "swap_token":
      return ` ${a.amount} ${(a.input_mint as string)?.slice(0, 6)}→SOL`;
    case "update_config":
      return ` ${Object.keys((r.applied as Record<string, unknown>) || {}).join(", ")}`;
    case "add_lesson":
      return ` saved`;
    case "clear_lessons":
      return ` cleared ${(r.cleared as number) ?? ""}`;
    default:
      return "";
  }
}

/**
 * Deep sanitize an object by redacting sensitive patterns in all string values.
 */
function sanitizeObject<T>(obj: T): T {
  if (typeof obj === "string") {
    return sanitizeMessage(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject) as unknown as T;
  }
  if (obj !== null && typeof obj === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeObject(value);
    }
    return sanitized as T;
  }
  return obj;
}

/**
 * Log a tool action with full details (for audit trail).
 */
export function logAction(action: LogAction): void {
  const now = new Date();
  const timestamp = formatTimestamp(now);

  // Sanitize any sensitive data in the action entry
  const entry = sanitizeObject({ timestamp, ...action });

  // Console: single clean line, no raw JSON
  const status = action.success ? "✓" : "✗";
  const dur = action.duration_ms != null ? ` (${action.duration_ms}ms)` : "";
  const hint = actionHint(action);
  console.log(`[${action.tool}] ${status}${hint}${dur}`);

  // File: full JSON for audit trail - using persistent stream (UTC date for consistency)
  const dateStr = getUTCDateString(now);
  const stream = getLogStream(dateStr, "actions");
  stream.write(`${JSON.stringify(entry)}\n`);
}

/**
 * Log a portfolio snapshot (for tracking performance over time).
 *
 * @param snapshot - Portfolio snapshot data
 */
export function logSnapshot(snapshot: LogSnapshot): void {
  const now = new Date();
  const timestamp = formatTimestamp(now);

  const entry = {
    timestamp,
    ...snapshot,
  };

  // File output - using persistent stream (UTC date for consistency)
  const dateStr = getUTCDateString(now);
  const stream = getLogStream(dateStr, "snapshots");
  stream.write(`${JSON.stringify(entry)}\n`);
}
