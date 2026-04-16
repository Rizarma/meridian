/**
 * Pool memory — persistent deploy history per pool (SQLite implementation).
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import fs from "node:fs";
import { registerTool } from "../../tools/registry.js";
import { config } from "../config/config.js";
import { getInfrastructure } from "../di-container.js";
import { log } from "../infrastructure/logger.js";

function getDb() {
  return getInfrastructure().db;
}

import type {
  PoolMemoryDB,
  PoolMemoryEntry,
  PoolMemoryInput,
  PoolMemoryResult,
  PoolNoteResult,
  PoolSnapshot,
  PositionSnapshotInput,
} from "../types/pool-memory.js";

// Optional: Enable dual-write to JSON for safety during transition
const DUAL_WRITE_TO_JSON = process.env.POOL_MEMORY_DUAL_WRITE === "true";
const POOL_MEMORY_FILE = "./pool-memory.json";
const MAX_NOTE_LENGTH = 280;

// ─── JSON Backup Helpers (for dual-write mode) ─────────────────

function loadJson(): PoolMemoryDB {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8")) as PoolMemoryDB;
  } catch {
    return {};
  }
}

function saveJson(data: PoolMemoryDB): void {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(data, null, 2));
}

// ─── Utility Functions ───────────────────────────────────────────

function sanitizeStoredNote(
  text: string | null | undefined,
  maxLen = MAX_NOTE_LENGTH
): string | null {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function isAdjustedWinRateExcludedReason(reason: string | null | undefined): boolean {
  const text = String(reason || "")
    .trim()
    .toLowerCase();
  return (
    text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor")
  );
}

function isOorCloseReason(reason: string | null | undefined): boolean {
  const text = String(reason || "")
    .trim()
    .toLowerCase();
  return text === "oor" || text.includes("out of range") || text.includes("oor");
}

// ─── Database Helpers ──────────────────────────────────────────

interface PoolRow {
  address: string;
  name: string;
  base_mint: string | null;
  total_deploys: number;
  avg_pnl_pct: number | null;
  win_rate: number | null;
  adjusted_win_rate: number | null;
  cooldown_until: string | null;
  cooldown_reason: string | null;
  base_mint_cooldown_until: string | null;
  base_mint_cooldown_reason: string | null;
  data_json: string | null;
}

interface PoolDeployRow {
  id: number;
  pool_address: string;
  deployed_at: string | null;
  closed_at: string | null;
  pnl_pct: number | null;
  pnl_usd: number | null;
  range_efficiency: number | null;
  minutes_held: number | null;
  close_reason: string | null;
  strategy: string | null;
  volatility_at_deploy: number | null;
  data_json: string | null;
}

interface PoolNoteRow {
  id: number;
  position_address: string;
  event_type: string;
  ts: string;
  data_json: string;
}

interface SnapshotRow {
  ts: string;
  position_address: string;
  pnl_pct: number | null;
  pnl_usd: number | null;
  in_range: number;
  unclaimed_fees_usd: number | null;
  minutes_out_of_range: number | null;
  age_minutes: number | null;
  data_json: string | null;
}

/**
 * Get or create a pool record in the database.
 */
function getOrCreatePool(poolAddress: string, name?: string): PoolRow {
  let pool = getDb().get<PoolRow>("SELECT * FROM pools WHERE address = ?", poolAddress);

  if (!pool) {
    getDb().run(
      `INSERT INTO pools (address, name, total_deploys, created_at, updated_at)
       VALUES (?, ?, 0, datetime('now'), datetime('now'))`,
      poolAddress,
      name || poolAddress.slice(0, 8)
    );
    pool = getDb().get<PoolRow>("SELECT * FROM pools WHERE address = ?", poolAddress)!;
  }

  return pool;
}

/**
 * Get snapshots for a pool by looking up position addresses that contain the pool address.
 */
