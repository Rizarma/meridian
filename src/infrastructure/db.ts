import path from "node:path";
import Database from "better-sqlite3";
import { PROJECT_ROOT } from "../config/paths.js";
import { log } from "./logger.js";

/** Whether SQL read debugging is enabled via env flag. */
const SQL_DEBUG_READS = process.env.SQL_DEBUG_READS === "true";

/** Max characters for SQL preview in debug logs. */
const MAX_SQL_PREVIEW = 200;

/** Max characters for row preview in debug logs. */
const MAX_ROW_PREVIEW = 500;

// ── Per-cycle SQL read statistics (only active when SQL_DEBUG_READS=true) ──

interface DbReadTableStats {
  count: number;
  empty: number;
  important: number;
}

interface DbReadStats {
  total: number;
  empty: number;
  tables: Map<string, DbReadTableStats>;
}

const _readStats: DbReadStats = { total: 0, empty: 0, tables: new Map() };

/** Record a read event into the in-memory counters (no-op when debug flag is off). */
function _recordReadStats(table: string, rowCount: number): void {
  if (!SQL_DEBUG_READS) return;
  _readStats.total++;
  if (rowCount === 0) _readStats.empty++;
  let ts = _readStats.tables.get(table);
  if (!ts) {
    ts = { count: 0, empty: 0, important: 0 };
    _readStats.tables.set(table, ts);
  }
  ts.count++;
  if (rowCount === 0) ts.empty++;
  if (IMPORTANT_TABLES.has(table)) ts.important++;
}

/** Reset accumulated SQL read statistics counters. */
export function resetDbReadDebugStats(): void {
  _readStats.total = 0;
  _readStats.empty = 0;
  _readStats.tables.clear();
}

/**
 * Flush a human-scannable summary of accumulated SQL read statistics, then reset.
 * Only produces output when `SQL_DEBUG_READS=true`.
 *
 * Format example:
 *   DB READ SUMMARY [management cycle] total=18 empty=4 tables=position_state=5 reads (1 empty, 5 important); strategies=3 reads (2 empty, 3 important)
 *   - Subparts (empty / important) are omitted when zero for brevity.
 *   - Tables sorted by descending read count.
 */
export function flushDbReadDebugSummary(context: string): void {
  if (!SQL_DEBUG_READS) return;
  if (_readStats.total === 0) return;

  const sorted = [..._readStats.tables.entries()].sort((a, b) => b[1].count - a[1].count);
  const tableParts = sorted.map(([table, ts]) => {
    const parts: string[] = [];
    if (ts.empty > 0) parts.push(`${ts.empty} empty`);
    if (ts.important > 0) parts.push(`${ts.important} important`);
    const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    return `${table}=${ts.count} reads${suffix}`;
  });
  const tablesStr = tableParts.join("; ");

  log(
    "db_read",
    `DB READ SUMMARY [${context}] total=${_readStats.total} empty=${_readStats.empty} tables=${tablesStr}`
  );

  // Extra summary: important tables with empty reads (sorted by descending empty count)
  const importantEmpty = [..._readStats.tables.entries()]
    .filter(([table, ts]) => IMPORTANT_TABLES.has(table) && ts.empty > 0)
    .sort((a, b) => b[1].empty - a[1].empty);

  if (importantEmpty.length > 0) {
    const detail = importantEmpty.map(([table, ts]) => `${table}=${ts.empty}`).join("; ");
    log("db_read_warn", `IMPORTANT EMPTY READS [${context}] ${detail}`);
  }

  resetDbReadDebugStats();
}

/**
 * Tables whose reads deserve an extra emphasized log line for easy scanning.
 * These are the core domain tables where empty reads or unexpected row counts
 * are operationally significant.
 */
const IMPORTANT_TABLES = new Set([
  "position_state",
  "position_state_events",
  "strategies",
  "pools",
  "positions",
  "lessons",
  "threshold_suggestions",
  "threshold_history",
  "signal_weights",
  "performance",
  "cycle_state",
]);

