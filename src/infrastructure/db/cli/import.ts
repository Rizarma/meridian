import type { DatabaseOperations } from "../../../domain/interfaces/database.js";
import { createDatabase } from "../index.js";
import type { ExportData } from "./types.js";

const BATCH_SIZE = 100;

export async function importToPostgres(data: ExportData, databaseUrl: string): Promise<void> {
  console.log("Initializing Postgres connection...");

  const db = await createDatabase({ backend: "postgres", url: databaseUrl });

  try {
    console.log("Importing data to Postgres...");

    await db.transaction(async (tx) => {
      await importSchemaVersion(tx, data.schemaVersion);
      await importPools(tx, data.pools);
      await importPositions(tx, data.positions);
      await importLessons(tx, data.lessons);
      await importPerformance(tx, data.performance);
      await importSignalWeights(tx, data.signalWeights);
      await importSignalWeightHistory(tx, data.signalWeightHistory);
      await importPositionSnapshots(tx, data.positionSnapshots);
      await importPositionEvents(tx, data.positionEvents);
      await importPositionState(tx, data.positionState);
      await importPositionStateEvents(tx, data.positionStateEvents);
      await importStateMetadata(tx, data.stateMetadata);
      await importStrategies(tx, data.strategies);
      await importActiveStrategy(tx, data.activeStrategy);
      await importTokenBlacklist(tx, data.tokenBlacklist);
      await importSmartWallets(tx, data.smartWallets);
      await importDevBlocklist(tx, data.devBlocklist);
      await importCycleState(tx, data.cycleState);
      await importThresholdSuggestions(tx, data.thresholdSuggestions);
      await importThresholdHistory(tx, data.thresholdHistory);
      await importPortfolioHistory(tx, data.portfolioHistory);
      await importPoolDeploys(tx, data.poolDeploys);
    });

    // Reset SERIAL sequences to match imported data (prevents duplicate PK errors)
    console.log("Resetting sequences...");
    await resetSequences(db);

    console.log("Import complete!");
  } finally {
    await db.close();
  }
}

/**
 * Reset SERIAL sequences to match the current max(id) values after import.
 * This prevents duplicate key errors when sequence values drift behind imported data.
 */
async function resetSequences(db: DatabaseOperations): Promise<void> {
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
    await db.run(
      `SELECT setval('${table}_id_seq', COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`
    );
  }
}

async function importSchemaVersion(
  db: DatabaseOperations,
  rows: ExportData["schemaVersion"]
): Promise<void> {
  await insertRows(
    db,
    "schema_version",
    rows,
    ["version", "applied_at"],
    "ON CONFLICT (version) DO NOTHING"
  );
}

async function importPools(db: DatabaseOperations, rows: ExportData["pools"]): Promise<void> {
  await insertRows(
    db,
    "pools",
    rows,
    [
      "address",
      "name",
      "base_mint",
      "total_deploys",
      "avg_pnl_pct",
      "win_rate",
      "adjusted_win_rate",
      "cooldown_until",
      "cooldown_reason",
      "base_mint_cooldown_until",
      "base_mint_cooldown_reason",
      "data_json",
      "created_at",
      "updated_at",
    ],
    `ON CONFLICT (address) DO UPDATE SET
      name = excluded.name,
      base_mint = excluded.base_mint,
      total_deploys = GREATEST(pools.total_deploys, excluded.total_deploys),
      avg_pnl_pct = COALESCE(excluded.avg_pnl_pct, pools.avg_pnl_pct),
      win_rate = COALESCE(excluded.win_rate, pools.win_rate),
      adjusted_win_rate = COALESCE(excluded.adjusted_win_rate, pools.adjusted_win_rate),
      cooldown_until = COALESCE(excluded.cooldown_until, pools.cooldown_until),
      cooldown_reason = COALESCE(excluded.cooldown_reason, pools.cooldown_reason),
      base_mint_cooldown_until = COALESCE(excluded.base_mint_cooldown_until, pools.base_mint_cooldown_until),
      base_mint_cooldown_reason = COALESCE(excluded.base_mint_cooldown_reason, pools.base_mint_cooldown_reason),
      data_json = COALESCE(excluded.data_json, pools.data_json),
      updated_at = GREATEST(pools.updated_at, excluded.updated_at)`
  );
}

