/**
 * Portfolio Sync — Fetches historical portfolio data from Meteora API
 * and generates cross-machine learning lessons.
 *
 * This feature is opt-in via config.portfolioSync.enabled.
 * When disabled, zero change to current behavior.
 *
 * Flow:
 *   1. On startup (if enabled + few lessons): bootstrapFromPortfolio()
 *   2. After position close (if enabled): syncPoolPortfolio()
 *   3. Background refresh on interval (if enabled): via orchestrator cron
 */

import { config } from "../config/config.js";
import { get, query, run, stringifyJson, transaction } from "../infrastructure/db.js";
import { log } from "../infrastructure/logger.js";
import type { PortfolioSyncConfig } from "../types/config.js";
import type { LessonEntry, LessonOutcome } from "../types/lessons.js";

// ─── Types ───────────────────────────────────────────────────────

export interface MeteoraPortfolioItem {
  poolAddress: string;
  binStep: string;
  baseFee: string;
  tokenXMint: string;
  tokenYMint: string;
  tokenX: string;
  tokenY: string;
  tokenXIcon: string;
  tokenYIcon: string;
  totalDeposit: string;
  totalDepositSol: string;
  totalWithdrawal: string;
  totalWithdrawalSol: string;
  totalFee: string;
  totalFeeSol: string;
  pnlUsd: string;
  pnlSol: string;
  pnlPctChange: string;
  pnlSolPctChange: string;
  lastClosedAt: number | null;
  tokenBreakdown?: unknown;
}

interface PortfolioHistoryRow {
  id: number;
  wallet_address: string;
  pool_address: string;
  pool_name: string | null;
  token_x_mint: string | null;
  token_y_mint: string | null;
  token_x_symbol: string | null;
  token_y_symbol: string | null;
  bin_step: number | null;
  base_fee: number | null;
  total_deposit_usd: number | null;
  total_deposit_sol: number | null;
  total_withdrawal_usd: number | null;
  total_withdrawal_sol: number | null;
  total_fee_usd: number | null;
  total_fee_sol: number | null;
  pnl_usd: number | null;
  pnl_sol: number | null;
  pnl_pct_change: number | null;
  pnl_sol_pct_change: number | null;
  token_breakdown_json: string | null;
  last_closed_at: number | null;
  total_positions_count: number | null;
  days_back: number | null;
  fetched_at: string;
  first_seen_at: string | null;
  fee_efficiency_annualized: number | null;
  capital_rotation_ratio: number | null;
  data_freshness_hours: number | null;
  our_positions_count: number;
  our_total_pnl_pct: number | null;
  outperformance_delta: number | null;
  is_active_pool: number;
  lesson_generated: number;
}

// ─── Feature Flag Check ──────────────────────────────────────────

/**
 * Check if portfolio sync is enabled via config.
 */
export function shouldUsePortfolioSync(): boolean {
  return config.portfolioSync.enabled;
}

// ─── Meteora API ─────────────────────────────────────────────────

const METEORA_PORTFOLIO_URL = "https://app.meteora.ag/api/v1/portfolio";

/**
 * Fetch portfolio data from Meteora API for a given wallet.
 *
 * @param wallet - Solana wallet address (base58)
 * @param daysBack - How many days back to fetch
 * @returns Array of portfolio items
 */
