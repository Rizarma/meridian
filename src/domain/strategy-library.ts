/**
 * Strategy Library — persistent store of LP strategies.
 *
 * Users paste a tweet or description via Telegram.
 * The agent extracts structured criteria and saves it here.
 * During screening, the active strategy's criteria guide token selection and position config.
 *
 * NOTE: Migrated from JSON to SQLite for data persistence across deployments.
 */

import { registerTool } from "../../tools/registry.js";
import { getInfrastructure } from "../di-container.js";
import { log } from "../infrastructure/logger.js";
import type {
  EntryCriteria,
  ExitCriteria,
  LPStrategyType,
  RangeCriteria,
  Strategy,
  TokenCriteria,
} from "../types/strategy.js";

export const LEGACY_LP_STRATEGIES = ["bid_ask", "spot", "curve", "any", "mixed"] as const;

const infra = () => getInfrastructure();

export function isLegacyLpStrategy(value: string | null | undefined): value is LPStrategyType {
  return !!value && (LEGACY_LP_STRATEGIES as readonly string[]).includes(value);
}

// ═══════════════════════════════════════════════════════════════════════════
// Parameter and Return Types
// ═══════════════════════════════════════════════════════════════════════════

interface AddStrategyParams {
  id: string;
  name: string;
  author?: string;
  lp_strategy?: LPStrategyType;
  token_criteria?: TokenCriteria;
  entry?: EntryCriteria;
  range?: RangeCriteria;
  exit?: ExitCriteria;
  best_for?: string;
  raw?: string;
}

interface AddStrategyResult {
  saved?: boolean;
  id?: string;
  name?: string;
  active?: boolean;
  error?: string;
}

interface StrategySummary {
  id: string;
  name: string;
  author: string;
  lp_strategy: LPStrategyType;
  best_for: string;
  active: boolean;
  added_at?: string;
}

interface ListStrategiesResult {
  active: string | null;
  count: number;
  strategies: StrategySummary[];
}

interface GetStrategyResult extends Partial<Strategy> {
  is_active?: boolean;
  error?: string;
  available?: string[];
}

interface SetActiveStrategyResult {
  active?: string;
  name?: string;
  error?: string;
  available?: string[];
}

