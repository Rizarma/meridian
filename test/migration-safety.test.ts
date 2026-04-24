/**
 * Phase 5 Migration Safety Tests
 *
 * Covers startup fail-closed behavior, JSON→SQLite migration, idempotency,
 * schema upgrades, partial failure handling, and rollback.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, runTests, test } from "./test-harness.js";

const PROJECT_ROOT = process.cwd();
const DIST_ROOT = path.join(PROJECT_ROOT, "dist", "src");
const DB_MIGRATIONS_URL = pathToFileURL(
  path.join(DIST_ROOT, "infrastructure", "db-migrations.js")
).href;
const ORCHESTRATOR_URL = pathToFileURL(path.join(DIST_ROOT, "orchestrator.js")).href;

type ChildResult = Record<string, unknown>;

type Fixture = {
  root: string;
  dbPath: string;
  lessons: Record<string, unknown>;
  poolMemory: Record<string, unknown>;
  state: Record<string, unknown>;
};

function makeFixtureRoot(prefix: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    dbPath: path.join(root, "meridian.db"),
    lessons: {
      lessons: [
        {
          id: 1,
          rule: "keep range tight",
          tags: ["risk", "range"],
          outcome: "good",
          context: "tight ranges performed well",
          pool: "pool-1",
          pnl_pct: 12.5,
          range_efficiency: 91,
          created_at: "2026-04-01T00:00:00.000Z",
          pinned: 1,
          role: "rule",
        },
      ],
      performance: [
        {
          position: "pos-a",
          pool: "pool-1",
          pool_name: "POOL/USDC",
          strategy: "spot",
          amount_sol: 1.5,
          pnl_pct: 8.2,
          pnl_usd: 12.34,
          fees_earned_usd: 1.23,
          initial_value_usd: 150,
          final_value_usd: 162.34,
          minutes_held: 240,
          minutes_in_range: 200,
          range_efficiency: 83,
          close_reason: "take_profit",
          base_mint: "So11111111111111111111111111111111111111112",
          bin_step: 100,
          volatility: 4.2,
          fee_tvl_ratio: 0.08,
          organic_score: 77,
          bin_range: [10, 20],
          recorded_at: "2026-04-01T01:00:00.000Z",
        },
      ],
    },
    poolMemory: {
      "pool-1": {
        name: "POOL/USDC",
        base_mint: "So11111111111111111111111111111111111111112",
        total_deploys: 1,
        avg_pnl_pct: 8.2,
        win_rate: 1,
        adjusted_win_rate: 1,
        cooldown_until: null,
        cooldown_reason: null,
        base_mint_cooldown_until: null,
        base_mint_cooldown_reason: null,
        deploys: [
          {
            deployed_at: "2026-03-31T00:00:00.000Z",
            closed_at: "2026-04-01T00:00:00.000Z",
            pnl_pct: 8.2,
            pnl_usd: 12.34,
            range_efficiency: 83,
            minutes_held: 240,
            close_reason: "take_profit",
            strategy: "spot",
            volatility_at_deploy: 4.2,
          },
        ],
        snapshots: [
          {
            position: "pos-open",
            ts: "2026-04-01T00:30:00.000Z",
            pnl_pct: 3.5,
            pnl_usd: 5.25,
            in_range: true,
            unclaimed_fees_usd: 0.5,
            minutes_out_of_range: 0,
            age_minutes: 30,
          },
        ],
      },
    },
    state: {
      positions: {
        "pos-open": {
          pool: "pool-1",
          pool_name: "POOL/USDC",
          strategy: "spot",
          deployed_at: "2026-03-31T00:00:00.000Z",
          closed_at: null,
          closed: false,
          amount_sol: 1.5,
          pnl_pct: 4.4,
          pnl_usd: 6.6,
          total_fees_claimed_usd: 0.6,
          initial_value_usd: 150,
          final_value_usd: 156.6,
          minutes_held: 180,
          close_reason: null,
          peak_pnl_pct: 9.9,
          pending_peak_pnl_pct: 8.8,
          pending_peak_started_at: "2026-04-01T00:15:00.000Z",
          trailing_active: true,
          pending_trailing_current_pnl_pct: 7.7,
          pending_trailing_peak_pnl_pct: 9.9,
          pending_trailing_drop_pct: 2.2,
          pending_trailing_started_at: "2026-04-01T00:20:00.000Z",
          confirmed_trailing_exit_reason: null,
          confirmed_trailing_exit_until: null,
          amount_x: 0,
          active_bin_at_deploy: 512,
          bin_step: 100,
          volatility: 4.2,
          fee_tvl_ratio: 0.08,
          initial_fee_tvl_24h: 0.12,
          organic_score: 77,
          strategy_config: { mode: "spot" },
          bin_range: [10, 20],
          signal_snapshot: { organic_score: 77 },
          out_of_range_since: null,
          last_claim_at: null,
          rebalance_count: 1,
          notes: ["watch closely"],
          instruction: "hold",
        },
        "pos-closed": {
          pool: "pool-1",
          pool_name: "POOL/USDC",
          strategy: "spot",
          deployed_at: "2026-03-30T00:00:00.000Z",
          closed_at: "2026-03-31T12:00:00.000Z",
          closed: true,
          amount_sol: 2,
          pnl_pct: -2.5,
          pnl_usd: -5,
          total_fees_claimed_usd: 0.3,
          initial_value_usd: 200,
          final_value_usd: 195,
          minutes_held: 120,
          close_reason: "stop_loss",
          peak_pnl_pct: 1.1,
          pending_peak_pnl_pct: null,
          pending_peak_started_at: null,
          trailing_active: false,
          pending_trailing_current_pnl_pct: null,
          pending_trailing_peak_pnl_pct: null,
          pending_trailing_drop_pct: null,
          pending_trailing_started_at: null,
          confirmed_trailing_exit_reason: null,
          confirmed_trailing_exit_until: null,
          notes: [],
        },
      },
    },
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeFixtureFiles(fixture: Fixture, corruptLessons = false): void {
  if (corruptLessons) {
    fs.writeFileSync(path.join(fixture.root, "lessons.json"), "{ invalid json");
  } else {
    writeJson(path.join(fixture.root, "lessons.json"), fixture.lessons);
  }

  writeJson(path.join(fixture.root, "pool-memory.json"), fixture.poolMemory);
  writeJson(path.join(fixture.root, "state.json"), fixture.state);
}

function runChildModule(
  body: string,
  env: Record<string, string>,
  cwd: string
): { status: number; stdout: string; stderr: string; result: ChildResult } {
  const script = [
    "console.log = () => {};",
    "console.warn = () => {};",
    "console.error = () => {};",
    body,
  ].join("\n");

  const output = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ...env },
    cwd,
    encoding: "utf8",
  });

  if (output.error) {
    throw output.error;
  }

  const markerLine = output.stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith("__RESULT__"));

  const result = markerLine
    ? (JSON.parse(markerLine.slice("__RESULT__".length)) as ChildResult)
    : (() => {
        throw new Error(
          `Child script did not return a result (exit=${output.status ?? "unknown"}). stdout=${output.stdout}\nstderr=${output.stderr}`
        );
      })();

  return {
    status: output.status ?? 0,
    stdout: output.stdout,
    stderr: output.stderr,
    result,
  };
}

function openDb(dbPath: string): Database.Database {
  return new Database(dbPath);
}

function countRows(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function collectCounts(db: Database.Database): Record<string, number> {
  return {
    lessons: countRows(db, "lessons"),
    performance: countRows(db, "performance"),
    pools: countRows(db, "pools"),
    pool_deploys: countRows(db, "pool_deploys"),
    position_snapshots: countRows(db, "position_snapshots"),
    positions: countRows(db, "positions"),
    position_state: countRows(db, "position_state"),
    position_events: countRows(db, "position_events"),
    migration_log: countRows(db, "migration_log"),
    schema_version: countRows(db, "schema_version"),
  };
}

function cleanupFixture(fixture: Fixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

describe("Migration Safety", () => {
  test("startup fails closed when DB setup fails", () => {
    const fixture = makeFixtureRoot("meridian-startup-fail-");

    try {
      const result = runChildModule(
        `const { start } = await import(${JSON.stringify(ORCHESTRATOR_URL)});
         let outcome = { threw: false, message: "" };
         try {
           await start();
         } catch (error) {
           outcome = { threw: true, message: error instanceof Error ? error.message : String(error) };
         }
          process.stdout.write("__RESULT__" + JSON.stringify(outcome) + "\\n");`,
        {
          MERIDIAN_ROOT: fixture.root,
          MERIDIAN_DB: path.join(fixture.root, "missing", "meridian.db"),
          OPENAI_API_KEY: "sk-test",
          LOG_LEVEL: "error",
        },
        fixture.root
      );

      expect(result.result.threw).toBe(true);
      expect(
        typeof result.result.message === "string" &&
          (result.result.message as string).includes("Database setup failed")
      ).toBe(true);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("fresh JSON migration loads data into SQLite", async () => {
    const fixture = makeFixtureRoot("meridian-migrate-fresh-");
    writeFixtureFiles(fixture);

    try {
      const result = runChildModule(
        `const { setupDatabase, migrateFromJson } = await import(${JSON.stringify(DB_MIGRATIONS_URL)});
          const setup = await setupDatabase();
          const migrate = await migrateFromJson();
          process.stdout.write("__RESULT__" + JSON.stringify({ setup, migrate }) + "\\n");`,
        {
          MERIDIAN_ROOT: fixture.root,
          MERIDIAN_DB: fixture.dbPath,
          LOG_LEVEL: "error",
        },
        fixture.root
      );

      expect(result.result.setup).toHaveProperty("success");
      expect((result.result.setup as { success: boolean }).success).toBe(true);
      expect((result.result.migrate as { success: boolean }).success).toBe(true);

      const db = openDb(fixture.dbPath);
      try {
        expect(collectCounts(db).lessons).toBe(1);
        expect(collectCounts(db).performance).toBe(1);
        expect(collectCounts(db).pools).toBe(1);
        expect(collectCounts(db).pool_deploys).toBe(1);
        expect(collectCounts(db).position_snapshots).toBe(1);
        expect(collectCounts(db).positions).toBe(2);
        expect(collectCounts(db).position_state).toBe(1);

        const lesson = db.prepare("SELECT * FROM lessons WHERE id = 1").get() as {
          rule: string;
          outcome: string;
        };
        expect(lesson.rule).toBe("keep range tight");
        expect(lesson.outcome).toBe("good");

        const pool = db.prepare("SELECT * FROM pools WHERE address = ?").get("pool-1") as {
          name: string;
        };
        expect(pool.name).toBe("POOL/USDC");

        const openPosition = db
          .prepare("SELECT * FROM positions WHERE address = ?")
          .get("pos-open") as {
          closed: number;
          strategy: string;
        };
        expect(openPosition.closed).toBe(0);
        expect(openPosition.strategy).toBe("spot");

        const snapshot = db
          .prepare("SELECT * FROM position_snapshots WHERE position_address = ?")
          .get("pos-open") as { in_range: number };
        expect(snapshot.in_range).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("partial JSON failure marks migration failed", async () => {
    const fixture = makeFixtureRoot("meridian-migrate-partial-");
    writeFixtureFiles(fixture, true);

    try {
      const result = runChildModule(
        `const { setupDatabase } = await import(${JSON.stringify(DB_MIGRATIONS_URL)});
          const setup = await setupDatabase();
         process.stdout.write("__RESULT__" + JSON.stringify({ setup }) + "\\n");`,
        {
          MERIDIAN_ROOT: fixture.root,
          MERIDIAN_DB: fixture.dbPath,
          LOG_LEVEL: "error",
        },
        fixture.root
      );

      const setup = result.result.setup as { success: boolean; message: string };
      expect(setup.success).toBe(false);
      expect(setup.message.includes("Migration failed")).toBe(true);

      const db = openDb(fixture.dbPath);
      try {
        const latest = db
          .prepare("SELECT status FROM migration_log ORDER BY id DESC LIMIT 1")
          .get() as { status: string };
        expect(latest.status).toBe("failed");
      } finally {
        db.close();
      }
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("migration is idempotent", async () => {
    const fixture = makeFixtureRoot("meridian-migrate-idempotent-");
    writeFixtureFiles(fixture);

    try {
      const result = runChildModule(
        `const { initSchema, migrateFromJson } = await import(${JSON.stringify(DB_MIGRATIONS_URL)});
          await initSchema();
          const first = await migrateFromJson();
          const second = await migrateFromJson();
         process.stdout.write("__RESULT__" + JSON.stringify({ first, second }) + "\\n");`,
        {
          MERIDIAN_ROOT: fixture.root,
          MERIDIAN_DB: fixture.dbPath,
          LOG_LEVEL: "error",
        },
        fixture.root
      );

      expect((result.result.first as { success: boolean }).success).toBe(true);
      expect((result.result.second as { success: boolean }).success).toBe(true);

      const db = openDb(fixture.dbPath);
      try {
        const counts = collectCounts(db);
        expect(counts.lessons).toBe(1);
        expect(counts.performance).toBe(1);
        expect(counts.pools).toBe(1);
        expect(counts.pool_deploys).toBe(1);
        expect(counts.position_snapshots).toBe(1);
        expect(counts.positions).toBe(2);
        expect(counts.position_state).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("schema upgrade bumps schema_version to 2", async () => {
    const fixture = makeFixtureRoot("meridian-schema-upgrade-");
    const db = openDb(fixture.dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (1);
      `);
    } finally {
      db.close();
    }

    try {
      const result = runChildModule(
        `const { setupDatabase } = await import(${JSON.stringify(DB_MIGRATIONS_URL)});
          const setup = await setupDatabase();
         process.stdout.write("__RESULT__" + JSON.stringify({ setup }) + "\\n");`,
        {
          MERIDIAN_ROOT: fixture.root,
          MERIDIAN_DB: fixture.dbPath,
          MERIDIAN_SCHEMA_VERSION: "2",
          LOG_LEVEL: "error",
        },
        fixture.root
      );

      const setup = result.result.setup as { success: boolean; message: string };
      expect(setup.success).toBe(true);
      expect(setup.message.includes("upgraded")).toBe(true);

      const upgradedDb = openDb(fixture.dbPath);
      try {
        const row = upgradedDb
          .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_version")
          .get() as { version: number };
        expect(row.version).toBe(2);
      } finally {
        upgradedDb.close();
      }
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("rollback restores JSON and clears SQLite tables", async () => {
    const fixture = makeFixtureRoot("meridian-rollback-");
    writeFixtureFiles(fixture, true);

    const originalLessons = fs.readFileSync(path.join(fixture.root, "lessons.json"), "utf8");
    const originalPoolMemory = fs.readFileSync(path.join(fixture.root, "pool-memory.json"), "utf8");
    const originalState = fs.readFileSync(path.join(fixture.root, "state.json"), "utf8");

    try {
      const result = runChildModule(
        `const { setupDatabase, rollbackMigration } = await import(${JSON.stringify(DB_MIGRATIONS_URL)});
          const setup = await setupDatabase();
          const rollback = await rollbackMigration();
         process.stdout.write("__RESULT__" + JSON.stringify({ setup, rollback }) + "\\n");`,
        {
          MERIDIAN_ROOT: fixture.root,
          MERIDIAN_DB: fixture.dbPath,
          LOG_LEVEL: "error",
        },
        fixture.root
      );

      const setup = result.result.setup as { success: boolean };
      const rollback = result.result.rollback as { success: boolean; message: string };
      expect(setup.success).toBe(false);
      expect(rollback.success).toBe(true);
      expect(rollback.message.includes("restored")).toBe(true);

      const restoredLessons = fs.readFileSync(path.join(fixture.root, "lessons.json"), "utf8");
      const restoredPoolMemory = fs.readFileSync(
        path.join(fixture.root, "pool-memory.json"),
        "utf8"
      );
      const restoredState = fs.readFileSync(path.join(fixture.root, "state.json"), "utf8");

      expect(restoredLessons).toBe(originalLessons);
      expect(restoredPoolMemory).toBe(originalPoolMemory);
      expect(restoredState).toBe(originalState);

      const db = openDb(fixture.dbPath);
      try {
        expect(countRows(db, "lessons")).toBe(0);
        expect(countRows(db, "pools")).toBe(0);
        expect(countRows(db, "positions")).toBe(0);
        expect(countRows(db, "position_state")).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      cleanupFixture(fixture);
    }
  });
});

if (
  import.meta.url.startsWith("file://") &&
  process.argv[1] &&
  import.meta.url.includes(process.argv[1].replace(/\\/g, "/"))
) {
  runTests();
}
