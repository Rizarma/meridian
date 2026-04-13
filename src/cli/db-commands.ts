/**
 * Database CLI commands for meridian
 *
 * Provides commands:
 *   meridian db export     - Export all tables to JSON
 *   meridian db import     - Import from JSON file
 *   meridian db backup     - Create timestamped backup
 *   meridian db reset      - Reset database (with confirmation)
 *   meridian db list       - List available backups
 *   meridian db validate   - Validate JSON import file
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  exportPositionsToJson,
  exportPoolsToJson,
  exportLessonsToJson,
  exportAllToJson,
  exportToLegacyFormat,
  importPositionsFromJson,
  importPoolsFromJson,
  importLessonsFromJson,
  validateImportData,
  resetDatabase,
  listBackups,
  type ExportResult,
  type ImportResult,
  type BackupResult,
} from "../infrastructure/db-backup.js";
import { PROJECT_ROOT } from "../config/paths.js";

// ─── Output Helpers ──────────────────────────────────────────────

function out(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function die(msg: string, extra: Record<string, unknown> = {}): never {
  process.stderr.write(`${JSON.stringify({ error: msg, ...extra })}\n`);
  process.exit(1);
}

function log(msg: string): void {
  process.stderr.write(`[meridian db] ${msg}\n`);
}

// ─── Command Handlers ────────────────────────────────────────────

/**
 * Handle `meridian db export` command
 */
export async function handleExport(sub2: string | undefined, args: string[]): Promise<void> {
  const type = sub2 || "all";
  const outputPath = args.find((a) => !a.startsWith("-") && a !== "export" && a !== type);

  let result: ExportResult | BackupResult;

  switch (type) {
    case "positions": {
      log("Exporting positions...");
      result = exportPositionsToJson(outputPath);
      break;
    }
    case "pools": {
      log("Exporting pools...");
      result = exportPoolsToJson(outputPath);
      break;
    }
    case "lessons": {
      log("Exporting lessons...");
      result = exportLessonsToJson(outputPath);
      break;
    }
    case "legacy": {
      log("Exporting in legacy format...");
      result = exportToLegacyFormat(outputPath);
      break;
    }
    case "all":
    default: {
      log("Creating full backup...");
      result = exportAllToJson();
      break;
    }
  }

  if (result.success) {
    out(result);
  } else {
    die(result.message);
  }
}

/**
 * Handle `meridian db import` command
 */
export async function handleImport(sub2: string | undefined, args: string[]): Promise<void> {
  const type = sub2;
  const filePath = args.find((a) => !a.startsWith("-") && a !== "import" && a !== type);

  if (!type) {
    die(
      "Usage: meridian db import <type> <file> [--validate-only]\nTypes: positions, pools, lessons"
    );
  }

  if (!filePath) {
    die(`Usage: meridian db import ${type} <file>`);
  }

  if (!fs.existsSync(filePath)) {
    die(`File not found: ${filePath}`);
  }

  const validateOnly = args.includes("--validate-only");
  const skipInvalid = !args.includes("--strict");

  let result: ImportResult;

  switch (type) {
    case "positions": {
      log(`Importing positions from ${filePath}...`);
      result = importPositionsFromJson(path.resolve(filePath), {
        validateOnly,
        skipInvalid,
      });
      break;
    }
    case "pools": {
      log(`Importing pools from ${filePath}...`);
      result = importPoolsFromJson(path.resolve(filePath), {
        validateOnly,
        skipInvalid,
      });
      break;
    }
    case "lessons": {
      log(`Importing lessons from ${filePath}...`);
      result = importLessonsFromJson(path.resolve(filePath), {
        validateOnly,
        skipInvalid,
      });
      break;
    }
    default: {
      die(`Unknown import type: ${type}. Use: positions, pools, lessons`);
    }
  }

  if (result.success) {
    out(result);
  } else {
    die(result.message, { errors: result.errors });
  }
}

/**
 * Handle `meridian db backup` command
 */
export async function handleBackup(): Promise<void> {
  log("Creating timestamped backup...");
  const result = exportAllToJson();

  if (result.success) {
    out(result);
  } else {
    die(result.message);
  }
}

/**
 * Handle `meridian db reset` command
 */
export async function handleReset(args: string[]): Promise<void> {
  const force = args.includes("--force") || args.includes("-f");
  const skipConfirm = args.includes("--yes") || args.includes("-y");

  if (!force && !skipConfirm) {
    die(
      "Database reset requires --force flag or confirmation.\n" +
        "This will DELETE ALL DATA. Use: meridian db reset --force or meridian db reset --yes"
    );
  }

  if (force) {
    // Immediate reset with force flag
    log("Resetting database (force mode)...");
    const result = resetDatabase(true);

    if (result.success) {
      out(result);
    } else {
      die(result.message);
    }
    return;
  }

  // Interactive confirmation
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(
      "WARNING: This will DELETE ALL DATA in the database.\n" + "Type 'RESET' to confirm: ",
      (ans) => {
        rl.close();
        resolve(ans.trim());
      }
    );
  });

  if (answer !== "RESET") {
    out({ cancelled: true, message: "Database reset cancelled" });
    return;
  }

  log("Resetting database...");
  const result = resetDatabase(true);

  if (result.success) {
    out(result);
  } else {
    die(result.message);
  }
}

