/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import fs from "fs";
import { registerTool } from "../../tools/registry.js";
import { LESSONS_FILE } from "../config/paths.js";
import { log } from "../infrastructure/logger.js";
import type {
  LessonContext,
  LessonEntry,
  LessonOutcome,
  LessonsData,
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

function load(): LessonsData {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  } catch {
    return { lessons: [], performance: [] };
  }
}

function save(data: LessonsData): void {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 */
export async function recordPerformance(perf: PositionPerformance): Promise<void> {
  const data = load();

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

  data.performance.push(entry);

  // Derive and store a lesson
  const lesson = derivLesson(entry);
  if (lesson) {
    data.lessons.push(lesson);
    log("lessons", `New lesson: ${lesson.rule}`);
  }

  save(data);

  // Run threshold evolution (pool memory, Darwin weights, hive sync)
  await runThresholdEvolution(perf, data.performance);
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
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: safeRule,
    tags,
    outcome: "manual",
    pinned: !!pinned,
    role: role || null,
    created_at: new Date().toISOString(),
  });
  save(data);
  log(
    "lessons",
    `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${safeRule}`
  );
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
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
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
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
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
  const data = load();
  let lessons: LessonEntry[] = [...data.lessons];

  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role) lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag) lessons = lessons.filter((l) => l.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map(
      (l): ListedLesson => ({
        id: l.id,
        rule: l.rule.slice(0, 120),
        tags: l.tags,
        outcome: l.outcome,
        pinned: !!l.pinned,
        role: l.role || "all",
        created_at: l.created_at?.slice(0, 10) || "unknown",
      })
    ),
  };
}

/**
 * Remove a lesson by ID.
 */
export function removeLesson(id: number): number {
  const data = load();
  const before = data.lessons.length;
  data.lessons = data.lessons.filter((l) => l.id !== id);
  save(data);
  return before - data.lessons.length;
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword: string): number {
  const data = load();
  const before = data.lessons.length;
  const kw = keyword.toLowerCase();
  data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  save(data);
  return before - data.lessons.length;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons(): number {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance(): number {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

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

  const data = load();
  if (data.lessons.length === 0) return null;

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

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = data.lessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = data.lessons
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

  roleMatched.forEach((l) => usedIds.add(l.id));

  // ── Tier 3: Recent fill ─────────────────────────────────────────
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent =
    remainingBudget > 0
      ? data.lessons
          .filter((l) => !usedIds.has(l.id))
          .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
          .slice(0, remainingBudget)
      : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  if (selected.length === 0) return null;

  const sections: string[] = [];
  if (pinned.length) sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length)
    sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length) sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));

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
  const data = load();
  const p = data.performance;

  if (p.length === 0)
    return { positions: [], count: 0, hours, total_pnl_usd: 0, win_rate_pct: null };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at >= cutoff)
    .slice(-limit)
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

/**
 * Get performance stats summary.
 */
export function getPerformanceSummary(): PerformanceMetrics | null {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + x.pnl_usd, 0);
  const avgPnlPct = p.reduce((s, x) => s + x.pnl_pct, 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + x.range_efficiency, 0) / p.length;
  const wins = p.filter((x) => x.pnl_usd > 0).length;

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100),
    total_lessons: data.lessons.length,
  };
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