async function importPositions(
  db: DatabaseOperations,
  rows: ExportData["positions"]
): Promise<void> {
  await insertRows(
    db,
    "positions",
    rows,
    [
      "address",
      "pool",
      "pool_name",
      "strategy",
      "deployed_at",
      "closed_at",
      "closed",
      "amount_sol",
      "pnl_pct",
      "pnl_usd",
      "fees_earned_usd",
      "initial_value_usd",
      "final_value_usd",
      "minutes_held",
      "close_reason",
      "trailing_state",
      "notes",
      "data_json",
      "created_at",
      "updated_at",
    ],
    `ON CONFLICT (address) DO UPDATE SET
      pool = excluded.pool,
      pool_name = excluded.pool_name,
      strategy = excluded.strategy,
      deployed_at = excluded.deployed_at,
      closed_at = COALESCE(excluded.closed_at, positions.closed_at),
      closed = excluded.closed,
      amount_sol = COALESCE(excluded.amount_sol, positions.amount_sol),
      pnl_pct = COALESCE(excluded.pnl_pct, positions.pnl_pct),
      pnl_usd = COALESCE(excluded.pnl_usd, positions.pnl_usd),
      fees_earned_usd = COALESCE(excluded.fees_earned_usd, positions.fees_earned_usd),
      initial_value_usd = COALESCE(excluded.initial_value_usd, positions.initial_value_usd),
      final_value_usd = COALESCE(excluded.final_value_usd, positions.final_value_usd),
      minutes_held = COALESCE(excluded.minutes_held, positions.minutes_held),
      close_reason = COALESCE(excluded.close_reason, positions.close_reason),
      trailing_state = COALESCE(excluded.trailing_state, positions.trailing_state),
      notes = COALESCE(excluded.notes, positions.notes),
      data_json = COALESCE(excluded.data_json, positions.data_json),
      updated_at = GREATEST(positions.updated_at, excluded.updated_at)`
  );
}

async function importLessons(db: DatabaseOperations, rows: ExportData["lessons"]): Promise<void> {
  await insertRows(
    db,
    "lessons",
    rows,
    [
      "id",
      "rule",
      "tags",
      "outcome",
      "context",
      "pool",
      "pnl_pct",
      "range_efficiency",
      "created_at",
      "pinned",
      "role",
      "data_json",
    ],
    "ON CONFLICT (id) DO NOTHING"
  );
}

async function importPerformance(
  db: DatabaseOperations,
  rows: ExportData["performance"]
): Promise<void> {
  await insertRows(
    db,
    "performance",
    rows,
    [
      "id",
      "position",
      "pool",
      "pool_name",
      "strategy",
      "amount_sol",
      "pnl_pct",
      "pnl_usd",
      "fees_earned_usd",
      "initial_value_usd",
      "final_value_usd",
      "minutes_held",
      "minutes_in_range",
      "range_efficiency",
      "close_reason",
      "base_mint",
      "bin_step",
      "volatility",
      "fee_tvl_ratio",
      "organic_score",
      "bin_range",
      "recorded_at",
      "data_json",
    ],
    "ON CONFLICT DO NOTHING"
  );
}

async function importSignalWeights(
  db: DatabaseOperations,
  rows: ExportData["signalWeights"]
): Promise<void> {
  await insertRows(
    db,
    "signal_weights",
    rows,
    ["signal", "weight", "updated_at"],
    `ON CONFLICT (signal) DO UPDATE SET
      weight = excluded.weight,
      updated_at = GREATEST(signal_weights.updated_at, excluded.updated_at)`
  );
}

async function importSignalWeightHistory(
  db: DatabaseOperations,
  rows: ExportData["signalWeightHistory"]
): Promise<void> {
  await insertRows(
    db,
    "signal_weight_history",
    rows,
    [
      "id",
      "signal",
      "weight_from",
      "weight_to",
      "lift",
      "action",
      "window_size",
      "win_count",
      "loss_count",
      "changed_at",
    ],
    "ON CONFLICT DO NOTHING"
  );
}