/**
 * Handle `meridian db list` command
 */
export async function handleList(): Promise<void> {
  const { backups } = listBackups();
  out({
    count: backups.length,
    backups: backups.map((b) => ({
      name: b.name,
      created_at: b.created_at,
      files: b.files,
    })),
  });
}

/**
 * Handle `meridian db validate` command
 */
export async function handleValidate(sub2: string | undefined, args: string[]): Promise<void> {
  const type = sub2;
  const filePath = args.find((a) => !a.startsWith("-") && a !== "validate" && a !== type);

  if (!type) {
    die("Usage: meridian db validate <type> <file>\nTypes: positions, pools, lessons");
  }

  if (!filePath) {
    die(`Usage: meridian db validate ${type} <file>`);
  }

  if (!fs.existsSync(filePath)) {
    die(`File not found: ${filePath}`);
  }

  if (!["positions", "pools", "lessons"].includes(type)) {
    die(`Unknown type: ${type}. Use: positions, pools, lessons`);
  }

  log(`Validating ${filePath} as ${type}...`);

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(content);
    const validation = validateImportData(data, type as "positions" | "pools" | "lessons");

    out({
      valid: validation.valid,
      file: filePath,
      type,
      errors: validation.errors,
      warnings: validation.warnings,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    die(`Validation failed: ${msg}`);
  }
}

/**
 * Handle `meridian db restore` command
 */
export async function handleRestore(args: string[]): Promise<void> {
  const backupName = args.find((a) => !a.startsWith("-") && a !== "restore");

  if (!backupName) {
    // List available backups
    const { backups } = listBackups();
    if (backups.length === 0) {
      die("No backups found. Create a backup first with: meridian db backup");
    }

    out({
      message: "Available backups (use: meridian db restore <name>)",
      backups: backups.slice(0, 10).map((b) => ({
        name: b.name,
        created_at: b.created_at,
        files: b.files,
      })),
    });
    return;
  }

  const backupDir = path.join(PROJECT_ROOT, "backups", backupName);

  if (!fs.existsSync(backupDir)) {
    die(`Backup not found: ${backupName}`);
  }

  const force = args.includes("--force") || args.includes("-f");
  const skipConfirm = args.includes("--yes") || args.includes("-y");

  if (!force && !skipConfirm) {
    die(
      `Restoring from backup will REPLACE current data.\n` +
        `Use: meridian db restore ${backupName} --force or --yes`
    );
  }

  log(`Restoring from backup: ${backupName}...`);

  // First reset the database
  const resetResult = resetDatabase(true);
  if (!resetResult.success) {
    die(`Failed to reset database: ${resetResult.message}`);
  }

  const results: Record<string, ImportResult> = {};

  // Import each file if it exists
  const manifestPath = path.join(backupDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    log(`Restoring backup from ${manifest.backup_timestamp}...`);
  }

  const positionsPath = path.join(backupDir, "positions.json");
  if (fs.existsSync(positionsPath)) {
    log("Restoring positions...");
    results.positions = importPositionsFromJson(positionsPath, { skipInvalid: true });
  }

  const poolsPath = path.join(backupDir, "pools.json");
  if (fs.existsSync(poolsPath)) {
    log("Restoring pools...");
    results.pools = importPoolsFromJson(poolsPath, { skipInvalid: true });
  }

  const lessonsPath = path.join(backupDir, "lessons.json");
  if (fs.existsSync(lessonsPath)) {
    log("Restoring lessons...");
    results.lessons = importLessonsFromJson(lessonsPath, { skipInvalid: true });
  }

  out({
    success: true,
    backup: backupName,
    restored: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [
        k,
        { imported: v.imported, skipped: v.skipped, success: v.success },
      ])
    ),
  });
}

// ─── Main Handler ────────────────────────────────────────────────

export async function handleDbCommand(
  subcommand: string | undefined,
  sub2: string | undefined,
  args: string[]
): Promise<void> {
  switch (subcommand) {
    case "export":
      await handleExport(sub2, args);
      break;
    case "import":
      await handleImport(sub2, args);
      break;
    case "backup":
      await handleBackup();
      break;
    case "reset":
      await handleReset(args);
      break;
    case "list":
      await handleList();
      break;
    case "validate":
      await handleValidate(sub2, args);
      break;
    case "restore":
      await handleRestore(args);
      break;
    default:
      die(
        `Unknown db subcommand: ${subcommand}.\n\n` +
          "Available commands:\n" +
          "  meridian db export [positions|pools|lessons|all|legacy] [outputPath]\n" +
          "  meridian db import <type> <file> [--validate-only] [--strict]\n" +
          "  meridian db backup\n" +
          "  meridian db reset [--force|--yes]\n" +
          "  meridian db list\n" +
          "  meridian db validate <type> <file>\n" +
          "  meridian db restore [backupName] [--force|--yes]"
      );
  }
}
