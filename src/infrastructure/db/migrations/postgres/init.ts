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
  // === positions table columns ===
  await addColumnIfNotExists(sql, "positions", "closed", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfNotExists(sql, "positions", "closed_at", "TIMESTAMP");
  await addColumnIfNotExists(sql, "positions", "pool_name", "TEXT");
  await addColumnIfNotExists(sql, "positions", "amount_sol", "REAL");
  await addColumnIfNotExists(sql, "positions", "pnl_pct", "REAL");
  await addColumnIfNotExists(sql, "positions", "pnl_usd", "REAL");
  await addColumnIfNotExists(sql, "positions", "fees_earned_usd", "REAL");
  await addColumnIfNotExists(sql, "positions", "initial_value_usd", "REAL");
  await addColumnIfNotExists(sql, "positions", "final_value_usd", "REAL");
  await addColumnIfNotExists(sql, "positions", "minutes_held", "INTEGER");
  await addColumnIfNotExists(sql, "positions", "close_reason", "TEXT");
  await addColumnIfNotExists(sql, "positions", "trailing_state", "TEXT");
  await addColumnIfNotExists(sql, "positions", "notes", "TEXT");
  await addColumnIfNotExists(sql, "positions", "data_json", "TEXT");
  await addColumnIfNotExists(sql, "positions", "created_at", "TIMESTAMP NOT NULL DEFAULT NOW()");
  await addColumnIfNotExists(sql, "positions", "updated_at", "TIMESTAMP NOT NULL DEFAULT NOW()");

  // === position_state table columns ===
  await addColumnIfNotExists(sql, "position_state", "out_of_range_since", "TIMESTAMP");
  await addColumnIfNotExists(sql, "position_state", "last_claim_at", "TIMESTAMP");
  await addColumnIfNotExists(sql, "position_state", "total_fees_claimed_usd", "REAL DEFAULT 0");
  await addColumnIfNotExists(sql, "position_state", "rebalance_count", "INTEGER DEFAULT 0");
  await addColumnIfNotExists(sql, "position_state", "closed", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfNotExists(sql, "position_state", "closed_at", "TIMESTAMP");
  await addColumnIfNotExists(sql, "position_state", "peak_pnl_pct", "REAL DEFAULT 0");
  await addColumnIfNotExists(sql, "position_state", "pending_peak_pnl_pct", "REAL");
  await addColumnIfNotExists(sql, "position_state", "pending_peak_started_at", "TIMESTAMP");
  await addColumnIfNotExists(
    sql,
    "position_state",
    "trailing_active",
    "INTEGER NOT NULL DEFAULT 0"
  );
  await addColumnIfNotExists(sql, "position_state", "instruction", "TEXT");
  await addColumnIfNotExists(sql, "position_state", "pending_trailing_current_pnl_pct", "REAL");
  await addColumnIfNotExists(sql, "position_state", "pending_trailing_peak_pnl_pct", "REAL");
  await addColumnIfNotExists(sql, "position_state", "pending_trailing_drop_pct", "REAL");
  await addColumnIfNotExists(sql, "position_state", "pending_trailing_started_at", "TIMESTAMP");
  await addColumnIfNotExists(sql, "position_state", "confirmed_trailing_exit_reason", "TEXT");
  await addColumnIfNotExists(sql, "position_state", "confirmed_trailing_exit_until", "TIMESTAMP");
  await addColumnIfNotExists(sql, "position_state", "pool_name", "TEXT");
  await addColumnIfNotExists(sql, "position_state", "strategy_config", "TEXT");
  await addColumnIfNotExists(sql, "position_state", "bin_range", "TEXT");
  await addColumnIfNotExists(sql, "position_state", "amount_x", "REAL");
  await addColumnIfNotExists(sql, "position_state", "active_bin_at_deploy", "INTEGER");
  await addColumnIfNotExists(sql, "position_state", "bin_step", "INTEGER");
  await addColumnIfNotExists(sql, "position_state", "volatility", "REAL");
  await addColumnIfNotExists(sql, "position_state", "fee_tvl_ratio", "REAL");
  await addColumnIfNotExists(sql, "position_state", "initial_fee_tvl_24h", "REAL");
  await addColumnIfNotExists(sql, "position_state", "organic_score", "INTEGER");
  await addColumnIfNotExists(sql, "position_state", "initial_value_usd", "REAL");
  await addColumnIfNotExists(sql, "position_state", "signal_snapshot", "TEXT");
  await addColumnIfNotExists(sql, "position_state", "notes", "TEXT");

  // === signal_weight_history table columns ===
  await addColumnIfNotExists(sql, "signal_weight_history", "confidence", "REAL");
}

/**
 * Reset SERIAL sequences to match the current max(id) values.
 * This prevents duplicate key errors when sequence values drift behind data.
 */
async function resetSequences(sql: Sql): Promise<void> {
  const tables = [
    "position_snapshots",
    "position_events",
    "pool_deploys",
    "performance",
    "signal_weight_history",
    "position_state_events",
    "threshold_suggestions",
    "threshold_history",
    "portfolio_history",
  ];

  for (const table of tables) {
    await sql.unsafe(
      `SELECT setval('${table}_id_seq', COALESCE((SELECT MAX(id) FROM ${table}), 1), true);`
    );
  }
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
      await sql.unsafe(`${statement};`);
    }

    // Run migrations to add missing columns to existing tables
    await runMigrations(sql);

    // Reset SERIAL sequences so they stay in sync with table data
    await resetSequences(sql);

    console.log("Postgres schema initialized successfully");
  } finally {
    await sql.end();
  }
}
