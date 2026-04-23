import Database from "better-sqlite3";
import { sqliteDialect } from "../dialect.js";
import type { DatabaseOperations } from "../types.js";
import { BaseAdapter } from "./base.js";

export class SqliteAdapter extends BaseAdapter implements DatabaseOperations {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(dbPath: string = "./meridian.db") {
    super(sqliteDialect);
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("wal_autocheckpoint = 1000");
    this.db.pragma("foreign_keys = ON");
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    if (!this.db) throw new Error("Database not initialized");
    return Promise.resolve(this.db.prepare(sql).all(...params) as T[]);
  }

  async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    if (!this.db) throw new Error("Database not initialized");
    return Promise.resolve(this.db.prepare(sql).get(...params) as T | undefined);
  }

  async run(sql: string, ...params: unknown[]): Promise<{
    lastInsertRowid: number | bigint;
    changes: number;
  }> {
    if (!this.db) throw new Error("Database not initialized");

    const result = this.db.prepare(sql).run(...params);
    return Promise.resolve({
      lastInsertRowid: result.lastInsertRowid,
      changes: result.changes,
    });
  }

  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    if (!this.db) throw new Error("Database not initialized");

    // better-sqlite3's transaction() doesn't support async functions
    // Use manual BEGIN/COMMIT/ROLLBACK for async support
    this.db.exec("BEGIN");
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
