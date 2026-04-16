// Domain interfaces for dependency inversion
// Infrastructure implements these, Domain depends only on interfaces
// NOTE: These mirror the synchronous better-sqlite3 API used by src/infrastructure/db.ts

export interface DatabaseOperations {
  query<T>(sql: string, ...params: unknown[]): T[];
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  run(sql: string, ...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  transaction<T>(callback: () => T): T;
}

export interface JsonOperations {
  stringifyJson(value: unknown): string;
  parseJson<T>(value: string | null | undefined): T | null;
}

export interface Logger {
  info(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface NotificationService {
  send(message: string, level?: "info" | "warning" | "error"): Promise<void>;
}

// Combined interface for domain services
export interface DomainInfrastructure {
  db: DatabaseOperations & JsonOperations;
  logger: Logger;
  notifications: NotificationService;
}