/**
 * Safely stringify a value for debug logging.
 * Handles BigInt, circular references, and truncates long output.
 */
function safeStringify(value: unknown, maxLength: number = MAX_ROW_PREVIEW): string {
  try {
    const s =
      typeof value === "string"
        ? value
        : JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
    return s.length > maxLength ? `${s.slice(0, maxLength)}… (${s.length} chars)` : s;
  } catch {
    return String(value).slice(0, maxLength);
  }
}

/** Lightweight SQL read summarizer — NOT a full parser. */
function summarizeReadSql(sql: string): { op: string; table: string; where: string } {
  const collapsed = sql.replace(/\s+/g, " ").trim().toLowerCase();

  // Detect operation
  const op = collapsed.startsWith("select") ? "select" : collapsed.split(" ")[0] || "?";

  // Extract main table: first token after "from" that isn't a keyword
  const fromMatch = collapsed.match(/\bfrom\s+([^\s,;()]+)/);
  const rawTable = fromMatch?.[1] ?? "?";
  // Filter out SQL keywords that can trail FROM
  const skipWords = new Set([
    "where",
    "group",
    "order",
    "limit",
    "offset",
    "having",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "on",
    "and",
    "or",
    "as",
    "not",
  ]);
  const table = skipWords.has(rawTable) ? "?" : rawTable;

  // Extract WHERE column names (best-effort)
  let where = "";
  const whereMatch = collapsed.match(
    /\bwhere\s+(.+?)(?:\s+group\s|\s+order\s|\s+limit\s|\s+having\s|$)/
  );
  if (whereMatch?.[1]) {
    const clause = whereMatch[1];
    // Pull identifiers immediately before "=","<",">","like","in","is","between","!="
    const colNames: string[] = [];
    const colRe = /([a-z_][a-z0-9_]*)\s*(?:=|!=|<>|<|>|like\b|in\b|is\b|between\b)/gi;
    let m: RegExpExecArray | null = colRe.exec(clause);
    while (m !== null) {
      const name = m[1];
      if (!skipWords.has(name) && name !== "not") {
        colNames.push(name);
      }
      m = colRe.exec(clause);
    }
    if (colNames.length > 0) {
      where = [...new Set(colNames)].join(",");
    }
  }

  return { op, table, where };
}

/**
 * Database file path.
 * Priority: MERIDIAN_DB env var > default in project root
 */
export const DB_PATH = process.env.MERIDIAN_DB
  ? path.resolve(process.env.MERIDIAN_DB)
  : path.join(PROJECT_ROOT, "meridian.db");

/**
 * Singleton database instance.
 * Initialized with WAL mode and foreign keys enabled.
 */
let dbInstance: Database.Database | null = null;

/**
 * Get or create the database instance.
 * Uses synchronous better-sqlite3 API.
 */
export function getDb(): Database.Database {
  if (!dbInstance) {
    dbInstance = new Database(DB_PATH);
    // Enable WAL mode for better concurrency
    dbInstance.pragma("journal_mode = WAL");
    // Auto-checkpoint every 1000 pages to prevent unbounded WAL growth
    dbInstance.pragma("wal_autocheckpoint = 1000");
    // Enable foreign key constraints
    dbInstance.pragma("foreign_keys = ON");
  }
  return dbInstance;
}

/**
 * Close the database connection.
 * Should be called on graceful shutdown.
 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Execute a query that returns multiple rows.
 * @param sql - SQL query string
 * @param params - Query parameters
 * @returns Array of typed results
 */
