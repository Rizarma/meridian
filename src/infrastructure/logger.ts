import type { WriteStream } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import type { LogAction, LogCategory, LogSnapshot } from "../types/index.js";

const LOG_DIR = "./logs";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? 1;

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

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${category.toUpperCase()}] ${message}`;

  // Console output
  console.log(line);

  // File output (daily rotation) - using persistent stream
  const dateStr = timestamp.split("T")[0];
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
 * Log a tool action with full details (for audit trail).
 */
export function logAction(action: LogAction): void {
  const timestamp = new Date().toISOString();

  const entry = { timestamp, ...action };

  // Console: single clean line, no raw JSON
  const status = action.success ? "✓" : "✗";
  const dur = action.duration_ms != null ? ` (${action.duration_ms}ms)` : "";
  const hint = actionHint(action);
  console.log(`[${action.tool}] ${status}${hint}${dur}`);

  // File: full JSON for audit trail - using persistent stream
  const dateStr = timestamp.split("T")[0];
  const stream = getLogStream(dateStr, "actions");
  stream.write(`${JSON.stringify(entry)}\n`);
}

/**
 * Log a portfolio snapshot (for tracking performance over time).
 *
 * @param snapshot - Portfolio snapshot data
 */
export function logSnapshot(snapshot: LogSnapshot): void {
  const timestamp = new Date().toISOString();

  const entry = {
    timestamp,
    ...snapshot,
  };

  // File output - using persistent stream
  const dateStr = timestamp.split("T")[0];
  const stream = getLogStream(dateStr, "snapshots");
  stream.write(`${JSON.stringify(entry)}\n`);
}
