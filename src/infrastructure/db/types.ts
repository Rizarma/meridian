export type DatabaseBackend = "sqlite" | "postgres";

export interface DatabaseOperations {
  init(): Promise<void> | void;
  close(): Promise<void> | void;
  query<T>(sql: string, ...params: unknown[]): Promise<T[]> | T[];
  get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> | T | undefined;
  run(
    sql: string,
    ...params: unknown[]
  ):
    | Promise<{
        lastInsertRowid: string | number | bigint;
        changes: number;
      }>
    | {
        lastInsertRowid: string | number | bigint;
        changes: number;
      };
  transaction<T>(fn: (tx: DatabaseOperations) => Promise<T> | T): Promise<T> | T;
}

export interface JsonOperations {
  stringifyJson<T>(value: T): string;
  parseJson<T>(value: string | null | undefined): T | null;
}