async function importPositionSnapshots(
  db: DatabaseOperations,
  rows: ExportData["positionSnapshots"]
): Promise<void> {
  await insertRows(
    db,
    "position_snapshots",
    rows,
    [
      "id",
      "position_address",
      "ts",
      "pnl_pct",
      "pnl_usd",
      "in_range",
      "unclaimed_fees_usd",
      "minutes_out_of_range",
      "age_minutes",
      "data_json",
    ],
    "ON CONFLICT DO NOTHING"
  );
}

async function importPositionEvents(
  db: DatabaseOperations,
  rows: ExportData["positionEvents"]
): Promise<void> {
  await insertRows(
    db,
    "position_events",
    rows,
    ["id", "position_address", "event_type", "ts", "data_json"],
    "ON CONFLICT DO NOTHING"
  );
}

async function importPositionState(
  db: DatabaseOperations,
  rows: ExportData["positionState"]
): Promise<void> {
  await insertRows(
    db,
    "position_state",
    rows,
    [
      "position",
      "pool",
      "pool_name",
      "strategy",
      "strategy_config",
      "bin_range",
      "amount_sol",
      "amount_x",
      "active_bin_at_deploy",
      "bin_step",
      "volatility",
      "fee_tvl_ratio",
      "initial_fee_tvl_24h",
      "organic_score",
      "initial_value_usd",
      "signal_snapshot",
      "deployed_at",
      "out_of_range_since",
      "last_claim_at",
      "rebalance_count",
      "total_fees_claimed_usd",
      "closed",
      "closed_at",
      "notes",
      "peak_pnl_pct",
      "pending_peak_pnl_pct",
      "pending_peak_started_at",
      "trailing_active",
      "instruction",
      "pending_trailing_current_pnl_pct",
      "pending_trailing_peak_pnl_pct",
      "pending_trailing_drop_pct",
      "pending_trailing_started_at",
      "confirmed_trailing_exit_reason",
      "confirmed_trailing_exit_until",
      "last_updated",
    ],
    `ON CONFLICT (position) DO UPDATE SET
      pool = excluded.pool,
      pool_name = excluded.pool_name,
      strategy = excluded.strategy,
      strategy_config = COALESCE(excluded.strategy_config, position_state.strategy_config),
      bin_range = excluded.bin_range,
      amount_sol = COALESCE(excluded.amount_sol, position_state.amount_sol),
      amount_x = COALESCE(excluded.amount_x, position_state.amount_x),
      active_bin_at_deploy = COALESCE(excluded.active_bin_at_deploy, position_state.active_bin_at_deploy),
      bin_step = COALESCE(excluded.bin_step, position_state.bin_step),
      volatility = COALESCE(excluded.volatility, position_state.volatility),
      fee_tvl_ratio = COALESCE(excluded.fee_tvl_ratio, position_state.fee_tvl_ratio),
      initial_fee_tvl_24h = COALESCE(excluded.initial_fee_tvl_24h, position_state.initial_fee_tvl_24h),
      organic_score = COALESCE(excluded.organic_score, position_state.organic_score),
      initial_value_usd = COALESCE(excluded.initial_value_usd, position_state.initial_value_usd),
      signal_snapshot = COALESCE(excluded.signal_snapshot, position_state.signal_snapshot),
      deployed_at = excluded.deployed_at,
      out_of_range_since = COALESCE(excluded.out_of_range_since, position_state.out_of_range_since),
      last_claim_at = COALESCE(excluded.last_claim_at, position_state.last_claim_at),
      rebalance_count = COALESCE(excluded.rebalance_count, position_state.rebalance_count),
      total_fees_claimed_usd = COALESCE(excluded.total_fees_claimed_usd, position_state.total_fees_claimed_usd),
      closed = COALESCE(excluded.closed, position_state.closed),
      closed_at = COALESCE(excluded.closed_at, position_state.closed_at),
      notes = COALESCE(excluded.notes, position_state.notes),
      peak_pnl_pct = COALESCE(excluded.peak_pnl_pct, position_state.peak_pnl_pct),
      pending_peak_pnl_pct = COALESCE(excluded.pending_peak_pnl_pct, position_state.pending_peak_pnl_pct),
      pending_peak_started_at = COALESCE(excluded.pending_peak_started_at, position_state.pending_peak_started_at),
      trailing_active = COALESCE(excluded.trailing_active, position_state.trailing_active),
      instruction = COALESCE(excluded.instruction, position_state.instruction),
      pending_trailing_current_pnl_pct = COALESCE(excluded.pending_trailing_current_pnl_pct, position_state.pending_trailing_current_pnl_pct),
      pending_trailing_peak_pnl_pct = COALESCE(excluded.pending_trailing_peak_pnl_pct, position_state.pending_trailing_peak_pnl_pct),
      pending_trailing_drop_pct = COALESCE(excluded.pending_trailing_drop_pct, position_state.pending_trailing_drop_pct),
      pending_trailing_started_at = COALESCE(excluded.pending_trailing_started_at, position_state.pending_trailing_started_at),
      confirmed_trailing_exit_reason = COALESCE(excluded.confirmed_trailing_exit_reason, position_state.confirmed_trailing_exit_reason),
      confirmed_trailing_exit_until = COALESCE(excluded.confirmed_trailing_exit_until, position_state.confirmed_trailing_exit_until),
      last_updated = excluded.last_updated`
  );
}

