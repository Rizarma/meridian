declare module "postgres" {
  export interface SqlQueryResult<T = Record<string, unknown>> extends Array<T> {
    count?: number;
  }

  export interface Sql {
    unsafe<T = Record<string, unknown>>(
      query: string,
      parameters?: readonly unknown[]
    ): Promise<SqlQueryResult<T>>;
    end(): Promise<void>;
    begin<T>(fn: () => Promise<T>): Promise<T>;
    <T = Record<string, unknown>>(
      strings: TemplateStringsArray,
      ...parameters: unknown[]
    ): Promise<SqlQueryResult<T>>;
  }

  export default function postgres(
    connectionString: string,
    options?: {
      ssl?: "require" | boolean | Record<string, unknown>;
      max?: number;
      idle_timeout?: number;
      connect_timeout?: number;
    }
  ): Sql;
}
