// Domain interfaces for dependency inversion
// Infrastructure implements these, Domain depends only on interfaces

export interface DatabaseOperations {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastID: number }>;
  transaction<T>(callback: (db: DatabaseOperations) => Promise<T>): Promise<T>;
}

export interface JsonOperations {
  stringifyJson(value: unknown): string;
  parseJson<T>(value: string): T;
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