export async function fetchMeteoraPortfolio(
  wallet: string,
  daysBack: number
): Promise<MeteoraPortfolioItem[]> {
  const url = `${METEORA_PORTFOLIO_URL}/${wallet}?daysBack=${daysBack}`;

  log("portfolio_sync", `Fetching portfolio for ${wallet.slice(0, 8)}... (${daysBack} days back)`);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000), // 30s timeout
  });

  if (!response.ok) {
    throw new Error(`Meteora portfolio API returned ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as { data?: MeteoraPortfolioItem[] };

  if (!Array.isArray(data?.data)) {
    log("portfolio_sync_warn", "Meteora API returned non-array data");
    return [];
  }

  log("portfolio_sync", `Fetched ${data.data.length} portfolio items`);
  return data.data;
}

// ─── Database Storage ────────────────────────────────────────────

/**
 * Store a single portfolio snapshot in the database.
 * Uses INSERT OR REPLACE to handle re-fetches.
 */
export async function storePortfolioSnapshot(
  wallet: string,
  pool: MeteoraPortfolioItem,
  daysBack: number
): Promise<void> {
  const now = new Date().toISOString();
  const fetchedDate = now.split("T")[0]; // YYYY-MM-DD for uniqueness

  // Parse numeric fields safely
  const parseNum = (v: string | undefined | null): number | null => {
    if (v == null) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  // Compute derived fields
  const totalDeposit = parseNum(pool.totalDeposit) ?? 0;
  const totalWithdrawal = parseNum(pool.totalWithdrawal) ?? 0;
  const totalFee = parseNum(pool.totalFee) ?? 0;
  const pnlUsd = parseNum(pool.pnlUsd) ?? 0;
  const capitalRotationRatio = totalDeposit > 0 ? totalWithdrawal / totalDeposit : null;
  const feeEfficiencyAnnualized =
    totalDeposit > 0 && totalFee > 0 ? (totalFee / totalDeposit) * (365 / daysBack) * 100 : null;

  // Check if we already have a record for this pool+wallet to preserve first_seen_at
  const existing = get<{ first_seen_at: string }>(
    `SELECT first_seen_at FROM portfolio_history
     WHERE wallet_address = ? AND pool_address = ?
     ORDER BY fetched_at DESC LIMIT 1`,
    wallet,
    pool.poolAddress
  );

  const firstSeenAt = existing?.first_seen_at ?? now;

  // Check if we have our own positions for this pool
  const ourPerf = get<{ count: number; avg_pnl: number }>(
    `SELECT COUNT(*) as count, AVG(pnl_pct) as avg_pnl
     FROM performance WHERE pool = ?`,
    pool.poolAddress
  );
  const ourPositionsCount = ourPerf?.count ?? 0;
  const ourTotalPnlPct = ourPerf?.avg_pnl ?? null;

  // Calculate outperformance
  const poolPnlPct = parseNum(pool.pnlPctChange);
  const outperformanceDelta =
    ourTotalPnlPct != null && poolPnlPct != null ? ourTotalPnlPct - poolPnlPct : null;

  // Check if pool is currently active (has open position_state)
  const activePool = get<{ count: number }>(
    `SELECT COUNT(*) as count FROM position_state WHERE pool = ? AND closed = 0`,
    pool.poolAddress
  );
  const isActivePool = (activePool?.count ?? 0) > 0 ? 1 : 0;

  run(
    `INSERT OR REPLACE INTO portfolio_history (
      wallet_address, pool_address, pool_name,
      token_x_mint, token_y_mint, token_x_symbol, token_y_symbol,
      bin_step, base_fee,
      total_deposit_usd, total_deposit_sol,
      total_withdrawal_usd, total_withdrawal_sol,
      total_fee_usd, total_fee_sol,
      pnl_usd, pnl_sol, pnl_pct_change, pnl_sol_pct_change,
      token_breakdown_json, last_closed_at, total_positions_count, days_back,
      fetched_at, first_seen_at,
      fee_efficiency_annualized, capital_rotation_ratio, data_freshness_hours,
      our_positions_count, our_total_pnl_pct, outperformance_delta,
      is_active_pool, lesson_generated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    wallet,
    pool.poolAddress,
    `${pool.tokenX}/${pool.tokenY}`,
    pool.tokenXMint,
    pool.tokenYMint,
    pool.tokenX,
    pool.tokenY,
    parseNum(pool.binStep),
    parseNum(pool.baseFee),
    totalDeposit,
    parseNum(pool.totalDepositSol),
    totalWithdrawal,
    parseNum(pool.totalWithdrawalSol),
    totalFee,
    parseNum(pool.totalFeeSol),
    pnlUsd,
    parseNum(pool.pnlSol),
    poolPnlPct,
    parseNum(pool.pnlSolPctChange),
    pool.tokenBreakdown ? stringifyJson(pool.tokenBreakdown) : null,
    pool.lastClosedAt,
    null, // total_positions_count — not available from API
    daysBack,
    fetchedDate,
    firstSeenAt,
    feeEfficiencyAnnualized,
    capitalRotationRatio,
    null, // data_freshness_hours — computed on read
    ourPositionsCount,
    ourTotalPnlPct,
    outperformanceDelta,
    isActivePool,
    0 // lesson_generated — will be set by generatePortfolioLessons
  );
}

// ─── Bootstrap & Sync ────────────────────────────────────────────

/**
 * Full sync on startup: fetch all portfolio data and store it.
 * Only called when portfolioSync.enabled is true and lesson count is low.
 */
export async function bootstrapFromPortfolio(
  wallet: string,
  syncConfig: PortfolioSyncConfig
): Promise<void> {
  log(
    "portfolio_sync",
    `Bootstrapping portfolio sync for ${wallet.slice(0, 8)}... (${syncConfig.daysBack} days back)`
  );

  try {
    const items = await fetchMeteoraPortfolio(wallet, syncConfig.daysBack);

    if (items.length === 0) {
      log("portfolio_sync", "No portfolio data returned from Meteora");
      return;
    }

    // Store all snapshots
    for (const item of items) {
      try {
        await storePortfolioSnapshot(wallet, item, syncConfig.daysBack);
      } catch (err) {
        log(
          "portfolio_sync_warn",
          `Failed to store snapshot for pool ${item.poolAddress.slice(0, 8)}...: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    log("portfolio_sync", `Stored ${items.length} portfolio snapshots`);

    // Generate lessons from the data
    const lessons = await generatePortfolioLessons(wallet, syncConfig);
    if (lessons.length > 0) {
      log("portfolio_sync", `Generated ${lessons.length} portfolio-derived lessons`);
    }
  } catch (err) {
    log(
      "portfolio_sync_error",
      `Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`
    );
    // Fail-open: never block startup
  }
}

/**
 * Sync a single pool's portfolio data after a position close.
 * Used to keep portfolio data fresh for pools we interact with.
 */
export async function syncPoolPortfolio(wallet: string, poolAddress: string): Promise<void> {
  const syncConfig = config.portfolioSync;
  if (!syncConfig.enabled) return;

  log("portfolio_sync", `Syncing portfolio for pool ${poolAddress.slice(0, 8)}...`);

  try {
    const items = await fetchMeteoraPortfolio(wallet, syncConfig.daysBack);
    const targetPool = items.find((item) => item.poolAddress === poolAddress);

    if (targetPool) {
      await storePortfolioSnapshot(wallet, targetPool, syncConfig.daysBack);
      log("portfolio_sync", `Updated portfolio snapshot for pool ${poolAddress.slice(0, 8)}...`);
    }
  } catch (err) {
    log(
      "portfolio_sync_warn",
      `Pool sync failed for ${poolAddress.slice(0, 8)}...: ${err instanceof Error ? err.message : String(err)}`
    );
    // Fail-open: never block position close flow
  }
}

// ─── Lesson Generation ───────────────────────────────────────────

/**
 * Generate lessons from portfolio history data.
 * Identifies reliable pools, pools to avoid, and outperformance patterns.
 */
export async function generatePortfolioLessons(
  wallet: string,
  syncConfig: PortfolioSyncConfig
): Promise<LessonEntry[]> {
  const lessons: LessonEntry[] = [];

  try {
    // Generate pool character lessons (reliable pools)
    const charLessons = generatePoolCharacterLessons(wallet, syncConfig);
    lessons.push(...charLessons);

    // Generate avoid lessons
    const avoidLessons = generateAvoidLessons(wallet, syncConfig);
    lessons.push(...avoidLessons);

    // Generate outperformance lessons
    const perfLessons = generateOutperformanceLessons(wallet, syncConfig);
    lessons.push(...perfLessons);

    // Store generated lessons
    if (lessons.length > 0) {
      transaction(() => {
        for (const lesson of lessons) {
          run(
            `INSERT OR IGNORE INTO lessons (id, rule, tags, outcome, context, pool, pnl_pct, range_efficiency, created_at, pinned, role, data_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            lesson.id,
            lesson.rule,
            stringifyJson(lesson.tags),
            lesson.outcome,
            lesson.context ?? null,
            lesson.pool ?? null,
            lesson.pnl_pct ?? null,
            lesson.range_efficiency ?? null,
            lesson.created_at,
            lesson.pinned ? 1 : 0,
            lesson.role ?? null,
            stringifyJson({ source: "portfolio_sync", ...lesson })
          );
        }

        // Mark all portfolio rows as lesson-generated
        run(
          `UPDATE portfolio_history SET lesson_generated = 1 WHERE wallet_address = ? AND lesson_generated = 0`,
          wallet
        );
      });
    }
  } catch (err) {
    log(
      "portfolio_sync_warn",
      `Lesson generation failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return lessons;
}

/**
 * Identify reliable pools from portfolio history — pools where we (or the wallet)
 * have consistently positive results.
 */
function generatePoolCharacterLessons(
  wallet: string,
  syncConfig: PortfolioSyncConfig
): LessonEntry[] {
  const lessons: LessonEntry[] = [];
  const now = new Date().toISOString();

  // Find pools with consistently positive PnL from portfolio history
  const reliablePools = query<PortfolioHistoryRow & { avg_pnl_pct: number; snap_count: number }>(
    `SELECT *, AVG(pnl_pct_change) as avg_pnl_pct, COUNT(*) as snap_count
     FROM portfolio_history
     WHERE wallet_address = ?
       AND pnl_pct_change IS NOT NULL
       AND pnl_pct_change > 0
     GROUP BY pool_address
     HAVING snap_count >= ?
     ORDER BY avg_pnl_pct DESC
     LIMIT 10`,
    wallet,
    syncConfig.minPositionsForLesson
  );

  for (const pool of reliablePools) {
    const avgPnl = pool.avg_pnl_pct.toFixed(1);
    lessons.push({
      id: Date.now() + Math.floor(Math.random() * 10000),
      rule: `Pool ${pool.pool_name || pool.pool_address.slice(0, 8)} has ${pool.snap_count} positive portfolio snapshots with avg PnL +${avgPnl}% — historically reliable`,
      tags: ["portfolio", "pool-character", "reliable", "screening"],
      outcome: "good" as LessonOutcome,
      context: `Cross-machine portfolio data (${syncConfig.daysBack} days): ${pool.snap_count} snapshots`,
      pool: pool.pool_address,
      pnl_pct: pool.avg_pnl_pct,
      created_at: now,
      pinned: false,
      role: "SCREENER",
    });
  }

  return lessons;
}

/**
 * Identify pools to avoid — consistently negative PnL across multiple snapshots.
 */
function generateAvoidLessons(wallet: string, syncConfig: PortfolioSyncConfig): LessonEntry[] {
  const lessons: LessonEntry[] = [];
  const now = new Date().toISOString();

  const avoidPools = query<PortfolioHistoryRow & { avg_pnl_pct: number; snap_count: number }>(
    `SELECT *, AVG(pnl_pct_change) as avg_pnl_pct, COUNT(*) as snap_count
     FROM portfolio_history
     WHERE wallet_address = ?
       AND pnl_pct_change IS NOT NULL
       AND pnl_pct_change < -10
     GROUP BY pool_address
     HAVING snap_count >= ?
     ORDER BY avg_pnl_pct ASC
     LIMIT 10`,
    wallet,
    syncConfig.minPositionsForLesson
  );

  for (const pool of avoidPools) {
    const avgPnl = pool.avg_pnl_pct.toFixed(1);
    lessons.push({
      id: Date.now() + Math.floor(Math.random() * 10000),
      rule: `Pool ${pool.pool_name || pool.pool_address.slice(0, 8)} has ${pool.snap_count} losing portfolio snapshots with avg PnL ${avgPnl}% — avoid deploying here`,
      tags: ["portfolio", "avoid", "risk", "screening"],
      outcome: "bad" as LessonOutcome,
      context: `Cross-machine portfolio data (${syncConfig.daysBack} days): ${pool.snap_count} snapshots all negative`,
      pool: pool.pool_address,
      pnl_pct: pool.avg_pnl_pct,
      created_at: now,
      pinned: false,
      role: "SCREENER",
    });
  }

  return lessons;
}

/**
 * Compare our performance vs portfolio-wide averages to identify outperformance patterns.
 */
function generateOutperformanceLessons(
  wallet: string,
  _syncConfig: PortfolioSyncConfig
): LessonEntry[] {
  const lessons: LessonEntry[] = [];
  const now = new Date().toISOString();

  // Find pools where our performance exceeds the portfolio average
  const outperformers = query<{
    pool_address: string;
    pool_name: string | null;
    our_pnl: number;
    pool_pnl: number;
    delta: number;
  }>(
    `SELECT pool_address, pool_name,
       our_total_pnl_pct as our_pnl,
       pnl_pct_change as pool_pnl,
       outperformance_delta as delta
     FROM portfolio_history
     WHERE wallet_address = ?
       AND outperformance_delta IS NOT NULL
       AND outperformance_delta > 5
       AND our_positions_count >= 2
     ORDER BY outperformance_delta DESC
     LIMIT 5`,
    wallet
  );

  for (const pool of outperformers) {
    lessons.push({
      id: Date.now() + Math.floor(Math.random() * 10000),
      rule: `Outperforming portfolio avg by +${pool.delta.toFixed(1)}% on ${pool.pool_name || pool.pool_address.slice(0, 8)} — our strategy works well here`,
      tags: ["portfolio", "outperformance", "strategy", "management"],
      outcome: "worked" as LessonOutcome,
      context: `Our avg: ${pool.our_pnl.toFixed(1)}% vs portfolio avg: ${pool.pool_pnl.toFixed(1)}%`,
      pool: pool.pool_address,
      pnl_pct: pool.our_pnl,
      created_at: now,
      pinned: false,
      role: "MANAGER",
    });
  }

  return lessons;
}
