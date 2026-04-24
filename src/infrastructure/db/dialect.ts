export interface SqlDialect {
  name: string;
}

export const sqliteDialect: SqlDialect = {
  name: "sqlite",
};

export const postgresDialect: SqlDialect = {
  name: "postgres",
};
