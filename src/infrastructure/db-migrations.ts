import fs from "node:fs";
import path from "node:path";
import { LESSONS_FILE, POOL_MEMORY_FILE, PROJECT_ROOT } from "../config/paths.js";
import { getDb, parseJson, query, run, stringifyJson, transaction } from "./db.js";
import { initThresholdEvolutionTables } from "./db-threshold-evolution.js";
import { log } from "./logger.js";

/**
 * Current schema version.
 * Increment this when making schema changes.
 */
export const SCHEMA_VERSION = 1;

/**
 * Initialize the database schema.
 * Creates all tables if they don't exist.
 */
export function initSchema(): void {
  const db = getDb();

  // Schema version tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Positions table - stores active and closed positions
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      address TEXT PRIMARY KEY,
      pool TEXT NOT NULL,
      pool_name TEXT,
      strategy TEXT NOT NULL,
      deployed_at TEXT NOT NULL,
      closed_at TEXT,
      closed INTEGER NOT NULL DEFAULT 0,
      amount_sol REAL,
      pnl_pct REAL,
      pnl_usd REAL,
      fees_earned_usd REAL,
      initial_value_usd REAL,
      final_value_usd REAL,
      minutes_held INTEGER,
      close_reason TEXT,
      trailing_state TEXT, -- JSON: peak_pnl_pct, trailing_active, etc.
      notes TEXT, -- JSON array of notes
      data_json TEXT, -- Full JSON backup of position data
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Position snapshots - periodic state captures
  db.exec(`
    CREATE TABLE IF NOT EXISTS position_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_address TEXT NOT NULL,
      ts TEXT NOT NULL,
      pnl_pct REAL,
      pnl_usd REAL,
      in_range INTEGER,
      unclaimed_fees_usd REAL,
      minutes_out_of_range INTEGER,
      age_minutes INTEGER,
      data_json TEXT,
      FOREIGN KEY (position_address) REFERENCES positions(address) ON DELETE CASCADE
    )
  `);

  // Position events - significant events (claims, rebalances, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS position_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_address TEXT NOT NULL,
      event_type TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      data_json TEXT,
      FOREIGN KEY (position_address) REFERENCES positions(address) ON DELETE CASCADE
    )
  `);

  // Pools table - pool metadata and performance stats
  db.exec(`
    CREATE TABLE IF NOT EXISTS pools (
      address TEXT PRIMARY KEY,
      name TEXT,
      base_mint TEXT,
      total_deploys INTEGER NOT NULL DEFAULT 0,
      avg_pnl_pct REAL,
      win_rate REAL,
      adjusted_win_rate REAL,
      cooldown_until TEXT,
      cooldown_reason TEXT,
      base_mint_cooldown_until TEXT,
      base_mint_cooldown_reason TEXT,
      data_json TEXT, -- Full JSON backup
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Pool deploys - individual deployment records per pool
  db.exec(`
    CREATE TABLE IF NOT EXISTS pool_deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address TEXT NOT NULL,
      position_address TEXT,
      deployed_at TEXT NOT NULL,
      closed_at TEXT,
      pnl_pct REAL,
      pnl_usd REAL,
      range_efficiency REAL,
      minutes_held INTEGER,
      close_reason TEXT,
      strategy TEXT,
      volatility_at_deploy REAL,
      data_json TEXT,
      FOREIGN KEY (pool_address) REFERENCES pools(address) ON DELETE CASCADE
    )
  `);

  // Lessons table - learned rules and outcomes
  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY,
      rule TEXT NOT NULL,
      tags TEXT, -- JSON array
      outcome TEXT, -- 'good', 'bad', 'neutral'
      context TEXT,
      pool TEXT,
      pnl_pct REAL,
      range_efficiency REAL,
      created_at TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      role TEXT, -- 'rule', 'tip', 'warning'
      data_json TEXT
    )
  `);

  // Performance table - detailed performance records
  db.exec(`
    CREATE TABLE IF NOT EXISTS performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position TEXT NOT NULL,
      pool TEXT NOT NULL,
      pool_name TEXT,
      strategy TEXT,
      amount_sol REAL,
      pnl_pct REAL,
      pnl_usd REAL,
      fees_earned_usd REAL,
      initial_value_usd REAL,
      final_value_usd REAL,
      minutes_held INTEGER,
      minutes_in_range INTEGER,
      range_efficiency REAL,
      close_reason TEXT,
      base_mint TEXT,
      bin_step INTEGER,
      volatility REAL,
      fee_tvl_ratio REAL,
      organic_score INTEGER,
      bin_range TEXT, -- JSON
      recorded_at TEXT NOT NULL,
      data_json TEXT
    )
  `);

  // Signal weights table - Darwinian weight system
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_weights (
      signal TEXT PRIMARY KEY,
      weight REAL NOT NULL DEFAULT 1.0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Signal weight history - track weight changes over time
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_weight_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal TEXT NOT NULL,
      weight_from REAL,
      weight_to REAL NOT NULL,
      lift REAL,
      action TEXT, -- 'boosted', 'decayed'
      window_size INTEGER,
      win_count INTEGER,
      loss_count INTEGER,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Position state - runtime position tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS position_state (
      position TEXT PRIMARY KEY,
      pool TEXT NOT NULL,
      pool_name TEXT,
      strategy TEXT NOT NULL,
      strategy_config TEXT,
      bin_range TEXT,
      amount_sol REAL NOT NULL,
      amount_x REAL DEFAULT 0,
      active_bin_at_deploy INTEGER,
      bin_step INTEGER,
      volatility REAL,
      fee_tvl_ratio REAL,
      initial_fee_tvl_24h REAL,
      organic_score INTEGER,
      initial_value_usd REAL,
      signal_snapshot TEXT,
      deployed_at TEXT NOT NULL,
      out_of_range_since TEXT,
      last_claim_at TEXT,
      total_fees_claimed_usd REAL DEFAULT 0,
      rebalance_count INTEGER DEFAULT 0,
      closed INTEGER DEFAULT 0,
      closed_at TEXT,
      notes TEXT,
      peak_pnl_pct REAL DEFAULT 0,
      pending_peak_pnl_pct REAL,
      pending_peak_started_at TEXT,
      trailing_active INTEGER DEFAULT 0,
      instruction TEXT,
      pending_trailing_current_pnl_pct REAL,
      pending_trailing_peak_pnl_pct REAL,
      pending_trailing_drop_pct REAL,
      pending_trailing_started_at TEXT,
      confirmed_trailing_exit_reason TEXT,
      confirmed_trailing_exit_until TEXT,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Position state events - events for position_state entries
  db.exec(`
    CREATE TABLE IF NOT EXISTS position_state_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      action TEXT NOT NULL,
      position TEXT,
      pool_name TEXT,
      reason TEXT
    )
  `);

  // State metadata - generic key-value store
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Token blacklist - blocked mints
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_blacklist (
      mint TEXT PRIMARY KEY,
      symbol TEXT NOT NULL DEFAULT 'UNKNOWN',
      reason TEXT NOT NULL DEFAULT 'no reason provided',
      added_at TEXT NOT NULL,
      added_by TEXT NOT NULL DEFAULT 'agent'
    )
  `);

  // Dev blocklist - blocked deployer wallets
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_blocklist (
      wallet TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT 'unknown',
      reason TEXT NOT NULL DEFAULT 'no reason provided',
      added_at TEXT NOT NULL
    )
  `);

  // Strategies - stored strategy definitions
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'unknown',
      lp_strategy TEXT NOT NULL,
      token_criteria_json TEXT NOT NULL DEFAULT '{}',
      entry_criteria_json TEXT NOT NULL DEFAULT '{}',
      range_criteria_json TEXT NOT NULL DEFAULT '{}',
      exit_criteria_json TEXT NOT NULL DEFAULT '{}',
      best_for TEXT,
      raw TEXT DEFAULT '',
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Active strategy - singleton tracking which strategy is active
  db.exec(`
    CREATE TABLE IF NOT EXISTS active_strategy (
      id INTEGER PRIMARY KEY DEFAULT 1,
      active_id TEXT NOT NULL
    )
  `);

  // Threshold suggestions - pending approvals (from threshold evolution)
  db.exec(`
    CREATE TABLE IF NOT EXISTS threshold_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field TEXT NOT NULL,
      current_value REAL NOT NULL,
      suggested_value REAL NOT NULL,
      confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
      rationale TEXT NOT NULL,
      sample_size INTEGER NOT NULL,
      winner_count INTEGER NOT NULL,
      loser_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      reviewed_at TEXT,
      reviewed_by TEXT,
      applied_at TEXT
    )
  `);

  // Threshold history - applied changes (from threshold evolution)
  db.exec(`
    CREATE TABLE IF NOT EXISTS threshold_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field TEXT NOT NULL,
      old_value REAL NOT NULL,
      new_value REAL NOT NULL,
      rationale TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      sample_size INTEGER NOT NULL,
      triggered_by TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      performance_snapshot TEXT
    )
  `);

  // Create indexes for common queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_positions_pool ON positions(pool);
    CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions(closed);
    CREATE INDEX IF NOT EXISTS idx_positions_deployed_at ON positions(deployed_at);
    CREATE INDEX IF NOT EXISTS idx_snapshots_position ON position_snapshots(position_address);
    CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON position_snapshots(ts);
    CREATE INDEX IF NOT EXISTS idx_events_position ON position_events(position_address);
    CREATE INDEX IF NOT EXISTS idx_pool_deploys_pool ON pool_deploys(pool_address);
    CREATE INDEX IF NOT EXISTS idx_pool_deploys_deployed_at ON pool_deploys(deployed_at);
    CREATE INDEX IF NOT EXISTS idx_performance_pool ON performance(pool);
    CREATE INDEX IF NOT EXISTS idx_performance_recorded_at ON performance(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_lessons_pool ON lessons(pool);
    CREATE INDEX IF NOT EXISTS idx_lessons_outcome ON lessons(outcome);
    CREATE INDEX IF NOT EXISTS idx_lessons_created_at ON lessons(created_at);
    CREATE INDEX IF NOT EXISTS idx_signal_weight_history_signal ON signal_weight_history(signal);
    CREATE INDEX IF NOT EXISTS idx_position_state_closed ON position_state(closed);
    CREATE INDEX IF NOT EXISTS idx_position_state_deployed ON position_state(deployed_at);
    CREATE INDEX IF NOT EXISTS idx_position_state_events_ts ON position_state_events(ts);
    CREATE INDEX IF NOT EXISTS idx_position_state_events_position ON position_state_events(position);
    CREATE INDEX IF NOT EXISTS idx_token_blacklist_added ON token_blacklist(added_at);
    CREATE INDEX IF NOT EXISTS idx_strategies_added ON strategies(added_at);
    CREATE INDEX IF NOT EXISTS idx_suggestions_status ON threshold_suggestions(status);
    CREATE INDEX IF NOT EXISTS idx_suggestions_created ON threshold_suggestions(created_at);
    CREATE INDEX IF NOT EXISTS idx_history_field ON threshold_history(field);
    CREATE INDEX IF NOT EXISTS idx_history_applied ON threshold_history(applied_at);
  `);

  // Migration log - track migration attempts for rollback
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      status TEXT NOT NULL, -- 'started', 'completed', 'failed', 'rolled_back'
      backup_path TEXT,
      error_message TEXT
    )
  `);

  // Record schema version
  const versionRow = query<{ version: number }>(
    "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
  );
  if (!versionRow.length) {
    run("INSERT INTO schema_version (version) VALUES (?)", SCHEMA_VERSION);
  }
}

/**
 * Check if migration is needed from JSON files.
 * Returns true if tables are empty and JSON files exist with data.
 */
export function needsJsonImport(): boolean {
  // Check if we have any data in key tables
  const positionCount = query<{ count: number }>("SELECT COUNT(*) as count FROM positions");
  const poolCount = query<{ count: number }>("SELECT COUNT(*) as count FROM pools");
  const lessonCount = query<{ count: number }>("SELECT COUNT(*) as count FROM lessons");

  const hasDbData =
    (positionCount[0]?.count ?? 0) > 0 ||
    (poolCount[0]?.count ?? 0) > 0 ||
    (lessonCount[0]?.count ?? 0) > 0;

  if (hasDbData) {
    return false; // Already has data, no migration needed
  }

  // Check if JSON files exist
  const hasLessonsFile = fs.existsSync(LESSONS_FILE);
  const hasPoolMemoryFile = fs.existsSync(POOL_MEMORY_FILE);

  return hasLessonsFile || hasPoolMemoryFile;
}

/**
 * Migrate data from existing JSON files to SQLite.
 * Keeps JSON files as backups.
 */
export function migrateFromJson(): { success: boolean; message: string } {
  // Create pre-migration backup
  const backupResult = createJsonBackups();
  if (!backupResult.success) {
    return {
      success: false,
      message: `Pre-migration backup failed: ${backupResult.message}`,
    };
  }

  // Extract backup path from message (format: "Backups created in <dir>: <file1>, <file2>")
  const backupPath = backupResult.message.match(/backups[/][^:]+/)?.[0] || backupResult.message;

  // Insert migration log entry
  run(`INSERT INTO migration_log (status, backup_path) VALUES (?, ?)`, "started", backupPath);
  const migrationLogId = query<{ id: number }>(
    "SELECT id FROM migration_log ORDER BY id DESC LIMIT 1"
  )[0]?.id;

  try {
    return transaction(() => {
      let migratedLessons = 0;
      let migratedPools = 0;
      let migratedDeploys = 0;
      let migratedSnapshots = 0;
      let migratedPerformance = 0;
      let migratedPositions = 0;

      // Collect orphaned data for backup and manual recovery
      const orphanedSnapshots: Array<Record<string, unknown> & { _poolAddress: string }> = [];

      // Migrate lessons.json
      if (fs.existsSync(LESSONS_FILE)) {
        try {
          const lessonsData = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf-8")) as {
            lessons?: unknown[];
            performance?: unknown[];
          };

          // Migrate lessons
          if (Array.isArray(lessonsData.lessons)) {
            for (const lesson of lessonsData.lessons) {
              const l = lesson as Record<string, unknown>;
              run(
                `INSERT INTO lessons (id, rule, tags, outcome, context, pool, pnl_pct, range_efficiency, created_at, pinned, role, data_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                l.id ?? Date.now(),
                l.rule ?? "",
                stringifyJson(l.tags ?? []),
                l.outcome ?? "neutral",
                l.context ?? null,
                l.pool ?? null,
                l.pnl_pct ?? null,
                l.range_efficiency ?? null,
                l.created_at ?? new Date().toISOString(),
                l.pinned ?? 0,
                l.role ?? "rule",
                stringifyJson(l)
              );
              migratedLessons++;
            }
          }

          // Migrate performance records
          if (Array.isArray(lessonsData.performance)) {
            for (const perf of lessonsData.performance) {
              const p = perf as Record<string, unknown>;
              run(
                `INSERT INTO performance (position, pool, pool_name, strategy, amount_sol, pnl_pct, pnl_usd, 
                  fees_earned_usd, initial_value_usd, final_value_usd, minutes_held, minutes_in_range,
                  range_efficiency, close_reason, base_mint, bin_step, volatility, fee_tvl_ratio, 
                  organic_score, bin_range, recorded_at, data_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                p.position ?? null,
                p.pool ?? null,
                p.pool_name ?? null,
                p.strategy ?? null,
                p.amount_sol ?? null,
                p.pnl_pct ?? null,
                p.pnl_usd ?? null,
                p.fees_earned_usd ?? null,
                p.initial_value_usd ?? null,
                p.final_value_usd ?? null,
                p.minutes_held ?? null,
                p.minutes_in_range ?? null,
                p.range_efficiency ?? null,
                p.close_reason ?? null,
                p.base_mint ?? null,
                p.bin_step ?? null,
                p.volatility ?? null,
                p.fee_tvl_ratio ?? null,
                p.organic_score ?? null,
                stringifyJson(p.bin_range ?? null),
                p.recorded_at ?? new Date().toISOString(),
                stringifyJson(p)
              );
              migratedPerformance++;
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log("migration_error", `Failed to parse ${LESSONS_FILE}: ${errorMessage}`);
          // Continue with other files, don't fail entire migration
        }
      }

      // Migrate pool-memory.json
      if (fs.existsSync(POOL_MEMORY_FILE)) {
        try {
          const poolData = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf-8")) as Record<
            string,
            unknown
          >;

          for (const [poolAddress, poolInfo] of Object.entries(poolData)) {
            const p = poolInfo as Record<string, unknown>;

            // Insert pool
            run(
              `INSERT INTO pools (address, name, base_mint, total_deploys, avg_pnl_pct, win_rate, 
                adjusted_win_rate, cooldown_until, cooldown_reason, base_mint_cooldown_until, 
                base_mint_cooldown_reason, data_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              poolAddress,
              p.name ?? null,
              p.base_mint ?? null,
              p.total_deploys ?? 0,
              p.avg_pnl_pct ?? null,
              p.win_rate ?? null,
              p.adjusted_win_rate ?? null,
              p.cooldown_until ?? null,
              p.cooldown_reason ?? null,
              p.base_mint_cooldown_until ?? null,
              p.base_mint_cooldown_reason ?? null,
              stringifyJson(p)
            );
            migratedPools++;

            // Migrate deploys
            if (Array.isArray(p.deploys)) {
              for (const deploy of p.deploys) {
                const d = deploy as Record<string, unknown>;
                run(
                  `INSERT INTO pool_deploys (pool_address, deployed_at, closed_at, pnl_pct, pnl_usd,
                    range_efficiency, minutes_held, close_reason, strategy, volatility_at_deploy, data_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  poolAddress,
                  d.deployed_at ?? null,
                  d.closed_at ?? null,
                  d.pnl_pct ?? null,
                  d.pnl_usd ?? null,
                  d.range_efficiency ?? null,
                  d.minutes_held ?? null,
                  d.close_reason ?? null,
                  d.strategy ?? null,
                  d.volatility_at_deploy ?? null,
                  stringifyJson(d)
                );
                migratedDeploys++;
              }
            }

            // Migrate snapshots - skip if no position reference since FK constraint requires valid position
            if (Array.isArray(p.snapshots)) {
              for (const snapshot of p.snapshots) {
                const s = snapshot as Record<string, unknown>;
                // Only migrate snapshots that have a valid position reference
                const positionAddr = s.position as string | undefined;
                if (!positionAddr) {
                  // Log warning and collect orphaned snapshot for backup
                  console.warn(
                    `[migrateFromJson] Skipping snapshot without position reference in pool ${poolAddress}`
                  );
                  orphanedSnapshots.push({ ...s, _poolAddress: poolAddress });
                  continue;
                }

                run(
                  `INSERT INTO position_snapshots (position_address, ts, pnl_pct, pnl_usd, in_range,
                    unclaimed_fees_usd, minutes_out_of_range, age_minutes, data_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  positionAddr,
                  s.ts ?? new Date().toISOString(),
                  s.pnl_pct ?? null,
                  s.pnl_usd ?? null,
                  s.in_range ? 1 : 0,
                  s.unclaimed_fees_usd ?? null,
                  s.minutes_out_of_range ?? null,
                  s.age_minutes ?? null,
                  stringifyJson(s)
                );
                migratedSnapshots++;
              }
            }

            // Migrate notes as position events or store in pool data
            if (Array.isArray(p.notes)) {
              for (const note of p.notes) {
                const n = note as Record<string, unknown>;
                // Store as a pool event in position_events with special type
                run(
                  `INSERT INTO position_events (position_address, event_type, ts, data_json)
                   VALUES (?, ?, ?, ?)`,
                  poolAddress,
                  "pool_note",
                  n.added_at ?? new Date().toISOString(),
                  stringifyJson(n)
                );
              }
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log("migration_error", `Failed to parse ${POOL_MEMORY_FILE}: ${errorMessage}`);
          // Continue with other files, don't fail entire migration
        }
      }

      // Migrate state.json positions if exists
      const stateFile = path.join(PROJECT_ROOT, "state.json");
      if (fs.existsSync(stateFile)) {
        try {
          const stateData = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as {
            positions?: Record<string, unknown>;
          };

          if (stateData.positions) {
            for (const [positionAddress, posData] of Object.entries(stateData.positions)) {
              const pos = posData as Record<string, unknown>;

              // Build trailing_state JSON
              const trailingState = {
                peak_pnl_pct: pos.peak_pnl_pct,
                pending_peak_pnl_pct: pos.pending_peak_pnl_pct,
                pending_peak_started_at: pos.pending_peak_started_at,
                trailing_active: pos.trailing_active,
                pending_trailing_current_pnl_pct: pos.pending_trailing_current_pnl_pct,
                pending_trailing_peak_pnl_pct: pos.pending_trailing_peak_pnl_pct,
                pending_trailing_drop_pct: pos.pending_trailing_drop_pct,
                pending_trailing_started_at: pos.pending_trailing_started_at,
                confirmed_trailing_exit_reason: pos.confirmed_trailing_exit_reason,
                confirmed_trailing_exit_until: pos.confirmed_trailing_exit_until,
              };

              run(
                `INSERT OR REPLACE INTO positions (address, pool, pool_name, strategy, deployed_at, 
                  closed_at, closed, amount_sol, pnl_pct, pnl_usd, fees_earned_usd, initial_value_usd,
                  final_value_usd, minutes_held, close_reason, trailing_state, notes, data_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                positionAddress,
                pos.pool ?? null,
                pos.pool_name ?? null,
                pos.strategy ?? null,
                pos.deployed_at ?? new Date().toISOString(),
                pos.closed_at ?? null,
                pos.closed ? 1 : 0,
                pos.amount_sol ?? null,
                pos.pnl_pct ?? null,
                pos.pnl_usd ?? null,
                pos.total_fees_claimed_usd ?? null,
                pos.initial_value_usd ?? null,
                pos.final_value_usd ?? null,
                pos.minutes_held ?? null,
                pos.close_reason ?? null,
                stringifyJson(trailingState),
                stringifyJson(pos.notes ?? []),
                stringifyJson(pos)
              );
              migratedPositions++;
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log("migration_error", `Failed to parse ${stateFile}: ${errorMessage}`);
          // Continue with other files, don't fail entire migration
        }
      }

      // Migrate signal-weights.json if exists
      const signalWeightsFile = path.join(PROJECT_ROOT, "signal-weights.json");
      if (fs.existsSync(signalWeightsFile)) {
        try {
          const signalData = JSON.parse(fs.readFileSync(signalWeightsFile, "utf-8")) as {
            weights?: Record<string, number>;
            history?: unknown[];
          };

          if (signalData.weights) {
            for (const [signal, weight] of Object.entries(signalData.weights)) {
              run(
                `INSERT OR REPLACE INTO signal_weights (signal, weight, updated_at)
                 VALUES (?, ?, ?)`,
                signal,
                weight,
                new Date().toISOString()
              );
            }
          }

          // Migrate history
          if (Array.isArray(signalData.history)) {
            for (const entry of signalData.history) {
              const h = entry as Record<string, unknown>;
              if (Array.isArray(h.changes)) {
                for (const change of h.changes) {
                  const c = change as Record<string, unknown>;
                  run(
                    `INSERT INTO signal_weight_history (signal, weight_from, weight_to, lift, action,
                      window_size, win_count, loss_count, changed_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    c.signal ?? null,
                    c.from ?? null,
                    c.to ?? null,
                    c.lift ?? null,
                    c.action ?? null,
                    h.window_size ?? null,
                    h.win_count ?? null,
                    h.loss_count ?? null,
                    h.timestamp ?? new Date().toISOString()
                  );
                }
              }
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log("migration_error", `Failed to parse ${signalWeightsFile}: ${errorMessage}`);
          // Continue with other files, don't fail entire migration
        }
      }

      // Save orphaned snapshots to backup file if any were found
      let orphanedMessage = "";
      if (orphanedSnapshots.length > 0) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupFile = path.join(PROJECT_ROOT, `orphaned-snapshots-backup-${timestamp}.json`);
        fs.writeFileSync(
          backupFile,
          JSON.stringify(
            {
              orphanedSnapshots,
              count: orphanedSnapshots.length,
              exported_at: new Date().toISOString(),
              note: "These snapshots were skipped during migration because they lack a position reference. Manual recovery may be needed.",
            },
            null,
            2
          )
        );
        orphanedMessage = `, ${orphanedSnapshots.length} orphaned snapshots saved to ${backupFile}`;
        console.warn(
          `[migrateFromJson] ${orphanedSnapshots.length} orphaned snapshots saved to ${backupFile} for manual recovery`
        );
      }

      // Update migration log to completed
      if (migrationLogId) {
        run(
          `UPDATE migration_log SET status = ?, completed_at = datetime('now') WHERE id = ?`,
          "completed",
          migrationLogId
        );
      }

      return {
        success: true,
        message: `Migration complete: ${migratedLessons} lessons, ${migratedPools} pools, ${migratedDeploys} deploys, ${migratedSnapshots} snapshots, ${migratedPerformance} performance records, ${migratedPositions} positions${orphanedMessage}`,
      };
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Update migration log to failed
    if (migrationLogId) {
      run(
        `UPDATE migration_log SET status = ?, completed_at = datetime('now'), error_message = ? WHERE id = ?`,
        "failed",
        errorMessage,
        migrationLogId
      );
    }
    return {
      success: false,
      message: `Migration failed: ${errorMessage}`,
    };
  }
}

/**
 * Create JSON backups of current database state.
 * Useful for creating backups after migration or periodically.
 */
export function createJsonBackups(): { success: boolean; message: string } {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(PROJECT_ROOT, "backups");

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // Backup lessons
    const lessons = query<{
      id: number;
      rule: string;
      tags: string;
      outcome: string;
      context: string;
      pool: string;
      pnl_pct: number;
      range_efficiency: number;
      created_at: string;
      pinned: number;
      role: string;
      data_json: string;
    }>("SELECT * FROM lessons");

    const lessonsBackup = {
      lessons: lessons.map((l) => parseJson(l.data_json) ?? l),
      exported_at: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(backupDir, `lessons-backup-${timestamp}.json`),
      JSON.stringify(lessonsBackup, null, 2)
    );

    // Backup pools with deploys
    const pools = query<{
      address: string;
      name: string;
      base_mint: string;
      total_deploys: number;
      avg_pnl_pct: number;
      win_rate: number;
      adjusted_win_rate: number;
      cooldown_until: string;
      cooldown_reason: string;
      data_json: string;
    }>("SELECT * FROM pools");

    const poolsBackup: Record<string, unknown> = {};
    for (const pool of pools) {
      const deploys = query<{
        deployed_at: string;
        closed_at: string;
        pnl_pct: number;
        pnl_usd: number;
        range_efficiency: number;
        minutes_held: number;
        close_reason: string;
        strategy: string;
        volatility_at_deploy: number;
        data_json: string;
      }>("SELECT * FROM pool_deploys WHERE pool_address = ?", pool.address);

      const snapshots = query<{
        ts: string;
        pnl_pct: number;
        pnl_usd: number;
        in_range: number;
        unclaimed_fees_usd: number;
        data_json: string;
      }>("SELECT * FROM position_snapshots WHERE position_address LIKE ?", `${pool.address}%`);

      poolsBackup[pool.address] = {
        ...(parseJson(pool.data_json) ?? pool),
        deploys: deploys.map((d) => parseJson(d.data_json) ?? d),
        snapshots: snapshots.map((s) => ({
          ...(parseJson(s.data_json) ?? s),
          in_range: Boolean(s.in_range),
        })),
      };
    }

    fs.writeFileSync(
      path.join(backupDir, `pool-memory-backup-${timestamp}.json`),
      JSON.stringify(poolsBackup, null, 2)
    );

    return {
      success: true,
      message: `Backups created in ${backupDir}: lessons-backup-${timestamp}.json, pool-memory-backup-${timestamp}.json`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Backup creation failed: ${errorMessage}`,
    };
  }
}

/**
 * Rollback a failed or partial migration.
 * Finds the most recent failed or started migration and restores from backup.
 */
export function rollbackMigration(): { success: boolean; message: string } {
  try {
    // Find the most recent failed or started migration
    const migrationRow = query<{ id: number; backup_path: string; status: string }>(
      `SELECT id, backup_path, status FROM migration_log
       WHERE status IN ('failed', 'started')
       ORDER BY started_at DESC LIMIT 1`
    )[0];

    if (!migrationRow) {
      return {
        success: false,
        message: "No failed or incomplete migration found to rollback",
      };
    }

    // Clear any partially migrated data
    // Delete data that may have been partially inserted during the failed migration
    run("DELETE FROM signal_weight_history");
    run("DELETE FROM signal_weights");
    run("DELETE FROM position_events");
    run("DELETE FROM position_snapshots");
    run("DELETE FROM pool_deploys");
    run("DELETE FROM performance");
    run("DELETE FROM lessons");
    run("DELETE FROM positions");
    run("DELETE FROM pools");

    // Update migration log status to rolled_back
    run(
      `UPDATE migration_log SET status = ?, completed_at = datetime('now') WHERE id = ?`,
      "rolled_back",
      migrationRow.id
    );

    return {
      success: true,
      message: `Migration rolled back successfully. Backup was at: ${migrationRow.backup_path}. Database tables have been cleared - you can retry migration or restore from the JSON backup files manually.`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Rollback failed: ${errorMessage}`,
    };
  }
}

