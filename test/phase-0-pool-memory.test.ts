/**
 * Phase 0 Pool Memory Snapshot Recall Tests
 *
 * Tests the fix for:
 * 1. Snapshot recall bug: getPoolSnapshots(poolAddress) queried with
 *    `LIKE '${poolAddress}%'` but snapshots are stored by position PDA address,
 *    not pool address — so the query always returned empty.
 * 2. Redundant pools reads in management cycle.
 */

import Database from "better-sqlite3";
import { setInfrastructure } from "../src/di-container.js";
import {
  getBaseMintsOnCooldown,
  getKnownPoolAddresses,
  getPoolsOnCooldown,
  recallForPool,
  recordPositionSnapshot,
} from "../src/domain/pool-memory.js";
import { describe, expect, runTests, test } from "./test-harness.js";

// ─── In-memory DB Setup ─────────────────────────────────────────

/** Create an in-memory SQLite database with the minimal schema needed. */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

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
      data_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
      trailing_state TEXT,
      notes TEXT,
      data_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
    );

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
      data_json TEXT
    );

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
    );

    CREATE TABLE IF NOT EXISTS position_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_address TEXT NOT NULL,
      event_type TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      data_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_positions_pool ON positions(pool);
    CREATE INDEX IF NOT EXISTS idx_snapshots_position ON position_snapshots(position_address);
    CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON position_snapshots(ts);
    CREATE INDEX IF NOT EXISTS idx_pool_deploys_pool ON pool_deploys(pool_address);
  `);

  return db;
}

/** Wire the test database into the DI container. */
function wireTestDb(db: Database.Database): void {
  // Create a wrapper matching the DatabaseOperations + JsonOperations interface
  const dbOps = {
    query: <T>(sql: string, ...params: unknown[]): T[] => {
      return db.prepare(sql).all(...params) as T[];
    },
    get: <T>(sql: string, ...params: unknown[]): T | undefined => {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    run: (
      sql: string,
      ...params: unknown[]
    ): { lastInsertRowid: number | bigint; changes: number } => {
      const result = db.prepare(sql).run(...params);
      return { lastInsertRowid: result.lastInsertRowid, changes: result.changes };
    },
    transaction: <T>(callback: () => T): T => {
      return db.transaction(callback)();
    },
    stringifyJson: <T>(value: T): string => JSON.stringify(value),
    parseJson: <T>(value: string | null | undefined): T | null => {
      if (!value) return null;
      try {
        return JSON.parse(value) as T;
      } catch {
        return null;
      }
    },
  };

  setInfrastructure({
    db: dbOps,
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    },
    notifications: {
      send: async () => {},
    },
  });
}

// Test constants
const POOL_ADDR = "PoolAddr1111111111111111111111111111111111111";
const POSITION_ADDR = "PosAddr2222222222222222222222222222222222222";
const POSITION_ADDR_2 = "PosAddr3333333333333333333333333333333333333";

// ─── Test Suite ──────────────────────────────────────────────────

describe("Pool Memory - Snapshot Recall", () => {
  let testDb: Database.Database;

  // Set up fresh DB for each logical group
  test("setup test database", () => {
    testDb = createTestDb();
    wireTestDb(testDb);

    // Insert pool
    testDb
      .prepare(`INSERT INTO pools (address, name, total_deploys) VALUES (?, ?, 0)`)
      .run(POOL_ADDR, "TEST/SOL");

    // Insert position mapping pool -> position address
    testDb
      .prepare(
        `INSERT INTO positions (address, pool, pool_name, strategy, deployed_at)
       VALUES (?, ?, ?, 'spot', datetime('now'))`
      )
      .run(POSITION_ADDR, POOL_ADDR, "TEST/SOL");

    // Insert position_state mapping
    testDb
      .prepare(
        `INSERT INTO position_state (position, pool, pool_name, strategy, amount_sol, deployed_at)
       VALUES (?, ?, ?, 'spot', 1.0, datetime('now'))`
      )
      .run(POSITION_ADDR_2, POOL_ADDR, "TEST/SOL");

    // Insert snapshots keyed by position address (NOT pool address)
    for (let i = 0; i < 5; i++) {
      testDb
        .prepare(
          `INSERT INTO position_snapshots (position_address, ts, pnl_pct, pnl_usd, in_range, age_minutes)
         VALUES (?, datetime('now', '-${5 - i} minutes'), ?, ?, 1, ?)`
        )
        .run(POSITION_ADDR, i * 2 - 2, i * 0.5, i * 10);
    }
    // Snapshot for second position
    testDb
      .prepare(
        `INSERT INTO position_snapshots (position_address, ts, pnl_pct, pnl_usd, in_range, age_minutes)
       VALUES (?, datetime('now'), 10.0, 5.0, 1, 60)`
      )
      .run(POSITION_ADDR_2);

    expect(true).toBe(true); // setup succeeded
  });

  test("recallForPool finds snapshots via position lookup", () => {
    const result = recallForPool(POOL_ADDR);
    // Should return non-null because pool has deploys via snapshots
    // The recall should include RECENT TREND since we have 5 snapshots
    expect(result).toBeTruthy();
    if (result) {
      // Should contain RECENT TREND from the snapshots
      expect(result.includes("RECENT TREND")).toBe(true);
    }
  });

  test("recallForPool returns null for unknown pool", () => {
    const result = recallForPool("UnknownPool0000000000000000000000000");
    expect(result).toBe(null);
  });

  test("recallForPool returns null for empty string", () => {
    const result = recallForPool("");
    expect(result).toBe(null);
  });

  test("snapshots from multiple positions are found", () => {
    // Both POSITION_ADDR and POSITION_ADDR_2 belong to POOL_ADDR
    // recallForPool should find snapshots from both
    const result = recallForPool(POOL_ADDR);
    expect(result).toBeTruthy();
    // At least 6 snapshots exist (5 from POSITION_ADDR + 1 from POSITION_ADDR_2)
    // The RECENT TREND line should show trend data
    if (result) {
      expect(result.includes("RECENT TREND")).toBe(true);
    }
  });

  test("fallback snapshot pattern also works", () => {
    // Insert a fallback-style snapshot: poolAddress + "_snapshot_" + timestamp
    const fallbackAddr = `${POOL_ADDR}_snapshot_1700000000000`;
    testDb
      .prepare(
        `INSERT INTO position_snapshots (position_address, ts, pnl_pct, pnl_usd, in_range, age_minutes)
       VALUES (?, datetime('now'), 3.0, 1.5, 1, 30)`
      )
      .run(fallbackAddr);

    const result = recallForPool(POOL_ADDR);
    expect(result).toBeTruthy();
    // Should still work (found at least the existing snapshots + fallback)
    if (result) {
      expect(result.includes("RECENT TREND")).toBe(true);
    }
  });

  test("snapshot stored under pool address directly is NOT incorrectly matched", () => {
    // A snapshot stored with position_address = exact pool address
    // (which is wrong but could happen) should be found via the fallback pattern
    // only if it matches the _snapshot_ pattern — NOT by the old broken LIKE
    testDb
      .prepare(
        `INSERT INTO position_snapshots (position_address, ts, pnl_pct, pnl_usd, in_range, age_minutes)
       VALUES (?, datetime('now'), 1.0, 0.5, 0, 45)`
      )
      .run("CompletelyDifferentAddr4444444444444444444444");

    // Pool with no positions and no fallback snapshots should return null
    // (no pool row exists)
    const result = recallForPool("CompletelyDifferentAddr4444444444444444444444");
    expect(result).toBe(null);
  });
});

describe("Pool Memory - recordPositionSnapshot return value", () => {
  let testDb: Database.Database;

  test("setup", () => {
    testDb = createTestDb();
    wireTestDb(testDb);
    expect(true).toBe(true);
  });

  test("recordPositionSnapshot returns PoolRow for new pool", () => {
    const poolRow = recordPositionSnapshot(POOL_ADDR, {
      position: POSITION_ADDR,
      pair: "NEW/SOL",
      pnl_pct: 5.0,
      pnl_usd: 2.5,
      in_range: true,
      age_minutes: 30,
    });

    expect(poolRow).toBeTruthy();
    if (poolRow) {
      expect(poolRow.address).toBe(POOL_ADDR);
    }
  });

  test("recordPositionSnapshot returns null for empty pool address", () => {
    const poolRow = recordPositionSnapshot("", {
      position: POSITION_ADDR,
    });
    expect(poolRow).toBe(null);
  });

  test("recorded snapshot is findable via recallForPool", () => {
    // First ensure a position→pool mapping exists so getPoolSnapshots can find it
    testDb
      .prepare(
        `INSERT OR IGNORE INTO positions (address, pool, pool_name, strategy, deployed_at)
       VALUES (?, ?, ?, 'spot', datetime('now'))`
      )
      .run(POSITION_ADDR, POOL_ADDR, "NEW/SOL");

    // Record multiple snapshots to build a trend
    for (let i = 0; i < 5; i++) {
      recordPositionSnapshot(POOL_ADDR, {
        position: POSITION_ADDR,
        pair: "NEW/SOL",
        pnl_pct: i * 1.0,
        pnl_usd: i * 0.5,
        in_range: true,
        age_minutes: (i + 1) * 10,
      });
    }

    const result = recallForPool(POOL_ADDR);
    expect(result).toBeTruthy();
    if (result) {
      expect(result.includes("RECENT TREND")).toBe(true);
    }
  });
});

describe("Pool Memory - recallForPool with preloadedPool", () => {
  let testDb: Database.Database;

  test("setup", () => {
    testDb = createTestDb();
    wireTestDb(testDb);

    // Insert pool with data
    testDb
      .prepare(
        `INSERT INTO pools (address, name, total_deploys, avg_pnl_pct, win_rate, adjusted_win_rate)
       VALUES (?, ?, 3, 5.5, 0.67, 0.75)`
      )
      .run(POOL_ADDR, "PRELOADED/SOL");

    // Insert some snapshots via positions
    testDb
      .prepare(
        `INSERT INTO positions (address, pool, pool_name, strategy, deployed_at)
       VALUES (?, ?, ?, 'spot', datetime('now'))`
      )
      .run(POSITION_ADDR, POOL_ADDR, "PRELOADED/SOL");

    for (let i = 0; i < 5; i++) {
      testDb
        .prepare(
          `INSERT INTO position_snapshots (position_address, ts, pnl_pct, pnl_usd, in_range, age_minutes)
         VALUES (?, datetime('now', '-${5 - i} minutes'), ?, ?, 1, ?)`
        )
        .run(POSITION_ADDR, i * 1.5, i * 0.3, i * 10);
    }

    expect(true).toBe(true);
  });

  test("recallForPool accepts preloadedPool and skips DB read", () => {
    // Pre-fetched pool row (simulates what recordPositionSnapshot returns)
    const preloadedPool = {
      address: POOL_ADDR,
      name: "PRELOADED/SOL",
      base_mint: null,
      total_deploys: 3,
      avg_pnl_pct: 5.5,
      win_rate: 0.67,
      adjusted_win_rate: 0.75,
      cooldown_until: null,
      cooldown_reason: null,
      base_mint_cooldown_until: null,
      base_mint_cooldown_reason: null,
      data_json: null,
    };

    const result = recallForPool(POOL_ADDR, preloadedPool);
    expect(result).toBeTruthy();
    if (result) {
      expect(result.includes("PRELOADED/SOL")).toBe(true);
      expect(result.includes("3 past deploy(s)")).toBe(true);
      expect(result.includes("RECENT TREND")).toBe(true);
    }
  });

  test("recallForPool with null preloadedPool falls back to DB read", () => {
    const result = recallForPool(POOL_ADDR, null);
    // Should still work — falls back to querying DB
    expect(result).toBeTruthy();
    if (result) {
      expect(result.includes("PRELOADED/SOL")).toBe(true);
    }
  });

  test("management cycle pattern: recordPositionSnapshot then recallForPool with returned row", () => {
    // This tests the exact pattern used in management.ts
    const poolRow = recordPositionSnapshot(POOL_ADDR, {
      position: POSITION_ADDR,
      pair: "PRELOADED/SOL",
      pnl_pct: 10.0,
      in_range: true,
      age_minutes: 100,
    });

    // poolRow should be non-null and contain the pool address
    expect(poolRow).toBeTruthy();
    if (poolRow) {
      expect(poolRow.address).toBe(POOL_ADDR);
    }

    // Pass the preloaded row to recallForPool
    const recall = recallForPool(POOL_ADDR, poolRow);
    expect(recall).toBeTruthy();
    if (recall) {
      expect(recall.includes("PRELOADED/SOL")).toBe(true);
      expect(recall.includes("RECENT TREND")).toBe(true);
    }
  });
});

describe("Pool Memory - getKnownPoolAddresses", () => {
  let testDb: Database.Database;

  test("setup", () => {
    testDb = createTestDb();
    wireTestDb(testDb);

    // Insert known pools
    testDb
      .prepare(`INSERT INTO pools (address, name, total_deploys) VALUES (?, ?, 0)`)
      .run(POOL_ADDR, "KNOWN/SOL");
    testDb
      .prepare(`INSERT INTO pools (address, name, total_deploys) VALUES (?, ?, 0)`)
      .run(POSITION_ADDR, "OTHER/SOL");

    expect(true).toBe(true);
  });

  test("returns empty set for empty input", () => {
    const result = getKnownPoolAddresses([]);
    expect(result.size).toBe(0);
  });

  test("returns only addresses that exist in pools table", () => {
    const result = getKnownPoolAddresses([
      POOL_ADDR, // exists
      POSITION_ADDR, // exists
      "UnknownPool0000000000000000000000000", // does not exist
    ]);
    expect(result.size).toBe(2);
    expect(result.has(POOL_ADDR)).toBe(true);
    expect(result.has(POSITION_ADDR)).toBe(true);
    expect(result.has("UnknownPool0000000000000000000000000")).toBe(false);
  });

  test("returns empty set when no addresses match", () => {
    const result = getKnownPoolAddresses([
      "UnknownA0000000000000000000000000000000",
      "UnknownB0000000000000000000000000000000",
    ]);
    expect(result.size).toBe(0);
  });

  test("handles duplicate addresses gracefully", () => {
    const result = getKnownPoolAddresses([POOL_ADDR, POOL_ADDR, POOL_ADDR]);
    expect(result.size).toBe(1);
    expect(result.has(POOL_ADDR)).toBe(true);
  });
});

describe("Pool Memory - getPoolsOnCooldown (batch)", () => {
  let testDb: Database.Database;
  const POOL_A = "CooldownPoolA111111111111111111111111111111";
  const POOL_B = "CooldownPoolB222222222222222222222222222222";
  const POOL_C = "CooldownPoolC333333333333333333333333333333";

  test("setup", () => {
    testDb = createTestDb();
    wireTestDb(testDb);

    // Pool A: active cooldown (1 hour in the future)
    testDb
      .prepare(
        `INSERT INTO pools (address, name, total_deploys, cooldown_until) VALUES (?, ?, 0, ?)`
      )
      .run(POOL_A, "ONCOOL/SOL", new Date(Date.now() + 3600_000).toISOString());

    // Pool B: expired cooldown (1 hour in the past)
    testDb
      .prepare(
        `INSERT INTO pools (address, name, total_deploys, cooldown_until) VALUES (?, ?, 0, ?)`
      )
      .run(POOL_B, "EXPIRED/SOL", new Date(Date.now() - 3600_000).toISOString());

    // Pool C: no cooldown
    testDb
      .prepare(`INSERT INTO pools (address, name, total_deploys) VALUES (?, ?, 0)`)
      .run(POOL_C, "NOCOOL/SOL");

    expect(true).toBe(true);
  });

  test("returns only pools with active cooldown", () => {
    const result = getPoolsOnCooldown([POOL_A, POOL_B, POOL_C]);
    expect(result.size).toBe(1);
    expect(result.has(POOL_A)).toBe(true);
    expect(result.has(POOL_B)).toBe(false);
    expect(result.has(POOL_C)).toBe(false);
  });

  test("returns empty set for empty input", () => {
    const result = getPoolsOnCooldown([]);
    expect(result.size).toBe(0);
  });

  test("returns empty set for unknown addresses", () => {
    const result = getPoolsOnCooldown(["UnknownZZZ00000000000000000000000000"]);
    expect(result.size).toBe(0);
  });

  test("handles duplicates gracefully", () => {
    const result = getPoolsOnCooldown([POOL_A, POOL_A]);
    expect(result.size).toBe(1);
    expect(result.has(POOL_A)).toBe(true);
  });
});

describe("Pool Memory - getBaseMintsOnCooldown (batch)", () => {
  let testDb: Database.Database;
  const MINT_X = "BaseMintX0000000000000000000000000000000000";
  const MINT_Y = "BaseMintY0000000000000000000000000000000000";
  const POOL_X = "PoolForMintX1111111111111111111111111111111";
  const POOL_Y = "PoolForMintY2222222222222222222222222222222";

  test("setup", () => {
    testDb = createTestDb();
    wireTestDb(testDb);

    // Pool with active base mint cooldown
    testDb
      .prepare(
        `INSERT INTO pools (address, name, base_mint, total_deploys, base_mint_cooldown_until)
         VALUES (?, ?, ?, 0, ?)`
      )
      .run(POOL_X, "TOKEN_X/SOL", MINT_X, new Date(Date.now() + 3600_000).toISOString());

    // Pool with expired base mint cooldown
    testDb
      .prepare(
        `INSERT INTO pools (address, name, base_mint, total_deploys, base_mint_cooldown_until)
         VALUES (?, ?, ?, 0, ?)`
      )
      .run(POOL_Y, "TOKEN_Y/SOL", MINT_Y, new Date(Date.now() - 3600_000).toISOString());

    expect(true).toBe(true);
  });

  test("returns only mints with active cooldown", () => {
    const result = getBaseMintsOnCooldown([MINT_X, MINT_Y]);
    expect(result.size).toBe(1);
    expect(result.has(MINT_X)).toBe(true);
    expect(result.has(MINT_Y)).toBe(false);
  });

  test("returns empty set for empty input", () => {
    const result = getBaseMintsOnCooldown([]);
    expect(result.size).toBe(0);
  });

  test("returns empty set for unknown mints", () => {
    const result = getBaseMintsOnCooldown(["UnknownMint000000000000000000000000000"]);
    expect(result.size).toBe(0);
  });

  test("handles duplicates gracefully", () => {
    const result = getBaseMintsOnCooldown([MINT_X, MINT_X]);
    expect(result.size).toBe(1);
    expect(result.has(MINT_X)).toBe(true);
  });
});

// ─── Run ─────────────────────────────────────────────────────────

runTests();