async function importPositionStateEvents(
  db: DatabaseOperations,
  rows: ExportData["positionStateEvents"]
): Promise<void> {
  await insertRows(
    db,
    "position_state_events",
    rows,
    ["id", "ts", "action", "position", "pool_name", "reason"],
    "ON CONFLICT DO NOTHING"
  );
}

async function importStateMetadata(
  db: DatabaseOperations,
  rows: ExportData["stateMetadata"]
): Promise<void> {
  const normalized = rows.map((row) => ({
    key: row.key,
    value: row.value,
    updated_at: row.updated_at ?? new Date().toISOString(),
  }));

  await insertRows(
    db,
    "state_metadata",
    normalized,
    ["key", "value", "updated_at"],
    `ON CONFLICT (key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at`
  );
}

async function importStrategies(
  db: DatabaseOperations,
  rows: ExportData["strategies"]
): Promise<void> {
  const normalized = rows.map((row) => ({
    id: row.id,
    name: row.name,
    author: row.author ?? "unknown",
    lp_strategy: row.lp_strategy,
    token_criteria_json: row.token_criteria_json ?? "{}",
    entry_criteria_json: row.entry_criteria_json ?? "{}",
    exit_criteria_json: row.exit_criteria_json ?? row.range_criteria_json ?? "{}",
    position_params_json: row.position_params_json ?? row.range_criteria_json ?? null,
    risk_params_json: row.risk_params_json ?? row.raw ?? null,
    description: row.description ?? row.best_for ?? row.raw ?? null,
    created_at: row.created_at ?? row.added_at,
    updated_at: row.updated_at,
    added_at: row.added_at,
  }));

  await insertRows(
    db,
    "strategies",
    normalized,
    [
      "id",
      "name",
      "author",
      "lp_strategy",
      "token_criteria_json",
      "entry_criteria_json",
      "exit_criteria_json",
      "position_params_json",
      "risk_params_json",
      "description",
      "created_at",
      "updated_at",
      "added_at",
    ],
    `ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      author = excluded.author,
      lp_strategy = excluded.lp_strategy,
      token_criteria_json = excluded.token_criteria_json,
      entry_criteria_json = excluded.entry_criteria_json,
      exit_criteria_json = excluded.exit_criteria_json,
      position_params_json = excluded.position_params_json,
      risk_params_json = excluded.risk_params_json,
      description = excluded.description,
      updated_at = GREATEST(strategies.updated_at, excluded.updated_at),
      added_at = strategies.added_at`
  );
}

async function importActiveStrategy(
  db: DatabaseOperations,
  rows: ExportData["activeStrategy"]
): Promise<void> {
  await insertRows(
    db,
    "active_strategy",
    rows,
    ["id", "active_id"],
    `ON CONFLICT (id) DO UPDATE SET active_id = excluded.active_id`
  );
}

async function importTokenBlacklist(
  db: DatabaseOperations,
  rows: ExportData["tokenBlacklist"]
): Promise<void> {
  const normalized = rows.map((row) => ({
    mint: row.mint,
    symbol: row.symbol ?? "UNKNOWN",
    reason: row.reason ?? "no reason provided",
    added_at: row.added_at,
    added_by: row.added_by ?? "agent",
  }));

  await insertRows(
    db,
    "token_blacklist",
    normalized,
    ["mint", "symbol", "reason", "added_at", "added_by"],
    `ON CONFLICT (mint) DO UPDATE SET
      symbol = excluded.symbol,
      reason = excluded.reason,
      added_at = excluded.added_at,
      added_by = excluded.added_by`
  );
}

