import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: postgres module exports Sql type correctly at runtime
import postgres, { type Sql } from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Add a column to a table if it doesn't exist.
 * Postgres doesn't support 'IF NOT EXISTS' for ADD COLUMN, so we check first.
 */
async function addColumnIfNotExists(
  sql: Sql,
  table: string,
  column: string,
  dataType: string
): Promise<void> {
  const result = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `;
  if (result.length === 0) {
    await sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${dataType}`);
    console.log(`Added column ${column} to ${table}`);
  }
}

/**
 * Run migrations to add missing columns to existing tables.
 * This handles schema updates for databases created before column additions.
 */
async function runMigrations(sql: Sql): Promise<void> {
  // Add out_of_range_since to position_state (added in schema v2)
  await addColumnIfNotExists(sql, "position_state", "out_of_range_since", "TIMESTAMP");

  // Add other missing columns that may have been added after initial deployment
  await addColumnIfNotExists(sql, "position_state", "last_claim_at", "TIMESTAMP");
  await addColumnIfNotExists(sql, "position_state", "total_fees_claimed_usd", "REAL DEFAULT 0");
  await addColumnIfNotExists(sql, "position_state", "rebalance_count", "INTEGER DEFAULT 0");
  await addColumnIfNotExists(sql, "position_state", "peak_pnl_pct", "REAL DEFAULT 0");
  await addColumnIfNotExists(sql, "position_state", "pending_peak_pnl_pct", "REAL");
  await addColumnIfNotExists(sql, "position_state", "pending_peak_started_at", "TIMESTAMP");
  await addColumnIfNotExists(sql, "position_state", "trailing_active", "INTEGER DEFAULT 0");
  await addColumnIfNotExists(sql, "position_state", "instruction", "TEXT");
  await addColumnIfNotExists(sql, "position_state", "pending_trailing_current_pnl_pct", "REAL");
  await addColumnIfNotExists(sql, "position_state", "pending_trailing_peak_pnl_pct", "REAL");
  await addColumnIfNotExists(sql, "position_state", "pending_trailing_drop_pct", "REAL");
  await addColumnIfNotExists(sql, "position_state", "pending_trailing_started_at", "TIMESTAMP");
  await addColumnIfNotExists(sql, "position_state", "confirmed_trailing_exit_reason", "TEXT");
  await addColumnIfNotExists(sql, "position_state", "confirmed_trailing_exit_until", "TIMESTAMP");
}

export async function initPostgresSchema(connectionString: string): Promise<void> {
  const sql = postgres(connectionString, { ssl: "require" });

  try {
    const schemaPath = path.join(__dirname, "schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf-8");

    const statements = schema
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await sql.unsafe(statement + ";");
    }

    // Run migrations to add missing columns to existing tables
    await runMigrations(sql);

    console.log("Postgres schema initialized successfully");
  } finally {
    await sql.end();
  }
}
