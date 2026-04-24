import type { SqlDialect } from "../dialect.js";

export abstract class BaseAdapter {
  protected constructor(protected readonly dialect: SqlDialect) {}

  protected convertSql(sql: string): string {
    const convertedSql =
      this.dialect.name === "postgres" ? sql.replace(/datetime\('now'\)/g, "NOW()") : sql;

    return this.convertPlaceholders(convertedSql);
  }

  protected convertPlaceholders(sql: string): string {
    if (this.dialect.name !== "postgres") {
      return sql;
    }

    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }
}
