import type { DatabaseOperations } from "../../../domain/interfaces/database.js";
import { createDatabase } from "../index.js";
import type { ExportData } from "./types.js";

export async function importToPostgres(data: ExportData, databaseUrl: string): Promise<void> {
  console.log("Initializing Postgres connection...");

  const db = await createDatabase({ backend: "postgres", url: databaseUrl });

  try {
    console.log("Importing data to Postgres...");

    await importPools(db, data.pools);
    await importPositions(db, data.positions);
    await importPoolDeploys(db, data.poolDeploys);
    await importLessons(db, data.lessons);
    await importPerformance(db, data.performance);
    await importPositionSnapshots(db, data.positionSnapshots);
    await importPositionEvents(db, data.positionEvents);
    await importSignalWeights(db, data.signalWeights);

    console.log("Import complete!");
  } finally {
    await db.close();
  }
}

async function importPools(db: DatabaseOperations, pools: ExportData["pools"]): Promise<void> {
  console.log(`Importing ${pools.length} pools...`);

  for (const pool of pools) {
    await db.run(
      `INSERT INTO pools (address, name, base_mint, total_deploys, avg_pnl_pct, win_rate,
        adjusted_win_rate, cooldown_until, cooldown_reason, base_mint_cooldown_until,
        base_mint_cooldown_reason, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET
        name = excluded.name,
        total_deploys = GREATEST(pools.total_deploys, excluded.total_deploys),
        updated_at = GREATEST(pools.updated_at, excluded.updated_at)`,
      pool.address,
      pool.name,
      pool.base_mint,
      pool.total_deploys,
      pool.avg_pnl_pct,
      pool.win_rate,
      pool.adjusted_win_rate,
      pool.cooldown_until,
      pool.cooldown_reason,
      pool.base_mint_cooldown_until,
      pool.base_mint_cooldown_reason,
      pool.data_json,
      pool.created_at,
      pool.updated_at
    );
  }
}

async function importPositions(db: DatabaseOperations, positions: ExportData["positions"]): Promise<void> {
  console.log(`Importing ${positions.length} positions...`);
  for (const pos of positions) {
    await db.run(
      `INSERT INTO positions (address, pool, pool_name, strategy, deployed_at, closed_at,
        closed, amount_sol, pnl_pct, pnl_usd, fees_earned_usd, initial_value_usd,
        final_value_usd, minutes_held, close_reason, trailing_state, notes, data_json,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET
        closed = excluded.closed,
        closed_at = COALESCE(excluded.closed_at, positions.closed_at),
        pnl_pct = COALESCE(excluded.pnl_pct, positions.pnl_pct),
        updated_at = GREATEST(positions.updated_at, excluded.updated_at)`,
      pos.address,
      pos.pool,
      pos.pool_name,
      pos.strategy,
      pos.deployed_at,
      pos.closed_at,
      pos.closed,
      pos.amount_sol,
      pos.pnl_pct,
      pos.pnl_usd,
      pos.fees_earned_usd,
      pos.initial_value_usd,
      pos.final_value_usd,
      pos.minutes_held,
      pos.close_reason,
      pos.trailing_state,
      pos.notes,
      pos.data_json,
      pos.created_at,
      pos.updated_at
    );
  }
}

async function importLessons(db: DatabaseOperations, lessons: ExportData["lessons"]): Promise<void> {
  console.log(`Importing ${lessons.length} lessons...`);
  for (const lesson of lessons) {
    await db.run(
      `INSERT INTO lessons (id, rule, tags, outcome, context, pool, pnl_pct,
        range_efficiency, created_at, pinned, role, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      lesson.id,
      lesson.rule,
      lesson.tags,
      lesson.outcome,
      lesson.context,
      lesson.pool,
      lesson.pnl_pct,
      lesson.range_efficiency,
      lesson.created_at,
      lesson.pinned,
      lesson.role,
      lesson.data_json
    );
  }
}

async function importPerformance(
  db: DatabaseOperations,
  performance: ExportData["performance"]
): Promise<void> {
  console.log(`Importing ${performance.length} performance records...`);
  for (const record of performance) {
    await db.run(
      `INSERT INTO performance (id, position, pool, pool_name, strategy, amount_sol, pnl_pct,
        pnl_usd, fees_earned_usd, initial_value_usd, final_value_usd, minutes_held,
        minutes_in_range, range_efficiency, close_reason, base_mint, bin_step, volatility,
        fee_tvl_ratio, organic_score, bin_range, recorded_at, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      record.id,
      record.position,
      record.pool,
      record.pool_name,
      record.strategy,
      record.amount_sol,
      record.pnl_pct,
      record.pnl_usd,
      record.fees_earned_usd,
      record.initial_value_usd,
      record.final_value_usd,
      record.minutes_held,
      record.minutes_in_range,
      record.range_efficiency,
      record.close_reason,
      record.base_mint,
      record.bin_step,
      record.volatility,
      record.fee_tvl_ratio,
      record.organic_score,
      record.bin_range,
      record.recorded_at,
      record.data_json
    );
  }
}

async function importPoolDeploys(db: DatabaseOperations, deploys: ExportData["poolDeploys"]): Promise<void> {
  console.log(`Importing ${deploys.length} pool deploys...`);
  for (const deploy of deploys) {
    await db.run(
      `INSERT INTO pool_deploys (id, pool_address, position_address, deployed_at, closed_at,
        pnl_pct, pnl_usd, range_efficiency, minutes_held, close_reason, strategy,
        volatility_at_deploy, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      deploy.id,
      deploy.pool_address,
      deploy.position_address,
      deploy.deployed_at,
      deploy.closed_at,
      deploy.pnl_pct,
      deploy.pnl_usd,
      deploy.range_efficiency,
      deploy.minutes_held,
      deploy.close_reason,
      deploy.strategy,
      deploy.volatility_at_deploy,
      deploy.data_json
    );
  }
}

async function importPositionSnapshots(
  db: DatabaseOperations,
  snapshots: ExportData["positionSnapshots"]
): Promise<void> {
  console.log(`Importing ${snapshots.length} position snapshots...`);
  for (const snap of snapshots) {
    await db.run(
      `INSERT INTO position_snapshots (id, position_address, ts, pnl_pct, pnl_usd, in_range,
        unclaimed_fees_usd, minutes_out_of_range, age_minutes, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      snap.id,
      snap.position_address,
      snap.ts,
      snap.pnl_pct,
      snap.pnl_usd,
      snap.in_range,
      snap.unclaimed_fees_usd,
      snap.minutes_out_of_range,
      snap.age_minutes,
      snap.data_json
    );
  }
}

async function importPositionEvents(
  db: DatabaseOperations,
  events: ExportData["positionEvents"]
): Promise<void> {
  console.log(`Importing ${events.length} position events...`);
  for (const event of events) {
    await db.run(
      `INSERT INTO position_events (id, position_address, event_type, ts, data_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      event.id,
      event.position_address,
      event.event_type,
      event.ts,
      event.data_json
    );
  }
}

async function importSignalWeights(
  db: DatabaseOperations,
  weights: ExportData["signalWeights"]
): Promise<void> {
  console.log(`Importing ${weights.length} signal weights...`);
  for (const weight of weights) {
    await db.run(
      `INSERT INTO signal_weights (signal, weight, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (signal) DO UPDATE SET
        weight = excluded.weight,
        updated_at = GREATEST(signal_weights.updated_at, excluded.updated_at)`,
      weight.signal,
      weight.weight,
      weight.updated_at
    );
  }
}
