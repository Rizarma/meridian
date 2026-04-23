#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

// Handle uncaught errors from better-sqlite3
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  if (err instanceof Error) {
    console.error('Message:', err.message);
    console.error('Stack:', err.stack);
  } else if (typeof err === 'object' && err !== null) {
    console.error('Error details:', Object.getOwnPropertyNames(err).reduce((acc, key) => {
      try {
        acc[key] = (err as Record<string, unknown>)[key];
      } catch {
        acc[key] = '[unreadable]';
      }
      return acc;
    }, {} as Record<string, unknown>));
  }
  process.exit(1);
});

import { deduplicate } from "./dedupe.js";
import { exportSqlite } from "./export.js";
import { importToPostgres } from "./import.js";

const command = process.argv[2];

async function main() {
  switch (command) {
    case "export": {
      const dbPath = process.argv[3] || "./meridian.db";
      const outputPath = process.argv[4] || "./export.json";
      await exportSqlite(dbPath, outputPath);
      break;
    }

    case "import": {
      const inputPath = process.argv[3] || "./export.json";
      const dbUrl = process.argv[4] || process.env.DATABASE_URL;
      if (!dbUrl) {
        console.error("Error: DATABASE_URL not set and no URL provided");
        process.exit(1);
      }
      const data = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
      await importToPostgres(data, dbUrl);
      break;
    }

    case "dedupe": {
      const inputPath1 = process.argv[3];
      const inputPath2 = process.argv[4];
      const outputPath = process.argv[5] || "./merged.json";

      if (!inputPath1 || !inputPath2) {
        console.error("Usage: pnpm db:dedupe <file1.json> <file2.json> [output.json]");
        process.exit(1);
      }

      const data1 = JSON.parse(fs.readFileSync(inputPath1, "utf-8"));
      const data2 = JSON.parse(fs.readFileSync(inputPath2, "utf-8"));

      const merged: typeof data1 = {
        lessons: [...data1.lessons, ...data2.lessons],
        performance: [...data1.performance, ...data2.performance],
        pools: [...data1.pools, ...data2.pools],
        positions: [...data1.positions, ...data2.positions],
        positionSnapshots: [...data1.positionSnapshots, ...data2.positionSnapshots],
        positionEvents: [...data1.positionEvents, ...data2.positionEvents],
        signalWeights: [...data1.signalWeights, ...data2.signalWeights],
        poolDeploys: [...data1.poolDeploys, ...data2.poolDeploys],
        exportedAt: new Date().toISOString(),
        source: `merged: ${inputPath1}, ${inputPath2}`,
      };

      const deduped = deduplicate(merged);
      fs.writeFileSync(outputPath, JSON.stringify(deduped, null, 2));
      console.log(`Deduplicated data written to: ${outputPath}`);
      console.log(`Lessons: ${merged.lessons.length} → ${deduped.lessons.length}`);
      console.log(`Performance: ${merged.performance.length} → ${deduped.performance.length}`);
      console.log(`Pools: ${merged.pools.length} → ${deduped.pools.length}`);
      break;
    }

    case "migrate": {
      const dbPath = process.argv[3] || "./meridian.db";
      const dbUrl = process.argv[4] || process.env.DATABASE_URL;

      if (!dbUrl) {
        console.error("Error: DATABASE_URL not set");
        process.exit(1);
      }

      const tempExport = "./migration-temp.json";

      console.log("Step 1: Exporting SQLite...");
      await exportSqlite(dbPath, tempExport);

      console.log("Step 2: Importing to Postgres...");
      const data = JSON.parse(fs.readFileSync(tempExport, "utf-8"));
      await importToPostgres(data, dbUrl);

      fs.unlinkSync(tempExport);

      console.log("Migration complete!");
      console.log("You can now set DATABASE_URL in your .env and restart the application.");
      break;
    }

    case "reset": {
      const dbUrl = process.argv[3] || process.env.DATABASE_URL;

      if (!dbUrl) {
        console.error("Error: DATABASE_URL not set");
        process.exit(1);
      }

      console.log("WARNING: This will drop ALL tables in the database.");
      console.log("Database:", dbUrl.replace(/:.*@/, ":***@")); // Hide password
      
      const { createDatabase } = await import("../index.js");
      const db = await createDatabase({ backend: "postgres", url: dbUrl });

      try {
        console.log("\nDropping all tables...");
        await db.run(`
          DROP TABLE IF EXISTS portfolio_history CASCADE;
          DROP TABLE IF EXISTS threshold_history CASCADE;
          DROP TABLE IF EXISTS threshold_suggestions CASCADE;
          DROP TABLE IF EXISTS cycle_state CASCADE;
          DROP TABLE IF EXISTS dev_blocklist CASCADE;
          DROP TABLE IF EXISTS smart_wallets CASCADE;
          DROP TABLE IF EXISTS token_blacklist CASCADE;
          DROP TABLE IF EXISTS active_strategy CASCADE;
          DROP TABLE IF EXISTS strategies CASCADE;
          DROP TABLE IF EXISTS state_metadata CASCADE;
          DROP TABLE IF EXISTS position_state_events CASCADE;
          DROP TABLE IF EXISTS position_state CASCADE;
          DROP TABLE IF EXISTS signal_weight_history CASCADE;
          DROP TABLE IF EXISTS signal_weights CASCADE;
          DROP TABLE IF EXISTS performance CASCADE;
          DROP TABLE IF EXISTS lessons CASCADE;
          DROP TABLE IF EXISTS pool_deploys CASCADE;
          DROP TABLE IF EXISTS pools CASCADE;
          DROP TABLE IF EXISTS position_events CASCADE;
          DROP TABLE IF EXISTS position_snapshots CASCADE;
          DROP TABLE IF EXISTS positions CASCADE;
          DROP TABLE IF EXISTS schema_version CASCADE;
        `);
        console.log("All tables dropped successfully.");
        console.log("\nYou can now re-import your data with: pnpm db:import <file.json> <db-url>");
      } finally {
        await db.close();
      }
      break;
    }

    default:
      console.log("Meridian Database CLI");
      console.log("");
      console.log("Commands:");
      console.log("  export [db-path] [output.json]     Export SQLite to JSON");
      console.log("  import [input.json] [db-url]       Import JSON to Postgres");
      console.log("  dedupe <file1> <file2> [output]    Merge and deduplicate two exports");
      console.log("  migrate [db-path]                  Full SQLite → Postgres migration");
      console.log("  reset [db-url]                     Drop all tables (DANGER)");
      console.log("");
      console.log("Examples:");
      console.log("  pnpm db:export ./meridian.db ./backup.json");
      console.log("  pnpm db:dedupe ./local.json ./vps.json ./merged.json");
      console.log("  DATABASE_URL=postgresql://... pnpm db:migrate");
      console.log("  pnpm db:reset postgresql://...    # Reset database");
      process.exit(1);
  }
}

main().catch((err) => {
  if (err instanceof Error) {
    console.error("Error:", err.message);
    console.error("Stack:", err.stack);
  } else if (typeof err === 'object' && err !== null) {
    console.error("Error object:", JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  } else {
    console.error("Error:", err);
  }
  process.exit(1);
});
