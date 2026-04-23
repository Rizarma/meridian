import postgres, { type Sql } from "postgres";
import { BaseAdapter } from "./base.js";
import { postgresDialect } from "../dialect.js";
import type { DatabaseOperations } from "../types.js";
import { initPostgresSchema } from "../migrations/postgres/init.js";

export class PostgresAdapter extends BaseAdapter implements DatabaseOperations {
  private sql: Sql | null = null;
  private connectionString: string;

  constructor(connectionString: string) {
    super(postgresDialect);
    this.connectionString = connectionString;
  }

  async init(): Promise<void> {
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
    if (this.sql) {
      await this.sql.end();
      this.sql = null;
    }
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

  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    if (!this.sql) throw new Error("Database not initialized");

    return await this.sql.begin(async () => {
      return await fn();
    });
  }
}
