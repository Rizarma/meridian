import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { ExportData } from "./types.js";

export async function exportSqlite(dbPath: string, outputPath: string): Promise<void> {
  console.log(`Exporting SQLite database from: ${dbPath}`);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }

  const db = new Database(dbPath);

  try {
    // Check which tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map(t => t.name);
    console.log(`Found tables: ${tableNames.join(', ')}`);

    const data: ExportData = {
      lessons: tableNames.includes('lessons') ? db.prepare("SELECT * FROM lessons").all() as ExportData["lessons"] : [],
      performance: tableNames.includes('performance') ? db.prepare("SELECT * FROM performance").all() as ExportData["performance"] : [],
      pools: tableNames.includes('pools') ? db.prepare("SELECT * FROM pools").all() as ExportData["pools"] : [],
      positions: tableNames.includes('positions') ? db.prepare("SELECT * FROM positions").all() as ExportData["positions"] : [],
      positionSnapshots: tableNames.includes('position_snapshots') ? db.prepare("SELECT * FROM position_snapshots").all() as ExportData["positionSnapshots"] : [],
      positionEvents: tableNames.includes('position_events') ? db.prepare("SELECT * FROM position_events").all() as ExportData["positionEvents"] : [],
      signalWeights: tableNames.includes('signal_weights') ? db.prepare("SELECT * FROM signal_weights").all() as ExportData["signalWeights"] : [],
      poolDeploys: tableNames.includes('pool_deploys') ? db.prepare("SELECT * FROM pool_deploys").all() as ExportData["poolDeploys"] : [],
      exportedAt: new Date().toISOString(),
      source: dbPath,
    };

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));

    console.log(`Exported ${data.lessons.length} lessons`);
    console.log(`Exported ${data.performance.length} performance records`);
    console.log(`Exported ${data.pools.length} pools`);
    console.log(`Exported ${data.positions.length} positions`);
    console.log(`Export complete: ${outputPath}`);
  } finally {
    db.close();
  }
}
