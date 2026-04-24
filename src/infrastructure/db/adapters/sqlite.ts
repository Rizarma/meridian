import Database from "better-sqlite3";
import { sqliteDialect } from "../dialect.js";
import type { DatabaseOperations } from "../types.js";
import { BaseAdapter } from "./base.js";

export class SqliteAdapter extends BaseAdapter implements DatabaseOperations {
  private db: Database.Database | null = null;
  private dbPath: string;
  private transactionDepth = 0;
  private savepointId = 0;

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

  async run(
    sql: string,
    ...params: unknown[]
  ): Promise<{
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

  async transaction<T>(fn: (tx: DatabaseOperations) => Promise<T> | T): Promise<T> {
    if (!this.db) throw new Error("Database not initialized");

    const isOuterTransaction = this.transactionDepth === 0;
    const savepointName = `sp_${++this.savepointId}`;

    if (isOuterTransaction) {
      this.db.exec("BEGIN");
    } else {
      this.db.exec(`SAVEPOINT ${savepointName}`);
    }

    this.transactionDepth++;
    try {
      const result = await fn(this);

      try {
        if (isOuterTransaction) {
          this.db.exec("COMMIT");
        } else {
          this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
        }
      } catch (commitError) {
        try {
          if (isOuterTransaction) {
            this.db.exec("ROLLBACK");
          } else {
            this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
          }
        } catch {
          // Ignore rollback errors; the original commit error is more useful.
        }

        throw commitError;
      }

      return result;
    } catch (error) {
      try {
        if (isOuterTransaction) {
          this.db.exec("ROLLBACK");
        } else {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
        }
      } catch {
        // Ignore rollback errors; rethrow the original failure.
      }

      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
}