function getPoolSnapshots(poolAddress: string): PoolSnapshot[] {
  const rows = getDb().query<SnapshotRow>(
    `SELECT * FROM position_snapshots
     WHERE position_address LIKE ?
     ORDER BY ts DESC LIMIT 48`,
    `${poolAddress}%`
  );

  return rows.map((s) => ({
    ts: s.ts,
    position: s.position_address,
    pnl_pct: s.pnl_pct,
    pnl_usd: s.pnl_usd,
    in_range: s.in_range === 1,
    unclaimed_fees_usd: s.unclaimed_fees_usd,
    minutes_out_of_range: s.minutes_out_of_range,
    age_minutes: s.age_minutes,
  }));
}

// ─── Write Operations ──────────────────────────────────────────

/**
 * Record a closed deploy into the database.
 * Called automatically from recordPerformance() in lessons.js.
 */
export function recordPoolDeploy(poolAddress: string, deployData: PoolMemoryInput): void {
  if (!poolAddress) return;

  getDb().transaction(() => {
    // Get or create pool
    const pool = getOrCreatePool(poolAddress, deployData.pool_name);

    // Update pool base_mint if provided
    if (deployData.base_mint && !pool.base_mint) {
      getDb().run(
        "UPDATE pools SET base_mint = ?, updated_at = datetime('now') WHERE address = ?",
        deployData.base_mint,
        poolAddress
      );
    }

    // Insert the deploy record
    const closedAt = deployData.closed_at || new Date().toISOString();
    getDb().run(
      `INSERT INTO pool_deploys
       (pool_address, deployed_at, closed_at, pnl_pct, pnl_usd, range_efficiency,
        minutes_held, close_reason, strategy, volatility_at_deploy, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      poolAddress,
      deployData.deployed_at || null,
      closedAt,
      deployData.pnl_pct ?? null,
      deployData.pnl_usd ?? null,
      deployData.range_efficiency ?? null,
      deployData.minutes_held ?? null,
      deployData.close_reason || null,
      deployData.strategy || null,
      deployData.volatility ?? null,
      getDb().stringifyJson(deployData)
    );

    // Get all deploys to recalculate aggregates
    const deploys = getDb().query<PoolDeployRow>(
      "SELECT * FROM pool_deploys WHERE pool_address = ? ORDER BY closed_at",
      poolAddress
    );

    // Recalculate aggregates
    const withPnl = deploys.filter((d) => d.pnl_pct != null);
    let avgPnlPct = 0;
    let winRate = 0;
    let adjustedWinRate = 0;

    if (withPnl.length > 0) {
      avgPnlPct =
        Math.round((withPnl.reduce((s, d) => s + (d.pnl_pct ?? 0), 0) / withPnl.length) * 100) /
        100;
      winRate =
        Math.round((withPnl.filter((d) => (d.pnl_pct ?? 0) >= 0).length / withPnl.length) * 100) /
        100;

      const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));
      adjustedWinRate =
        adjusted.length > 0
          ? Math.round(
              (adjusted.filter((d) => (d.pnl_pct ?? 0) >= 0).length / adjusted.length) * 10000
            ) / 100
          : 0;
    }

    // Update pool aggregates
    getDb().run(
      `UPDATE pools SET
        total_deploys = ?,
        avg_pnl_pct = ?,
        win_rate = ?,
        adjusted_win_rate = ?,
        updated_at = datetime('now')
       WHERE address = ?`,
      deploys.length,
      avgPnlPct || null,
      winRate || null,
      adjustedWinRate || null,
      poolAddress
    );

    // Handle cooldowns
    const lastOutcome = (deployData.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

    // Set cooldown for low yield closes
    if (deployData.close_reason === "low yield") {
      const cooldownHours = 4;
      const cooldownUntil = new Date(Date.now() + cooldownHours * 60 * 60 * 1000).toISOString();
      getDb().run(
        `UPDATE pools SET cooldown_until = ?, cooldown_reason = ?, updated_at = datetime('now') WHERE address = ?`,
        cooldownUntil,
        "low yield",
        poolAddress
      );
      log("pool-memory", `Cooldown set for ${pool.name} until ${cooldownUntil} (low yield close)`);
    }

    // Check for repeated OOR closes
    const oorTriggerCount = config.management.oorCooldownTriggerCount ?? 3;
    const oorCooldownHours = config.management.oorCooldownHours ?? 12;
    const recentDeploys = deploys.slice(-oorTriggerCount);
    const repeatedOorCloses =
      recentDeploys.length >= oorTriggerCount &&
      recentDeploys.every((d) => isOorCloseReason(d.close_reason));

    if (repeatedOorCloses) {
      const reason = `repeated OOR closes (${oorTriggerCount}x)`;
      const cooldownUntil = new Date(Date.now() + oorCooldownHours * 60 * 60 * 1000).toISOString();

      // Set pool cooldown
      getDb().run(
        `UPDATE pools SET cooldown_until = ?, cooldown_reason = ?, updated_at = datetime('now') WHERE address = ?`,
        cooldownUntil,
        reason,
        poolAddress
      );
      log("pool-memory", `Cooldown set for ${pool.name} until ${cooldownUntil} (${reason})`);

      // Set base mint cooldown for all pools with same base mint
      if (deployData.base_mint || pool.base_mint) {
        const baseMint = deployData.base_mint || pool.base_mint;
        getDb().run(
          `UPDATE pools SET base_mint_cooldown_until = ?, base_mint_cooldown_reason = ?, updated_at = datetime('now') WHERE base_mint = ?`,
          cooldownUntil,
          reason,
          baseMint
        );
        log(
          "pool-memory",
          `Base mint cooldown set for ${baseMint!.slice(0, 8)} until ${cooldownUntil} (${reason})`
        );
      }
    }

    // Dual-write to JSON if enabled
    if (DUAL_WRITE_TO_JSON) {
      const jsonDb = loadJson();
      const entry: PoolMemoryEntry = {
        name: deployData.pool_name || poolAddress.slice(0, 8),
        base_mint: deployData.base_mint || pool.base_mint || null,
        deploys: deploys.map((d) => ({
          deployed_at: d.deployed_at,
          closed_at: d.closed_at || new Date().toISOString(),
          pnl_pct: d.pnl_pct,
          pnl_usd: d.pnl_usd,
          range_efficiency: d.range_efficiency,
          minutes_held: d.minutes_held,
          close_reason: d.close_reason,
          strategy: d.strategy,
          volatility_at_deploy: d.volatility_at_deploy,
        })),
        total_deploys: deploys.length,
        avg_pnl_pct: avgPnlPct,
        win_rate: winRate,
        adjusted_win_rate: adjustedWinRate,
        adjusted_win_rate_sample_count: withPnl.filter(
          (d) => !isAdjustedWinRateExcludedReason(d.close_reason)
        ).length,
        last_deployed_at: closedAt,
        last_outcome: lastOutcome,
        notes: [],
      };
      jsonDb[poolAddress] = entry;
      saveJson(jsonDb);
    }

    log(
      "pool-memory",
      `Recorded deploy for ${pool.name} (${poolAddress.slice(0, 8)}): PnL ${deployData.pnl_pct}%`
    );
  });
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per position (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress: string, snapshot: PositionSnapshotInput): void {
  if (!poolAddress) return;

  getDb().transaction(() => {
    // Ensure pool exists
    getOrCreatePool(poolAddress, snapshot.pair);

    // Insert snapshot
    const positionAddr = snapshot.position || `${poolAddress}_snapshot_${Date.now()}`;
    getDb().run(
      `INSERT INTO position_snapshots
       (position_address, ts, pnl_pct, pnl_usd, in_range, unclaimed_fees_usd,
        minutes_out_of_range, age_minutes, data_json)
       VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)`,
      positionAddr,
      snapshot.pnl_pct ?? null,
      snapshot.pnl_usd ?? null,
      snapshot.in_range === true ? 1 : snapshot.in_range === false ? 0 : null,
      snapshot.unclaimed_fees_usd ?? null,
      snapshot.minutes_out_of_range ?? null,
      snapshot.age_minutes ?? null,
      getDb().stringifyJson(snapshot)
    );

    // Keep only last 48 snapshots for this position
    const count = getDb().get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM position_snapshots WHERE position_address = ?",
      positionAddr
    );

    if (count && count.cnt > 48) {
      getDb().run(
        `DELETE FROM position_snapshots
         WHERE position_address = ?
         AND id IN (
           SELECT id FROM position_snapshots
           WHERE position_address = ?
           ORDER BY ts ASC
           LIMIT ?
         )`,
        positionAddr,
        positionAddr,
        count.cnt - 48
      );
    }
  });
}

// ─── Read Operations ───────────────────────────────────────────

export function isPoolOnCooldown(poolAddress: string): boolean {
  if (!poolAddress) return false;

  const pool = getDb().get<PoolRow>(
    "SELECT cooldown_until FROM pools WHERE address = ?",
    poolAddress
  );

  if (!pool?.cooldown_until) return false;
  return new Date(pool.cooldown_until) > new Date();
}

export function isBaseMintOnCooldown(baseMint: string): boolean {
  if (!baseMint) return false;

  const pool = getDb().get<PoolRow>(
    `SELECT base_mint_cooldown_until FROM pools
     WHERE base_mint = ? AND base_mint_cooldown_until IS NOT NULL
     LIMIT 1`,
    baseMint
  );

  if (!pool?.base_mint_cooldown_until) return false;
  return new Date(pool.base_mint_cooldown_until) > new Date();
}

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }: { pool_address: string }): PoolMemoryResult {
  if (!pool_address) return { error: "pool_address required", pool_address: "", known: false };

  const pool = getDb().get<PoolRow>("SELECT * FROM pools WHERE address = ?", pool_address);

  if (!pool) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  const deploys = getDb().query<PoolDeployRow>(
    "SELECT * FROM pool_deploys WHERE pool_address = ? ORDER BY closed_at",
    pool_address
  );

  const noteEvents = getDb().query<PoolNoteRow>(
    "SELECT * FROM position_events WHERE position_address = ? AND event_type = 'pool_note' ORDER BY ts",
    pool_address
  );

  // Calculate adjusted win rate sample count
  const withPnl = deploys.filter((d) => d.pnl_pct != null);
  const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));

  // Parse notes from JSON
  const notes: { note: string; added_at: string }[] = [];
  for (const event of noteEvents) {
    const data = JSON.parse(event.data_json || "{}") as { note?: string; added_at?: string };
    if (data.note) {
      notes.push({ note: data.note, added_at: data.added_at || event.ts });
    }
  }

  return {
    pool_address,
    known: true,
    name: pool.name,
    base_mint: pool.base_mint,
    total_deploys: pool.total_deploys,
    avg_pnl_pct: pool.avg_pnl_pct ?? 0,
    win_rate: pool.win_rate ?? 0,
    adjusted_win_rate: pool.adjusted_win_rate ?? 0,
    adjusted_win_rate_sample_count: adjusted.length,
    last_deployed_at: deploys.length > 0 ? deploys[deploys.length - 1].closed_at : null,
    last_outcome:
      deploys.length > 0
        ? (deploys[deploys.length - 1].pnl_pct ?? 0) >= 0
          ? "profit"
          : "loss"
        : null,
    cooldown_until: pool.cooldown_until || null,
    cooldown_reason: pool.cooldown_reason || null,
    base_mint_cooldown_until: pool.base_mint_cooldown_until || null,
    base_mint_cooldown_reason: pool.base_mint_cooldown_reason || null,
    notes,
    history: deploys.slice(-10).map((d) => ({
      deployed_at: d.deployed_at,
      closed_at: d.closed_at || new Date().toISOString(),
      pnl_pct: d.pnl_pct,
      pnl_usd: d.pnl_usd,
      range_efficiency: d.range_efficiency,
      minutes_held: d.minutes_held,
      close_reason: d.close_reason,
      strategy: d.strategy,
      volatility_at_deploy: d.volatility_at_deploy,
    })),
  };
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export function recallForPool(poolAddress: string): string | null {
  if (!poolAddress) return null;

  const pool = getDb().get<PoolRow>("SELECT * FROM pools WHERE address = ?", poolAddress);
  if (!pool) return null;

  const deploys = getDb().query<PoolDeployRow>(
    "SELECT * FROM pool_deploys WHERE pool_address = ? ORDER BY closed_at",
    poolAddress
  );

  const noteEvents = getDb().query<PoolNoteRow>(
    "SELECT * FROM position_events WHERE position_address = ? AND event_type = 'pool_note' ORDER BY ts",
    poolAddress
  );

  // Parse notes from JSON
  const notes: { note: string; added_at: string }[] = [];
  for (const event of noteEvents) {
    const data = JSON.parse(event.data_json || "{}") as { note?: string; added_at?: string };
    if (data.note) {
      notes.push({ note: data.note, added_at: data.added_at || event.ts });
    }
  }

  const snapshots = getPoolSnapshots(poolAddress);

  const lines: string[] = [];

  // Deploy history summary
  if (pool.total_deploys > 0) {
    lines.push(
      `POOL MEMORY [${pool.name}]: ${pool.total_deploys} past deploy(s), avg PnL ${pool.avg_pnl_pct}%, win rate ${pool.win_rate}%, last outcome: ${
        deploys.length > 0
          ? (deploys[deploys.length - 1].pnl_pct ?? 0) >= 0
            ? "profit"
            : "loss"
          : "unknown"
      }`
    );
  }

  if (pool.cooldown_until && new Date(pool.cooldown_until) > new Date()) {
    lines.push(
      `POOL COOLDOWN: active until ${pool.cooldown_until}${
        pool.cooldown_reason ? ` (${pool.cooldown_reason})` : ""
      }`
    );
  }

  if (pool.base_mint_cooldown_until && new Date(pool.base_mint_cooldown_until) > new Date()) {
    lines.push(
      `TOKEN COOLDOWN: active until ${pool.base_mint_cooldown_until}${
        pool.base_mint_cooldown_reason ? ` (${pool.base_mint_cooldown_reason})` : ""
      }`
    );
  }

  // Recent snapshot trend (last 6 = ~30min)
  const snaps = snapshots.slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend =
      last.pnl_pct != null && first.pnl_pct != null
        ? (last.pnl_pct - first.pnl_pct).toFixed(2)
        : null;
    const oorCount = snaps.filter((s) => s.in_range === false).length;
    lines.push(
      `RECENT TREND: PnL drift ${
        pnlTrend !== null ? `${(parseFloat(pnlTrend) >= 0 ? "+" : "") + pnlTrend}%` : "unknown"
      } over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`
    );
  }

  // Notes
  if (notes.length > 0) {
    const lastNote = notes[notes.length - 1];
    const safeNote = sanitizeStoredNote(lastNote.note);
    if (safeNote) lines.push(`NOTE: ${safeNote}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({
  pool_address,
  note,
}: {
  pool_address: string;
  note: string;
}): PoolNoteResult {
  if (!pool_address)
    return { error: "pool_address required", saved: false, pool_address: "", note: "" };
  const safeNote = sanitizeStoredNote(note);
  if (!safeNote) return { error: "note required", saved: false, pool_address, note: "" };

  getDb().transaction(() => {
    // Ensure pool exists
    getOrCreatePool(pool_address);

    // Insert note as position event
    getDb().run(
      `INSERT INTO position_events (position_address, event_type, ts, data_json) VALUES (?, ?, datetime('now'), ?)`,
      pool_address,
      "pool_note",
      getDb().stringifyJson({ note: safeNote, added_at: new Date().toISOString() })
    );

    // Dual-write to JSON if enabled
    if (DUAL_WRITE_TO_JSON) {
      const jsonDb = loadJson();
      if (!jsonDb[pool_address]) {
        jsonDb[pool_address] = {
          name: pool_address.slice(0, 8),
          base_mint: null,
          deploys: [],
          total_deploys: 0,
          avg_pnl_pct: 0,
          win_rate: 0,
          adjusted_win_rate: 0,
          adjusted_win_rate_sample_count: 0,
          last_deployed_at: null,
          last_outcome: null,
          notes: [],
        };
      }
      jsonDb[pool_address].notes.push({
        note: safeNote,
        added_at: new Date().toISOString(),
      });
      saveJson(jsonDb);
    }
  });

  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${safeNote}`);
  return { saved: true, pool_address, note: safeNote };
}

// Tool registrations
registerTool({
  name: "get_pool_memory",
  handler: getPoolMemory,
  roles: ["SCREENER", "GENERAL"],
});

registerTool({
  name: "add_pool_note",
  handler: addPoolNote,
  roles: ["GENERAL"],
});
