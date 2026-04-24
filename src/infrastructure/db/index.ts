import type { DatabaseOperations, JsonOperations } from "../../domain/interfaces/database.js";
import { PostgresAdapter } from "./adapters/postgres.js";
import { SqliteAdapter } from "./adapters/sqlite.js";

export interface CreateDatabaseOptions {
  backend?: "sqlite" | "postgres";
  url?: string;
  dbPath?: string;
}

export type DatabaseInstance = DatabaseOperations & JsonOperations;

export async function createDatabase(
  options: CreateDatabaseOptions = {}
): Promise<DatabaseInstance> {
  const backend = options.backend ?? (options.url?.trim() ? "postgres" : "sqlite");

  if (backend === "postgres") {
    if (!options.url) {
      throw new Error("Postgres backend requires a database URL");
    }

    const adapter = new PostgresAdapter(options.url);
    await adapter.init();
    return Object.assign(adapter, {
      stringifyJson: <T>(value: T): string => JSON.stringify(value),
      parseJson: <T>(value: string | null | undefined): T | null => {
        if (!value) return null;
        try {
          return JSON.parse(value) as T;
        } catch {
          return null;
        }
      },
    });
  }

  const adapter = new SqliteAdapter(options.dbPath);
  await adapter.init();
  return Object.assign(adapter, {
    stringifyJson: <T>(value: T): string => JSON.stringify(value),
    parseJson: <T>(value: string | null | undefined): T | null => {
      if (!value) return null;
      try {
        return JSON.parse(value) as T;
      } catch {
        return null;
      }
    },
  });
}

export type { DatabaseOperations } from "./types.js";