export function query<T>(sql: string, ...params: unknown[]): T[] {
  const db = getDb();
  const stmt = db.prepare(sql);

  if (!SQL_DEBUG_READS) {
    return stmt.all(...params) as T[];
  }

  const t0 = performance.now();
  const rows = stmt.all(...params) as T[];
  const durationMs = (performance.now() - t0).toFixed(2);
  const rowCount = rows.length;
  const summary = summarizeReadSql(sql);
  const whereTag = summary.where ? ` where=${summary.where}` : "";

  // Accumulate per-cycle stats
  _recordReadStats(summary.table, rowCount);

  // Concise summary line (human-scannable)
  log(
    rowCount === 0 ? "db_read_warn" : "db_read",
    `Read ${summary.op} table=${summary.table}${whereTag} rows=${rowCount} [${durationMs}ms]`
  );

  // Emphasized line for important tables — makes scanning grep-friendly
  if (IMPORTANT_TABLES.has(summary.table)) {
    log(
      rowCount === 0 ? "db_read_warn" : "db_read",
      `IMPORTANT READ table=${summary.table} rows=${rowCount}${whereTag}`
    );
  }

  // Detailed raw SQL + params + row preview follow
  const sqlPreview = sql.replace(/\s+/g, " ").trim().slice(0, MAX_SQL_PREVIEW);
  log("db_read", `  SQL: ${sqlPreview}`);
  log("db_read", `  Params: ${safeStringify(params, MAX_ROW_PREVIEW)}`);

  if (rowCount > 0) {
    log("db_read", `  Rows preview: ${safeStringify(rows)}`);
  }

  return rows;
}

/**
 * Execute a query that returns a single row or undefined.
 * @param sql - SQL query string
 * @param params - Query parameters
 * @returns Single typed result or undefined
 */
export function get<T>(sql: string, ...params: unknown[]): T | undefined {
  const db = getDb();
  const stmt = db.prepare(sql);

  if (!SQL_DEBUG_READS) {
    return stmt.get(...params) as T | undefined;
  }

  const t0 = performance.now();
  const row = stmt.get(...params) as T | undefined;
  const durationMs = (performance.now() - t0).toFixed(2);
  const summary = summarizeReadSql(sql);
  const whereTag = summary.where ? ` where=${summary.where}` : "";

  // Accumulate per-cycle stats
  const rowCount = row === undefined ? 0 : 1;
  _recordReadStats(summary.table, rowCount);

  // Concise summary line (human-scannable); warn on missing single-row read
  log(
    row === undefined ? "db_read_warn" : "db_read",
    `Read ${summary.op} table=${summary.table}${whereTag} rows=${rowCount} [${durationMs}ms]`
  );

  // Emphasized line for important tables — makes scanning grep-friendly
  if (IMPORTANT_TABLES.has(summary.table)) {
    log(
      rowCount === 0 ? "db_read_warn" : "db_read",
      `IMPORTANT READ table=${summary.table} rows=${rowCount}${whereTag}`
    );
  }

  // Detailed raw SQL + params + row preview follow
  const sqlPreview = sql.replace(/\s+/g, " ").trim().slice(0, MAX_SQL_PREVIEW);
  log("db_read", `  SQL: ${sqlPreview}`);
  log("db_read", `  Params: ${safeStringify(params, MAX_ROW_PREVIEW)}`);

  if (row !== undefined) {
    log("db_read", `  Row preview: ${safeStringify(row)}`);
  }

  return row;
}

/**
 * Execute a run statement (INSERT, UPDATE, DELETE).
 * Returns the last inserted row ID and changes count.
 * @param sql - SQL statement string
 * @param params - Statement parameters
 */
export function run(
  sql: string,
  ...params: unknown[]
): { lastInsertRowid: number | bigint; changes: number } {
  const db = getDb();
  const stmt = db.prepare(sql);
  const result = stmt.run(...params);
  return {
    lastInsertRowid: result.lastInsertRowid,
    changes: result.changes,
  };
}

/**
 * Execute multiple statements in a transaction.
 * All statements must succeed or all are rolled back.
 * @param callback - Function containing database operations
 */
export function transaction<T>(callback: () => T): T {
  const db = getDb();
  return db.transaction(callback)();
}

/**
 * Type for JSON columns - stored as string in DB, parsed on retrieval.
 */
export type JsonColumn<T = unknown> = T;

/**
 * Helper to parse JSON column from database.
 * Returns null if value is null/undefined or parsing fails.
 */
export function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Helper to stringify value for JSON column.
 */
export function stringifyJson<T>(value: T): string {
  return JSON.stringify(value);
}