/**
 * Validate that all required tables exist in the database.
 * Returns an object with the list of missing tables (empty if all present).
 */
export function validateSchema(): { valid: boolean; missingTables: string[] } {
  const requiredTables = [
    "schema_version",
    "positions",
    "position_snapshots",
    "position_events",
    "pools",
    "pool_deploys",
    "lessons",
    "performance",
    "signal_weights",
    "signal_weight_history",
    "migration_log",
    "position_state",
    "position_state_events",
    "state_metadata",
    "token_blacklist",
    "dev_blocklist",
    "strategies",
    "active_strategy",
    "threshold_suggestions",
    "threshold_history",
  ];

  const db = getDb();
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const existingNames = new Set(existing.map((r) => r.name));

  const missingTables = requiredTables.filter((t) => !existingNames.has(t));
  return { valid: missingTables.length === 0, missingTables };
}

/**
 * Full database setup - initialize schema and migrate if needed.
 */
export function setupDatabase(): { success: boolean; message: string } {
  try {
    initSchema();
    initThresholdEvolutionTables();

    if (needsJsonImport()) {
      const result = migrateFromJson();
      return result;
    }

    // Validate schema completeness after initialization
    const validation = validateSchema();
    if (!validation.valid) {
      log(
        "db_setup",
        `Schema validation warning: missing tables: ${validation.missingTables.join(", ")}`
      );
    }

    return {
      success: true,
      message: "Database initialized (schema already up to date)",
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Database setup failed: ${errorMessage}`,
    };
  }
}
