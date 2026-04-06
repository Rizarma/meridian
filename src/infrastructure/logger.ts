import fs from "fs";
import path from "path";
import type { LogAction, LogCategory, LogSnapshot } from "../types/index.js";

const LOG_DIR = "./logs";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? 1;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
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

  // File output (daily rotation)
  const dateStr = timestamp.split("T")[0];
  const logFile = path.join(LOG_DIR, `agent-${dateStr}.log`);
  fs.appendFileSync(logFile, line + "\n");
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

  // File: full JSON for audit trail
  const dateStr = timestamp.split("T")[0];
  const actionsFile = path.join(LOG_DIR, `actions-${dateStr}.jsonl`);
  fs.appendFileSync(actionsFile, JSON.stringify(entry) + "\n");
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

  const dateStr = timestamp.split("T")[0];
  const snapshotFile = path.join(LOG_DIR, `snapshots-${dateStr}.jsonl`);
  fs.appendFileSync(snapshotFile, JSON.stringify(entry) + "\n");
}
