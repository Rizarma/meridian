import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { ExportData } from "./types.js";

export async function exportSqlite(dbPath: string, outputPath: string): Promise<void> {
  console.log(`Exporting SQLite database from: ${dbPath}`);

  const db = new Database(dbPath);

  try {
    const data: ExportData = {
      lessons: db.prepare("SELECT * FROM lessons").all() as ExportData["lessons"],
      performance: db.prepare("SELECT * FROM performance").all() as ExportData["performance"],
      pools: db.prepare("SELECT * FROM pools").all() as ExportData["pools"],
      positions: db.prepare("SELECT * FROM positions").all() as ExportData["positions"],
      positionSnapshots: db.prepare("SELECT * FROM position_snapshots").all() as ExportData["positionSnapshots"],
      positionEvents: db.prepare("SELECT * FROM position_events").all() as ExportData["positionEvents"],
      signalWeights: db.prepare("SELECT * FROM signal_weights").all() as ExportData["signalWeights"],
      poolDeploys: db.prepare("SELECT * FROM pool_deploys").all() as ExportData["poolDeploys"],
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
