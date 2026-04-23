// Domain interfaces for dependency inversion
// Infrastructure implements these, Domain depends only on interfaces

export interface DatabaseOperations {
  init(): Promise<void> | void;
  close(): Promise<void> | void;
  query<T>(sql: string, ...params: unknown[]): Promise<T[]> | T[];
  get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> | T | undefined;
  run(
    sql: string,
    ...params: unknown[]
  ): Promise<{ lastInsertRowid: number | bigint; changes: number }> | { lastInsertRowid: number | bigint; changes: number };
  transaction<T>(callback: () => Promise<T> | T): Promise<T> | T;
}

export interface JsonOperations {
  stringifyJson<T>(value: T): string;
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
