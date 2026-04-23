import type { SqlDialect } from "../dialect.js";

export abstract class BaseAdapter {
  protected constructor(protected readonly dialect: SqlDialect) {}

  protected convertPlaceholders(sql: string): string {
    if (this.dialect.name !== "postgres") {
      return sql;
    }

    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }
}
