// biome-ignore lint/correctness/noUnresolvedImports: postgres module exports Sql type correctly at runtime
import postgres, { type Sql } from "postgres";
import { postgresDialect } from "../dialect.js";
import { initPostgresSchema } from "../migrations/postgres/init.js";
import type { DatabaseOperations } from "../types.js";
import { BaseAdapter } from "./base.js";

type TransactionClient = Sql & {
  savepoint<T>(cb: () => T | Promise<T>): Promise<T>;
  savepoint<T>(name: string, cb: () => T | Promise<T>): Promise<T>;
};

export class PostgresAdapter extends BaseAdapter implements DatabaseOperations {
  private sql: Sql | TransactionClient | null = null;
  private connectionString: string;
  private readonly ownsConnection: boolean;

  constructor(connectionString: string, sql?: Sql | TransactionClient | null) {
    super(postgresDialect);
    this.connectionString = connectionString;
    this.sql = sql ?? null;
    this.ownsConnection = sql == null;
  }

  async init(): Promise<void> {
    if (this.sql) {
      return;
    }

    this.sql = postgres(this.connectionString, {
      ssl: "require",
      max: 10,
      idle_timeout: 20,
      connect_timeout: 30,
    });

    await this.sql`SELECT 1`;
    await this.initSchema();
  }

  private async initSchema(): Promise<void> {
    await initPostgresSchema(this.connectionString);
  }

  async close(): Promise<void> {
    if (this.sql && this.ownsConnection && "end" in this.sql) {
      await this.sql.end();
    }

    this.sql = null;
  }

  async query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    if (!this.sql) throw new Error("Database not initialized");

    const convertedSql = this.convertPlaceholders(sql);
    return (await this.sql.unsafe(convertedSql, params)) as T[];
  }

  async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    if (!this.sql) throw new Error("Database not initialized");

    const convertedSql = this.convertPlaceholders(sql);
    const results = (await this.sql.unsafe(convertedSql, params)) as T[];
    return results[0];
  }

  async run(
    sql: string,
    ...params: unknown[]
  ): Promise<{ lastInsertRowid: number | bigint; changes: number }> {
    if (!this.sql) throw new Error("Database not initialized");

    const convertedSql = this.convertPlaceholders(sql);
    const result = await this.sql.unsafe(convertedSql, params);

    return {
      lastInsertRowid: 0n,
      changes: (result as { count?: number }).count ?? 0,
    };
  }

  async transaction<T>(fn: (tx: DatabaseOperations) => Promise<T> | T): Promise<T> {
    if (!this.sql) throw new Error("Database not initialized");

    if ("savepoint" in this.sql) {
      return await this.sql.savepoint(async () => {
        const txAdapter = new PostgresAdapter(this.connectionString, this.sql as TransactionClient);
        return await fn(txAdapter);
      });
    }

    const rootSql = this.sql as Sql;
    return await rootSql.begin(async () => {
      const txAdapter = new PostgresAdapter(this.connectionString, rootSql as TransactionClient);
      return await fn(txAdapter);
    });
  }
}
