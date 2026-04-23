/**
 * Agent learning system - SQLite implementation.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import { registerTool } from "../../tools/registry.js";
import { config } from "../config/config.js";
import { getInfrastructure } from "../di-container.js";
import { log } from "../infrastructure/logger.js";

// Lazy accessor to infrastructure (breaks circular deps, enables testing)
const infra = () => getInfrastructure();
const getDb = () => infra().db;

// Phase 2: event-driven hive push — lazy import avoids top-level cycle
// (sync.ts → lessons.ts → hive-mind → sync.ts). The functions are only
// resolved when actually called, by which time both modules are fully loaded.
const hivePush = {
  get lesson() {
    return import("../infrastructure/hive-mind.js").then((m) => m.pushLesson);
  },
  get performance() {
    return import("../infrastructure/hive-mind.js").then((m) => m.pushPerformance);
  },
};

import type {
  LessonContext,
  LessonEntry,
  LessonOutcome,
  ListedLesson,
  ListLessonsOptions,
  ListLessonsResult,
  PerformanceHistoryResult,
  PerformanceMetrics,
  PerformanceRecord,
  PositionPerformance,
  RoleTags,
} from "../types/lessons.js";
import { runThresholdEvolution } from "./threshold-evolution.js";

const MAX_MANUAL_LESSON_LENGTH = 400;

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS: RoleTags = {
  SCREENER: [
    "screening",
    "narrative",
    "strategy",
    "deployment",
    "token",
    "volume",
    "entry",
    "bundler",
    "holders",
    "organic",
  ],
  MANAGER: [
    "management",
    "risk",
    "oor",
    "fees",
    "position",
    "hold",
    "close",
    "pnl",
    "rebalance",
    "claim",
  ],
  GENERAL: [], // all lessons
};

function sanitizeLessonText(
  text: string | null | undefined,
  maxLen = MAX_MANUAL_LESSON_LENGTH
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

// ─── Database Row Types ───────────────────────────────────────

interface LessonRow {
  id: number;
  rule: string;
  tags: string; // JSON
  outcome: string;
  context: string | null;
  pool: string | null;
  pnl_pct: number | null;
  range_efficiency: number | null;
  created_at: string;
  pinned: number;
  role: string | null;
  data_json: string | null;
}

interface PerformanceRow {
  id: number;
  position: string;
  pool: string;
  pool_name: string | null;
  strategy: string | null;
  amount_sol: number | null;
  pnl_pct: number | null;
  pnl_usd: number | null;
  fees_earned_usd: number | null;
  initial_value_usd: number | null;
  final_value_usd: number | null;
  minutes_held: number | null;
  minutes_in_range: number | null;
  range_efficiency: number | null;
  close_reason: string | null;
  base_mint: string | null;
  bin_step: number | null;
  volatility: number | null;
  fee_tvl_ratio: number | null;
  organic_score: number | null;
  bin_range: string | null; // JSON
  recorded_at: string;
  data_json: string | null;
}

// ─── Row Mappers ──────────────────────────────────────────────

function lessonFromRow(row: LessonRow): LessonEntry {
  return {
    id: row.id,
    rule: row.rule,
    tags: getDb().parseJson<string[]>(row.tags) ?? [],
    outcome: row.outcome as LessonOutcome,
    context: row.context ?? undefined,
    pool: row.pool ?? undefined,
    pnl_pct: row.pnl_pct ?? undefined,
    range_efficiency: row.range_efficiency ?? undefined,
    created_at: row.created_at,
    pinned: Boolean(row.pinned),
    role: (row.role as "SCREENER" | "MANAGER" | "GENERAL") || null,
  };
}

function performanceFromRow(row: PerformanceRow): PerformanceRecord {
  const data = row.data_json ? getDb().parseJson<Record<string, unknown>>(row.data_json) : {};
  return {
    position: row.position,
    pool: row.pool,
    pool_name: row.pool_name ?? "",
    strategy: row.strategy ?? "",
    bin_range:
      getDb().parseJson(row.bin_range) ??
      (data?.bin_range as
        | number
        | { min?: number; max?: number; bins_below?: number; bins_above?: number }) ??
      0,
    bin_step: row.bin_step ?? (data?.bin_step as number | undefined) ?? undefined,
    volatility: row.volatility ?? (data?.volatility as number | undefined) ?? undefined,
    fee_tvl_ratio: row.fee_tvl_ratio ?? (data?.fee_tvl_ratio as number | undefined) ?? undefined,
    organic_score: row.organic_score ?? (data?.organic_score as number | undefined) ?? undefined,
    amount_sol: row.amount_sol ?? 0,
    fees_earned_usd: row.fees_earned_usd ?? 0,
    final_value_usd: row.final_value_usd ?? 0,
    initial_value_usd: row.initial_value_usd ?? 0,
    minutes_in_range: row.minutes_in_range ?? 0,
    minutes_held: row.minutes_held ?? 0,
    close_reason: row.close_reason ?? "",
    base_mint: row.base_mint ?? (data?.base_mint as string | undefined) ?? undefined,
    deployed_at: data?.deployed_at as string | undefined,
    pnl_usd: row.pnl_usd ?? 0,
    pnl_pct: row.pnl_pct ?? 0,
    range_efficiency: row.range_efficiency ?? 0,
    recorded_at: row.recorded_at,
  };
}

// ─── Record Position Performance ────────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 */
export async function recordPerformance(perf: PositionPerformance): Promise<void> {
  // Guard against unit-mixed records where a SOL-sized final value is
  // accidentally written into a USD field (e.g. final_value_usd = 2 for a 2 SOL close).
  const suspiciousUnitMix =
    Number.isFinite(perf.initial_value_usd) &&
    Number.isFinite(perf.final_value_usd) &&
    Number.isFinite(perf.amount_sol) &&
    perf.initial_value_usd >= 20 &&
    perf.amount_sol >= 0.25 &&
    perf.final_value_usd > 0 &&
    perf.final_value_usd <= perf.amount_sol * 2;

  if (suspiciousUnitMix) {
    log(
      "lessons_warn",
      `Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`
    );
    return;
  }

  const pnl_usd = perf.final_value_usd + perf.fees_earned_usd - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0 ? (pnl_usd / perf.initial_value_usd) * 100 : 0;
  const range_efficiency =
    perf.minutes_held > 0 ? (perf.minutes_in_range / perf.minutes_held) * 100 : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    perf.initial_value_usd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

  if (suspiciousAbsurdClosedPnl) {
    log(
      "lessons_warn",
      `Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`
    );
    return;
  }

  const entry: PerformanceRecord = {
    ...perf,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  // Derive lesson before transaction
  const lesson = derivLesson(entry);

  getDb().transaction(() => {
    // Insert performance record
    getDb().run(
      `INSERT INTO performance (position, pool, pool_name, strategy, amount_sol, pnl_pct, pnl_usd,
        fees_earned_usd, initial_value_usd, final_value_usd, minutes_held, minutes_in_range,
        range_efficiency, close_reason, base_mint, bin_step, volatility, fee_tvl_ratio,
        organic_score, bin_range, recorded_at, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.position,
      entry.pool,
      entry.pool_name,
      entry.strategy,
      entry.amount_sol,
      entry.pnl_pct,
      entry.pnl_usd,
      entry.fees_earned_usd,
      entry.initial_value_usd,
      entry.final_value_usd,
      entry.minutes_held,
      entry.minutes_in_range,
      entry.range_efficiency,
      entry.close_reason,
      entry.base_mint ?? null,
      entry.bin_step ?? null,
      entry.volatility ?? null,
      entry.fee_tvl_ratio ?? null,
      entry.organic_score ?? null,
      getDb().stringifyJson(entry.bin_range),
      entry.recorded_at,
      getDb().stringifyJson(entry)
    );

    // Insert lesson if derived
    if (lesson) {
      getDb().run(
        `INSERT INTO lessons (id, rule, tags, outcome, context, pool, pnl_pct, range_efficiency, created_at, pinned, role, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        lesson.id,
        lesson.rule,
        getDb().stringifyJson(lesson.tags),
        lesson.outcome,
        lesson.context ?? null,
        lesson.pool ?? null,
        lesson.pnl_pct ?? null,
        lesson.range_efficiency ?? null,
        lesson.created_at,
        lesson.pinned ? 1 : 0,
        lesson.role ?? null,
        getDb().stringifyJson(lesson)
      );
      log("lessons", `New lesson: ${lesson.rule}`);
    }
  });

  // Phase 2: event-driven hive pushes — fire-and-forget, fail-open.
  // Pushed immediately at the narrowest event point (after DB commit)
  // so the hive receives data without waiting for the next batch sync.
  const hiveAgentId = process.env.HIVE_MIND_AGENT_ID || "";
  hivePush.performance
    .then((fn) =>
      fn({
        agentId: hiveAgentId,
        poolAddress: entry.pool,
        pnlPct: entry.pnl_pct,
        pnlUsd: entry.pnl_usd,
        holdTimeMinutes: entry.minutes_held,
        closeReason: entry.close_reason ?? "",
        rangeEfficiency: entry.range_efficiency,
        strategy: entry.strategy || undefined,
      })
    )
    .catch(() => {}); // fail-open: never block recordPerformance

  if (lesson) {
    hivePush.lesson
      .then((fn) =>
        fn({
          agentId: hiveAgentId,
          rule: lesson.rule,
          tags: lesson.tags,
          outcome: lesson.outcome,
          context: lesson.context,
        })
      )
      .catch(() => {}); // fail-open
  }

  // Run threshold evolution (pool memory, Darwin weights, hive sync)
  // Get all performance for evolution calculation
  const allPerformance = getDb()
    .query<PerformanceRow>("SELECT * FROM performance ORDER BY recorded_at")
    .map(performanceFromRow);
  await runThresholdEvolution(perf, allPerformance);

  // Portfolio sync: update pool portfolio data after position close (opt-in, fail-open)
  if (config.portfolioSync.enabled) {
    import("./portfolio-sync.js")
      .then(async (m) => {
        const { getWallet } = await import("../utils/wallet.js");
        const walletAddress = getWallet().publicKey.toString();
        await m.syncPoolPortfolio(walletAddress, perf.pool);
      })
      .catch((err) => {
        log("portfolio_sync_warn", `Failed to sync portfolio on position close: ${err}`);
      });
  }
}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 */
function derivLesson(perf: PerformanceRecord): LessonEntry | null {
  const tags: string[] = [];

  // Categorize outcome
  const outcome: LessonOutcome =
    perf.pnl_pct >= 5
      ? "good"
      : perf.pnl_pct >= 0
        ? "neutral"
        : perf.pnl_pct >= -5
          ? "poor"
          : "bad";

  if (outcome === "neutral") return null; // nothing interesting to learn

  // Build context description
  const context = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === "object" ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
  ].join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility || 0)}`);
    } else if (perf.range_efficiency > 80 && outcome === "good") {
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    context,
    pnl_pct: perf.pnl_pct,
    range_efficiency: perf.range_efficiency,
    pool: perf.pool,
    created_at: new Date().toISOString(),
  };
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 */
export function addLesson(
  rule: string,
  tags: string[] = [],
  {
    pinned = false,
    role = null,
  }: { pinned?: boolean; role?: "SCREENER" | "MANAGER" | "GENERAL" | null } = {}
): void {
  const safeRule = sanitizeLessonText(rule);
  if (!safeRule) return;

  const id = Date.now();
  const created_at = new Date().toISOString();
  const lesson: LessonEntry = {
    id,
    rule: safeRule,
    tags,
    outcome: "manual",
    pinned: !!pinned,
    role: role || null,
    created_at,
  };

  getDb().run(
    `INSERT INTO lessons (id, rule, tags, outcome, created_at, pinned, role, data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    safeRule,
    getDb().stringifyJson(tags),
    "manual",
    created_at,
    pinned ? 1 : 0,
    role ?? null,
    getDb().stringifyJson(lesson)
  );

  log(
    "lessons",
    `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${safeRule}`
  );

  // Phase 2: event-driven hive push for manual lesson — fire-and-forget, fail-open
  hivePush.lesson
    .then((fn) =>
      fn({
        agentId: process.env.HIVE_MIND_AGENT_ID || "",
        rule: safeRule,
        tags,
        outcome: "manual",
      })
    )
    .catch(() => {}); // fail-open: never block addLesson
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id: number): {
  found: boolean;
  pinned?: boolean;
  id?: number;
  rule?: string;
} {
  const row = getDb().get<LessonRow>("SELECT * FROM lessons WHERE id = ?", id);
  if (!row) return { found: false };

  getDb().run("UPDATE lessons SET pinned = 1 WHERE id = ?", id);
  log("lessons", `Pinned lesson ${id}: ${row.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: row.rule };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id: number): {
  found: boolean;
  pinned?: boolean;
  id?: number;
  rule?: string;
} {
  const row = getDb().get<LessonRow>("SELECT * FROM lessons WHERE id = ?", id);
  if (!row) return { found: false };

  getDb().run("UPDATE lessons SET pinned = 0 WHERE id = ?", id);
  return { found: true, pinned: false, id, rule: row.rule };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export function listLessons({
  role = null,
  pinned = null,
  tag = null,
  limit = 30,
}: ListLessonsOptions = {}): ListLessonsResult {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (pinned !== null) {
    conditions.push("pinned = ?");
    params.push(pinned ? 1 : 0);
  }

  if (role) {
    conditions.push("(role IS NULL OR role = ?)");
    params.push(role);
  }

  if (tag) {
    conditions.push("tags LIKE ?");
    params.push(`%"${tag}"%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Get total count
  const countRow = getDb().get<{ count: number }>(
    `SELECT COUNT(*) as count FROM lessons ${whereClause}`,
    ...params
  );
  const total = countRow?.count ?? 0;

  // Get lessons with limit (most recent first)
  const rows = getDb().query<LessonRow>(
    `SELECT * FROM lessons ${whereClause} ORDER BY created_at DESC LIMIT ?`,
    ...params,
    limit
  );

  const lessons: ListedLesson[] = rows.map((row) => ({
    id: row.id,
    rule: row.rule.slice(0, 120),
    tags: getDb().parseJson<string[]>(row.tags) ?? [],
    outcome: row.outcome as LessonOutcome,
    pinned: Boolean(row.pinned),
    role: (row.role as "SCREENER" | "MANAGER" | "GENERAL") || "all",
    created_at: row.created_at?.slice(0, 10) || "unknown",
  }));

  return { total, lessons };
}

/**
 * Remove a lesson by ID.
 */
export function removeLesson(id: number): number {
  const result = getDb().run("DELETE FROM lessons WHERE id = ?", id);
  return result.changes;
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword: string): number {
  const result = getDb().run("DELETE FROM lessons WHERE LOWER(rule) LIKE LOWER(?)", `%${keyword}%`);
  return result.changes;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons(): number {
  const result = getDb().run("DELETE FROM lessons");
  return result.changes;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance(): number {
  const result = getDb().run("DELETE FROM performance");
  return result.changes;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 */
export function getLessonsForPrompt(opts: LessonContext | number = {}): string | null {
  // Support legacy call signature: getLessonsForPrompt(20)
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;

  // Check if any lessons exist
  const countRow = getDb().get<{ count: number }>("SELECT COUNT(*) as count FROM lessons");
  if (!countRow || countRow.count === 0) return null;

  // Smaller caps for automated cycles — they don't need the full lesson history
  const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
  const PINNED_CAP = isAutoCycle ? 5 : 10;
  const ROLE_CAP = isAutoCycle ? 6 : 15;
  const RECENT_CAP = maxLessons ?? (isAutoCycle ? 10 : 35);

  const outcomePriority: Record<string, number> = {
    bad: 0,
    poor: 1,
    failed: 1,
    good: 2,
    worked: 2,
    manual: 1,
    neutral: 3,
    evolution: 2,
  };
  const byPriority = (a: LessonEntry, b: LessonEntry) =>
    (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  // Load all lessons for filtering (dataset is small, typically < 1000)
  const allRows = getDb().query<LessonRow>("SELECT * FROM lessons");
  const allLessons = allRows.map(lessonFromRow);

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = allLessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = allLessons
    .filter((l) => {
      if (usedIds.has(l.id)) return false;
      // Include if: lesson has no role restriction OR matches this role
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      // Include if: lesson has role-relevant tags OR no tags (general)
      const tagOk =
        roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
      return roleOk && tagOk;
    })
    .sort(byPriority)
    .slice(0, ROLE_CAP);

  for (const l of roleMatched) usedIds.add(l.id);

  // ── Tier 3: Recent fill ─────────────────────────────────────────
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent =
    remainingBudget > 0
      ? allLessons
          .filter((l) => !usedIds.has(l.id))
          .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
          .slice(0, remainingBudget)
      : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  if (selected.length === 0) return null;

  const sections: string[] = [];
  if (pinned.length) sections.push(`── PINNED (${pinned.length}) ──\n${fmt(pinned)}`);
  if (roleMatched.length)
    sections.push(`── ${agentType} (${roleMatched.length}) ──\n${fmt(roleMatched)}`);
  if (recent.length) sections.push(`── RECENT (${recent.length}) ──\n${fmt(recent)}`);

  return sections.join("\n\n");
}

function fmt(lessons: LessonEntry[]): string {
  return lessons
    .map((l) => {
      const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
      const pin = l.pinned ? "📌 " : "";
      return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
    })
    .join("\n");
}

/**
 * Get individual performance records filtered by time window.
 * Tool handler: get_performance_history
 */
export function getPerformanceHistory({
  hours = 24,
  limit = 50,
}: {
  hours?: number;
  limit?: number;
} = {}): PerformanceHistoryResult {
  const countRow = getDb().get<{ count: number }>("SELECT COUNT(*) as count FROM performance");
  const totalCount = countRow?.count ?? 0;

  if (totalCount === 0) {
    return { positions: [], count: 0, hours, total_pnl_usd: 0, win_rate_pct: null };
  }

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const rows = getDb().query<PerformanceRow>(
    `SELECT * FROM performance WHERE recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?`,
    cutoff,
    limit
  );

  const positions = rows.map((r) => ({
    pool_name: r.pool_name ?? "",
    pool: r.pool,
    strategy: r.strategy ?? "",
    pnl_usd: r.pnl_usd ?? 0,
    pnl_pct: r.pnl_pct ?? 0,
    fees_earned_usd: r.fees_earned_usd ?? 0,
    range_efficiency: r.range_efficiency ?? 0,
    minutes_held: r.minutes_held ?? 0,
    close_reason: r.close_reason ?? "",
    closed_at: r.recorded_at,
  }));

  const totalPnl = positions.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = positions.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: positions.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: positions.length > 0 ? Math.round((wins / positions.length) * 100) : null,
    positions,
  };
}

/**
 * Get performance stats summary.
 */
export function getPerformanceSummary(): PerformanceMetrics | null {
  const perfCountRow = getDb().get<{ count: number }>("SELECT COUNT(*) as count FROM performance");
  const perfCount = perfCountRow?.count ?? 0;

  if (perfCount === 0) return null;

  const aggRow = getDb().get<{
    total_pnl_usd: number;
    avg_pnl_pct: number;
    avg_range_efficiency: number;
    wins: number;
  }>(
    `SELECT
      COALESCE(SUM(pnl_usd), 0) as total_pnl_usd,
      COALESCE(AVG(pnl_pct), 0) as avg_pnl_pct,
      COALESCE(AVG(range_efficiency), 0) as avg_range_efficiency,
      SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins
    FROM performance`
  );

  const lessonsCountRow = getDb().get<{ count: number }>("SELECT COUNT(*) as count FROM lessons");

  return {
    total_positions_closed: perfCount,
    total_pnl_usd: Math.round((aggRow?.total_pnl_usd ?? 0) * 100) / 100,
    avg_pnl_pct: Math.round((aggRow?.avg_pnl_pct ?? 0) * 100) / 100,
    avg_range_efficiency_pct: Math.round((aggRow?.avg_range_efficiency ?? 0) * 10) / 10,
    win_rate_pct: perfCount > 0 ? Math.round(((aggRow?.wins ?? 0) / perfCount) * 100) : 0,
    total_lessons: lessonsCountRow?.count ?? 0,
  };
}

/**
 * Search lessons by keyword in rule text (full-text search).
 */
export function searchLessons(keyword: string, limit = 20): ListedLesson[] {
  const rows = getDb().query<LessonRow>(
    `SELECT * FROM lessons WHERE rule LIKE ? ORDER BY created_at DESC LIMIT ?`,
    `%${keyword}%`,
    limit
  );

  return rows.map((row) => ({
    id: row.id,
    rule: row.rule.slice(0, 120),
    tags: getDb().parseJson<string[]>(row.tags) ?? [],
    outcome: row.outcome as LessonOutcome,
    pinned: Boolean(row.pinned),
    role: (row.role as "SCREENER" | "MANAGER" | "GENERAL") || "all",
    created_at: row.created_at?.slice(0, 10) || "unknown",
  }));
}

// Tool registrations
registerTool({
  name: "add_lesson",
  handler: (args: unknown) => {
    const { rule, tags, pinned, role } = args as {
      rule: string;
      tags?: string[];
      pinned?: boolean;
      role?: "SCREENER" | "MANAGER" | "GENERAL";
    };
    addLesson(rule, tags || [], {
      pinned: !!pinned,
      role: role || null,
    });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  roles: ["GENERAL"],
});

registerTool({
  name: "pin_lesson",
  handler: (args: unknown) => {
    const { id } = args as { id: number | string };
    return pinLesson(Number(id));
  },
  roles: ["GENERAL"],
});

registerTool({
  name: "unpin_lesson",
  handler: (args: unknown) => {
    const { id } = args as { id: number | string };
    return unpinLesson(Number(id));
  },
  roles: ["GENERAL"],
});

registerTool({
  name: "list_lessons",
  handler: (args: unknown) => {
    const { role, pinned, tag, limit } =
      (args as { role?: string; pinned?: boolean; tag?: string; limit?: number }) || {};
    return listLessons({
      role: role as "SCREENER" | "MANAGER" | "GENERAL" | undefined,
      pinned,
      tag,
      limit: limit ? Number(limit) : undefined,
    });
  },
  roles: ["GENERAL"],
});

registerTool({
  name: "clear_lessons",
  handler: (args: unknown) => {
    const { mode, keyword } = args as { mode?: string; keyword?: string };
    if (mode === "all") {
      const n = clearAllLessons();
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  roles: ["GENERAL"],
});

registerTool({
  name: "get_performance_history",
  handler: getPerformanceHistory,
  roles: ["GENERAL"],
});

registerTool({
  name: "search_lessons",
  handler: (args: unknown) => {
    const { keyword, limit } = args as { keyword: string; limit?: number };
    if (!keyword) return { error: "keyword required" };
    return { lessons: searchLessons(keyword, limit ?? 20) };
  },
  roles: ["GENERAL"],
});