async function importSmartWallets(
  db: DatabaseOperations,
  rows: ExportData["smartWallets"]
): Promise<void> {
  const normalized = rows.map((row) => ({
    address: row.address,
    name: row.name ?? "unknown",
    category: row.category ?? "alpha",
    type: row.type ?? "lp",
    added_at: row.added_at,
  }));

  await insertRows(
    db,
    "smart_wallets",
    normalized,
    ["address", "name", "category", "type", "added_at"],
    `ON CONFLICT (address) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      type = excluded.type,
      added_at = excluded.added_at`
  );
}

async function importDevBlocklist(
  db: DatabaseOperations,
  rows: ExportData["devBlocklist"]
): Promise<void> {
  const normalized = rows.map((row) => ({
    dev_address: row.dev_address ?? (row as { wallet?: string }).wallet ?? "unknown",
    reason: row.reason ?? (row as { label?: string }).label ?? "no reason provided",
    added_at: row.added_at,
    evidence_json: row.evidence_json ?? null,
  }));

  await insertRows(
    db,
    "dev_blocklist",
    normalized,
    ["dev_address", "reason", "added_at", "evidence_json"],
    `ON CONFLICT (dev_address) DO UPDATE SET
      reason = excluded.reason,
      added_at = excluded.added_at,
      evidence_json = excluded.evidence_json`
  );
}

async function importCycleState(
  db: DatabaseOperations,
  rows: ExportData["cycleState"]
): Promise<void> {
  await insertRows(
    db,
    "cycle_state",
    rows,
    ["id", "phase", "started_at", "last_run_at", "data_json"],
    `ON CONFLICT (id) DO UPDATE SET
      phase = excluded.phase,
      started_at = excluded.started_at,
      last_run_at = excluded.last_run_at,
      data_json = excluded.data_json`
  );
}

async function importThresholdSuggestions(
  db: DatabaseOperations,
  rows: ExportData["thresholdSuggestions"]
): Promise<void> {
  const normalized = rows.map((row) => ({
    id: row.id,
    pool_address: row.pool_address ?? row.field ?? "unknown",
    metric: row.metric ?? row.field ?? "unknown",
    current_value: row.current_value,
    suggested_value: row.suggested_value,
    confidence: row.confidence,
    reasoning: row.reasoning ?? row.rationale ?? null,
    status: row.status,
    created_at: row.created_at,
    decided_at: row.decided_at ?? row.reviewed_at ?? row.applied_at ?? null,
    data_json:
      row.data_json ??
      JSON.stringify({
        sample_size: row.sample_size ?? null,
        winner_count: row.winner_count ?? null,
        loser_count: row.loser_count ?? null,
        reviewed_by: row.reviewed_by ?? null,
      }),
  }));

  await insertRows(
    db,
    "threshold_suggestions",
    normalized,
    [
      "id",
      "pool_address",
      "metric",
      "current_value",
      "suggested_value",
      "confidence",
      "reasoning",
      "status",
      "created_at",
      "decided_at",
      "data_json",
    ],
    "ON CONFLICT DO NOTHING"
  );
}

async function importThresholdHistory(
  db: DatabaseOperations,
  rows: ExportData["thresholdHistory"]
): Promise<void> {
  const normalized = rows.map((row) => ({
    id: row.id,
    pool_address: row.pool_address ?? row.field ?? "unknown",
    metric: row.metric ?? row.field ?? "unknown",
    old_value: row.old_value,
    new_value: row.new_value,
    reason: row.reason ?? row.rationale ?? null,
    applied_at: row.applied_at,
    data_json:
      row.data_json ??
      JSON.stringify({
        confidence: row.confidence ?? null,
        sample_size: row.sample_size ?? null,
        triggered_by: row.triggered_by ?? null,
        performance_snapshot: row.performance_snapshot ?? null,
      }),
  }));

  await insertRows(
    db,
    "threshold_history",
    normalized,
    ["id", "pool_address", "metric", "old_value", "new_value", "reason", "applied_at", "data_json"],
    "ON CONFLICT DO NOTHING"
  );
}