interface RemoveStrategyResult {
  removed?: boolean;
  id?: string;
  name?: string;
  new_active?: string | null;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Default Strategies
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_STRATEGIES: Record<string, Strategy> = {
  custom_ratio_spot: {
    id: "custom_ratio_spot",
    name: "Custom Ratio Spot",
    author: "meridian",
    lp_strategy: "spot",
    token_criteria: { notes: "Any token. Ratio expresses directional bias." },
    entry: {
      condition: "Directional view on token",
      single_side: null,
      notes:
        "75% token = bullish (sell on pump out of range). 75% SOL = bearish/DCA-in (buy on dip). Set bins_below:bins_above proportional to ratio.",
    },
    range: {
      type: "custom",
      notes:
        "bins_below:bins_above ratio matches token:SOL ratio. E.g., 75% token → ~52 bins below, ~17 bins above.",
    },
    exit: {
      take_profit_pct: 10,
      notes:
        "Close when OOR or TP hit. Re-deploy with updated ratio based on new momentum signals.",
    },
    best_for: "Expressing directional bias while earning fees both ways",
  },
  single_sided_reseed: {
    id: "single_sided_reseed",
    name: "Single-Sided Bid-Ask + Re-seed",
    author: "meridian",
    lp_strategy: "bid_ask",
    token_criteria: { notes: "Volatile tokens with strong narrative. Must have active volume." },
    entry: {
      condition:
        "Deploy token-only (amount_x only, amount_y=0) bid-ask, bins below active bin only",
      single_side: "token",
      notes:
        "As price drops through bins, token sold for SOL. Bid-ask concentrates at bottom edge.",
    },
    range: {
      type: "default",
      bins_below_pct: 100,
      notes: "All bins below active bin. bins_above=0.",
    },
    exit: {
      notes:
        "When OOR downside: close_position(skip_swap=true) → redeploy token-only bid-ask at new lower price. Do NOT swap to SOL. Full close only when token dead or after N re-seeds with declining performance.",
    },
    best_for: "Riding volatile tokens down without cutting losses. DCA out via LP.",
  },
  fee_compounding: {
    id: "fee_compounding",
    name: "Fee Compounding",
    author: "meridian",
    lp_strategy: "any",
    token_criteria: { notes: "Stable volume pools with consistent fee generation." },
    entry: {
      condition: "Deploy normally with any shape",
      notes: "Strategy is about management, not entry shape.",
    },
    range: { type: "default", notes: "Standard range for the pair." },
    exit: {
      notes:
        "When unclaimed fees > $5 AND in range: claim_fees → add_liquidity back into same position. Normal close rules otherwise.",
    },
    best_for: "Maximizing yield on stable, range-bound pools via compounding",
  },
  multi_layer: {
    id: "multi_layer",
    name: "Multi-Layer",
    author: "meridian",
    lp_strategy: "mixed",
    token_criteria: {
      notes:
        "High volume pools. Layer multiple shapes into ONE position via addLiquidityByStrategy to sculpt a composite distribution.",
    },
    entry: {
      condition:
        "Create ONE position, then layer additional shapes onto it with add-liquidity. Each layer adds a different strategy/shape to the same position, compositing them.",
      notes:
        "Step 1: deploy (creates position with first shape). Step 2+: add-liquidity to same position with different shapes. All layers share the same bin range but different distribution curves stack on top of each other.",
      example_patterns: {
        smooth_edge:
          "Deploy Bid-Ask (edges) → add-liquidity Spot (fills the middle gap). 2 layers, 1 position.",
        full_composite:
          "Deploy Bid-Ask (edges) → add-liquidity Spot (middle) → add-liquidity Curve (center boost). 3 layers, 1 position.",
        edge_heavy:
          "Deploy Bid-Ask → add-liquidity Bid-Ask again (double edge weight). 2 layers, 1 position.",
      },
    },
    range: {
      type: "custom",
      notes:
        "All layers share the position's bin range (set at deploy). Choose range wide enough for the widest layer needed.",
    },
    exit: {
      notes:
        "Single position — one close, one claim. The composite shape means fees earned reflect ALL layers combined.",
    },
    best_for:
      "Creating custom liquidity distributions by stacking shapes in one position. Single position to manage.",
  },
  partial_harvest: {
    id: "partial_harvest",
    name: "Partial Harvest",
    author: "meridian",
    lp_strategy: "any",
    token_criteria: { notes: "High fee pools where taking profit incrementally is preferred." },
    entry: {
      condition: "Deploy normally",
      notes: "Strategy is about progressive profit-taking, not entry.",
    },
    range: { type: "default", notes: "Standard range." },
    exit: {
      take_profit_pct: 10,
      notes:
        "When total return >= 10% of deployed capital: withdraw_liquidity(bps=5000) to take 50% off. Remaining 50% keeps running. Repeat at next threshold.",
    },
    best_for: "Locking in profits without fully exiting winning positions",
  },
};

// Strategies that are documented but not fully implemented
const NON_FUNCTIONAL_STRATEGIES = new Set([
  "partial_harvest",
  "fee_compounding",
  "single_sided_reseed",
]);

// ═══════════════════════════════════════════════════════════════════════════
// Database Helpers
// ═══════════════════════════════════════════════════════════════════════════

interface StrategyRow {
  id: string;
  name: string;
  author: string;
  lp_strategy: string;
  token_criteria_json: string;
  entry_criteria_json: string;
  range_criteria_json: string;
  exit_criteria_json: string;
  best_for: string;
  raw: string;
  added_at: string;
  updated_at: string;
}

function rowToStrategy(row: StrategyRow): Strategy {
  return {
    id: row.id,
    name: row.name,
    author: row.author,
    lp_strategy: row.lp_strategy as LPStrategyType,
    token_criteria: JSON.parse(row.token_criteria_json || "{}"),
    entry: JSON.parse(row.entry_criteria_json || "{}"),
    range: JSON.parse(row.range_criteria_json || "{}"),
    exit: JSON.parse(row.exit_criteria_json || "{}"),
    best_for: row.best_for,
    raw: row.raw,
    added_at: row.added_at,
    updated_at: row.updated_at,
  };
}

async function ensureDefaultStrategies(): Promise<void> {
  const existingIds = (await infra().db.query<{ id: string }>("SELECT id FROM strategies")).map(
    (r) => r.id
  );
  let added = false;

  for (const [id, strategy] of Object.entries(DEFAULT_STRATEGIES)) {
    if (!existingIds.includes(id)) {
      const now = new Date().toISOString();
      try {
        await infra().db.run(
          `INSERT INTO strategies (id, name, author, lp_strategy, token_criteria_json, entry_criteria_json,
            range_criteria_json, exit_criteria_json, best_for, raw, added_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          strategy.name,
          strategy.author,
          strategy.lp_strategy,
          JSON.stringify(strategy.token_criteria || {}),
          JSON.stringify(strategy.entry || {}),
          JSON.stringify(strategy.range || {}),
          JSON.stringify(strategy.exit || {}),
          strategy.best_for,
          strategy.raw || "",
          now,
          now
        );
        added = true;
      } catch (err) {
        log("strategy_warn", `Failed to add default strategy ${id}: ${err}`);
      }
    }
  }

  // Set active strategy if none set
    const activeRow = await infra().db.get<{ active_id: string }>(
      "SELECT active_id FROM active_strategy LIMIT 1"
    );
    if (!activeRow?.active_id && added) {
    await infra().db.run(
      "INSERT OR REPLACE INTO active_strategy (id, active_id) VALUES (1, ?)",
      "custom_ratio_spot"
    );
    log("strategy", "Preloaded default strategies and set active");
  } else if (added) {
    log("strategy", "Preloaded default strategies");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Lazy Initialization
// ═══════════════════════════════════════════════════════════════════════════

let _defaultsEnsured = false;

/**
 * Ensure default strategies are loaded (lazy initialization).
 * Called automatically by tool handlers on first use.
 * This avoids race conditions with database setup.
 */
async function ensureDefaultsLazy(): Promise<void> {
  if (_defaultsEnsured) return;
  _defaultsEnsured = true;
  await ensureDefaultStrategies();
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Handlers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Add or update a strategy.
 */
export async function addStrategy({
  id,
  name,
  author = "unknown",
  lp_strategy = "bid_ask",
  token_criteria = {},
  entry = {},
  range = {},
  exit = {},
  best_for = "",
  raw = "",
}: AddStrategyParams): Promise<AddStrategyResult> {
  await ensureDefaultsLazy();
  if (!id || !name) return { error: "id and name are required" };

  // Slugify id
  const slug = id
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");

  const now = new Date().toISOString();

  try {
    await infra().db.run(
      `INSERT OR REPLACE INTO strategies (id, name, author, lp_strategy, token_criteria_json,
        entry_criteria_json, range_criteria_json, exit_criteria_json, best_for, raw, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT added_at FROM strategies WHERE id = ?), ?), ?)`,
      slug,
      name,
      author,
      lp_strategy,
      JSON.stringify(token_criteria),
      JSON.stringify(entry),
      JSON.stringify(range),
      JSON.stringify(exit),
      best_for,
      raw,
      slug,
      now,
      now
    );

    // Auto-set as active if it's the first strategy
    const activeRow = await infra().db.get<{ active_id: string }>(
      "SELECT active_id FROM active_strategy LIMIT 1"
    );
    if (!activeRow?.active_id) {
      await infra().db.run("INSERT OR REPLACE INTO active_strategy (id, active_id) VALUES (1, ?)", slug);
    }

    const isActive = activeRow?.active_id === slug || !activeRow?.active_id;
    log("strategy", `Strategy saved: ${name} (${slug})`);
    return { saved: true, id: slug, name, active: isActive };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("strategy_error", `Failed to save strategy ${slug}: ${errorMsg}`);
    return { error: `Failed to save strategy: ${errorMsg}` };
  }
}

/**
 * List all strategies with a summary.
 */
export async function listStrategies(): Promise<ListStrategiesResult> {
  await ensureDefaultsLazy();
  const rows = await infra().db.query<StrategyRow>("SELECT * FROM strategies ORDER BY added_at DESC");
  const activeRow = await infra().db.get<{ active_id: string }>(
    "SELECT active_id FROM active_strategy LIMIT 1"
  );

  const strategies = rows.map((s) => ({
    id: s.id,
    name: s.name,
    author: s.author,
    lp_strategy: s.lp_strategy as LPStrategyType,
    best_for: s.best_for,
    active: activeRow?.active_id === s.id,
    added_at: s.added_at?.slice(0, 10),
    warning: NON_FUNCTIONAL_STRATEGIES.has(s.id)
      ? "Strategy exists as documentation only. Core functions not implemented. See plan/strategy-audit/"
      : undefined,
  }));

  return { active: activeRow?.active_id || null, count: strategies.length, strategies };
}

/**
 * Get full details of a strategy.
 */
export async function getStrategy({ id }: { id: string }): Promise<GetStrategyResult> {
  await ensureDefaultsLazy();
  if (!id) return { error: "id required" };

  const row = await infra().db.get<StrategyRow>("SELECT * FROM strategies WHERE id = ?", id);
  if (!row) {
    const allIds = (await infra().db.query<{ id: string }>("SELECT id FROM strategies")).map(
      (r) => r.id
    );
    return { error: `Strategy "${id}" not found`, available: allIds };
  }

  const activeRow = await infra().db.get<{ active_id: string }>(
    "SELECT active_id FROM active_strategy LIMIT 1"
  );
  return { ...rowToStrategy(row), is_active: activeRow?.active_id === id };
}

/**
 * Set the active strategy.
 */
export async function setActiveStrategy({ id }: { id: string }): Promise<SetActiveStrategyResult> {
  await ensureDefaultsLazy();
  if (!id) return { error: "id required" };

  const row = await infra().db.get<{ name: string }>("SELECT name FROM strategies WHERE id = ?", id);
  if (!row) {
    const allIds = (await infra().db.query<{ id: string }>("SELECT id FROM strategies")).map(
      (r) => r.id
    );
    return { error: `Strategy "${id}" not found`, available: allIds };
  }

  // Warn about non-functional strategies
  if (NON_FUNCTIONAL_STRATEGIES.has(id)) {
    log("strategy_warn", `Activating non-functional strategy: ${row.name}`);
    log("strategy_warn", `  See audit: plan/strategy-audit/ for details`);
    log(
      "strategy_warn",
      `  This strategy exists as documentation only and cannot be automatically executed.`
    );
  }

  try {
    await infra().db.run("INSERT OR REPLACE INTO active_strategy (id, active_id) VALUES (1, ?)", id);
    log("strategy", `Active strategy set to: ${row.name}`);
    return { active: id, name: row.name };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to set active strategy: ${errorMsg}` };
  }
}

/**
 * Remove a strategy.
 */
export async function removeStrategy({ id }: { id: string }): Promise<RemoveStrategyResult> {
  await ensureDefaultsLazy();
  if (!id) return { error: "id required" };

  const row = await infra().db.get<{ name: string }>("SELECT name FROM strategies WHERE id = ?", id);
  if (!row) return { error: `Strategy "${id}" not found` };

  try {
    await infra().db.run("DELETE FROM strategies WHERE id = ?", id);

    // Update active if needed
    const activeRow = await infra().db.get<{ active_id: string }>(
      "SELECT active_id FROM active_strategy LIMIT 1"
    );
    let newActive: string | null = activeRow?.active_id || null;

    if (activeRow?.active_id === id) {
      const remaining = await infra().db.query<{ id: string }>(
        "SELECT id FROM strategies ORDER BY added_at DESC LIMIT 1"
      );
      newActive = remaining[0]?.id || null;
      await infra().db.run("INSERT OR REPLACE INTO active_strategy (id, active_id) VALUES (1, ?)", newActive);
    }

    log("strategy", `Strategy removed: ${row.name}`);
    return { removed: true, id, name: row.name, new_active: newActive };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to remove strategy: ${errorMsg}` };
  }
}

/**
 * Get the currently active strategy.
 */
export async function getActiveStrategy(): Promise<Strategy | null> {
  await ensureDefaultsLazy();
  const activeRow = await infra().db.get<{ active_id: string }>("SELECT active_id FROM active_strategy LIMIT 1");
  if (!activeRow?.active_id) return null;

  const row = await infra().db.get<StrategyRow>("SELECT * FROM strategies WHERE id = ?", activeRow.active_id);
  if (!row) return null;

  return rowToStrategy(row);
}

/**
 * Resolve a strategy by LP shape/type.
 *
 * Preference order:
 * 1. Active strategy if it matches the requested lp_strategy
 * 2. Most recently updated strategy matching the lp_strategy
 */
export async function getStrategyByLpStrategy(lpStrategy: LPStrategyType): Promise<Strategy | null> {
  await ensureDefaultsLazy();

  const active = await getActiveStrategy();
  if (active?.lp_strategy === lpStrategy) {
    return active;
  }

  const row = await infra().db.get<StrategyRow>(
    "SELECT * FROM strategies WHERE lp_strategy = ? ORDER BY updated_at DESC, added_at DESC LIMIT 1",
    lpStrategy
  );

  return row ? rowToStrategy(row) : null;
}

/**
 * Clear all strategies (useful for testing).
 */
export async function clearStrategies(): Promise<{ cleared: number }> {
  const result = await infra().db.run("DELETE FROM strategies");
  await infra().db.run("DELETE FROM active_strategy");
  log("strategy", `Cleared ${result.changes} strategies`);
  return { cleared: Number(result.changes) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Registrations
// ═══════════════════════════════════════════════════════════════════════════

registerTool({
  name: "add_strategy",
  handler: addStrategy,
  roles: ["GENERAL"],
});

registerTool({
  name: "list_strategies",
  handler: listStrategies,
  roles: ["GENERAL"],
});

registerTool({
  name: "get_strategy",
  handler: getStrategy,
  roles: ["GENERAL"],
});

registerTool({
  name: "set_active_strategy",
  handler: setActiveStrategy,
  roles: ["GENERAL"],
});

registerTool({
  name: "remove_strategy",
  handler: removeStrategy,
  roles: ["GENERAL"],
});
