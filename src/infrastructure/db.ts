import Database from "better-sqlite3";
import path from "node:path";
import { PROJECT_ROOT } from "../config/paths.js";

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
  return stmt.all(...params) as T[];
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
  return stmt.get(...params) as T | undefined;
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
