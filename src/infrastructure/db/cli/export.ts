import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ExportData } from "./types.js";

export async function exportSqlite(dbPath: string, outputPath: string): Promise<void> {
  console.log(`Exporting SQLite database from: ${dbPath}`);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }

  const db = new Database(dbPath);

  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    const tableNames = new Set(tables.map((t) => t.name));
    console.log(`Found tables: ${Array.from(tableNames).join(", ")}`);

    const data: ExportData = {
      schemaVersion: readTable(db, tableNames, "schema_version") as ExportData["schemaVersion"],
      lessons: readTable(db, tableNames, "lessons") as ExportData["lessons"],
      performance: readTable(db, tableNames, "performance") as ExportData["performance"],
      pools: readTable(db, tableNames, "pools") as ExportData["pools"],
      positions: readTable(db, tableNames, "positions") as ExportData["positions"],
      positionSnapshots: readTable(
        db,
        tableNames,
        "position_snapshots"
      ) as ExportData["positionSnapshots"],
      positionEvents: readTable(db, tableNames, "position_events") as ExportData["positionEvents"],
      signalWeights: readTable(db, tableNames, "signal_weights") as ExportData["signalWeights"],
      signalWeightHistory: readTable(
        db,
        tableNames,
        "signal_weight_history"
      ) as ExportData["signalWeightHistory"],
      positionState: readTable(db, tableNames, "position_state") as ExportData["positionState"],
      positionStateEvents: readTable(
        db,
        tableNames,
        "position_state_events"
      ) as ExportData["positionStateEvents"],
      stateMetadata: readTable(db, tableNames, "state_metadata") as ExportData["stateMetadata"],
      strategies: readTable(db, tableNames, "strategies") as ExportData["strategies"],
      activeStrategy: readTable(db, tableNames, "active_strategy") as ExportData["activeStrategy"],
      tokenBlacklist: readTable(db, tableNames, "token_blacklist") as ExportData["tokenBlacklist"],
      smartWallets: readTable(db, tableNames, "smart_wallets") as ExportData["smartWallets"],
      devBlocklist: readTable(db, tableNames, "dev_blocklist") as ExportData["devBlocklist"],
      cycleState: readTable(db, tableNames, "cycle_state") as ExportData["cycleState"],
      thresholdSuggestions: readTable(
        db,
        tableNames,
        "threshold_suggestions"
      ) as ExportData["thresholdSuggestions"],
      thresholdHistory: readTable(
        db,
        tableNames,
        "threshold_history"
      ) as ExportData["thresholdHistory"],
      portfolioHistory: readTable(
        db,
        tableNames,
        "portfolio_history"
      ) as ExportData["portfolioHistory"],
      poolDeploys: readTable(db, tableNames, "pool_deploys") as ExportData["poolDeploys"],
      exportedAt: new Date().toISOString(),
      source: dbPath,
    };

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));

    console.log(`Exported ${data.schemaVersion.length} schema versions`);
    console.log(`Exported ${data.lessons.length} lessons`);
    console.log(`Exported ${data.performance.length} performance records`);
    console.log(`Exported ${data.pools.length} pools`);
    console.log(`Exported ${data.positions.length} positions`);
    console.log(`Export complete: ${outputPath}`);
  } finally {
    db.close();
  }
}

function readTable<T>(db: Database.Database, tables: Set<string>, tableName: string): T[] {
  if (!tables.has(tableName)) return [];
  return db.prepare(`SELECT * FROM ${tableName}`).all() as T[];
}