async function importPortfolioHistory(
  db: DatabaseOperations,
  rows: ExportData["portfolioHistory"]
): Promise<void> {
  const normalized = rows.map((row) => ({
    id: row.id,
    wallet_address: row.wallet_address,
    pool_address: row.pool_address,
    first_seen_at: row.first_seen_at ?? row.fetched_at ?? row.created_at ?? null,
    last_seen_at: row.last_seen_at ?? row.fetched_at ?? row.updated_at ?? row.created_at ?? null,
    total_positions: row.total_positions ?? row.total_positions_count ?? 0,
    avg_pnl_pct: row.outperformance_delta ?? row.our_total_pnl_pct ?? row.avg_pnl_pct ?? null,
    data_json:
      row.data_json ??
      JSON.stringify({
        pool_name: row.pool_name ?? null,
        token_x_mint: row.token_x_mint ?? null,
        token_y_mint: row.token_y_mint ?? null,
        token_x_symbol: row.token_x_symbol ?? null,
        token_y_symbol: row.token_y_symbol ?? null,
        bin_step: row.bin_step ?? null,
        base_fee: row.base_fee ?? null,
        total_deposit_usd: row.total_deposit_usd ?? null,
        total_deposit_sol: row.total_deposit_sol ?? null,
        total_withdrawal_usd: row.total_withdrawal_usd ?? null,
        total_withdrawal_sol: row.total_withdrawal_sol ?? null,
        total_fee_usd: row.total_fee_usd ?? null,
        total_fee_sol: row.total_fee_sol ?? null,
        pnl_usd: row.pnl_usd ?? null,
        pnl_sol: row.pnl_sol ?? null,
        pnl_pct_change: row.pnl_pct_change ?? null,
        pnl_sol_pct_change: row.pnl_sol_pct_change ?? null,
        token_breakdown_json: row.token_breakdown_json ?? null,
        last_closed_at: row.last_closed_at ?? null,
        days_back: row.days_back ?? null,
        fee_efficiency_annualized: row.fee_efficiency_annualized ?? null,
        capital_rotation_ratio: row.capital_rotation_ratio ?? null,
        data_freshness_hours: row.data_freshness_hours ?? null,
        our_positions_count: row.our_positions_count ?? null,
        our_total_pnl_pct: row.our_total_pnl_pct ?? null,
        outperformance_delta: row.outperformance_delta ?? null,
        is_active_pool: row.is_active_pool ?? null,
        lesson_generated: row.lesson_generated ?? null,
      }),
    lesson_generated: row.lesson_generated ?? 0,
    created_at: row.created_at ?? new Date().toISOString(),
    updated_at: row.updated_at ?? new Date().toISOString(),
  }));

  await insertRows(
    db,
    "portfolio_history",
    normalized,
    [
      "id",
      "wallet_address",
      "pool_address",
      "first_seen_at",
      "last_seen_at",
      "total_positions",
      "avg_pnl_pct",
      "data_json",
      "lesson_generated",
      "created_at",
      "updated_at",
    ],
    "ON CONFLICT DO NOTHING"
  );
}

async function importPoolDeploys(
  db: DatabaseOperations,
  rows: ExportData["poolDeploys"]
): Promise<void> {
  await insertRows(
    db,
    "pool_deploys",
    rows,
    [
      "id",
      "pool_address",
      "position_address",
      "deployed_at",
      "closed_at",
      "pnl_pct",
      "pnl_usd",
      "range_efficiency",
      "minutes_held",
      "close_reason",
      "strategy",
      "volatility_at_deploy",
      "data_json",
    ],
    "ON CONFLICT DO NOTHING"
  );
}

async function insertRows(
  db: DatabaseOperations,
  tableName: string,
  rows: readonly object[],
  columns: readonly string[],
  conflictClause?: string
): Promise<void> {
  if (!rows.length) return;

  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const chunk = rows.slice(index, index + BATCH_SIZE);
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    const params = chunk.flatMap((row) => {
      const record = row as Record<string, unknown>;
      return columns.map((column) => record[column] ?? null);
    });

    const sql = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES ${placeholders}${conflictClause ? ` ${conflictClause}` : ""}`;
    await db.run(sql, ...params);
  }
}
