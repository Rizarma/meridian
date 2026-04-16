/**
 * Database backup utilities - JSON export/import for portability and debugging.
 *
 * Provides functions to export/import database tables to/from JSON format
 * with validation, progress logging, and atomic transactions.
 */

import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../config/paths.js";
import { parseJson, query, run, stringifyJson, transaction } from "./db.js";
import { log } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────

export interface ExportOptions {
  pretty?: boolean;
  includeDataJson?: boolean;
}

export interface ImportOptions {
  validateOnly?: boolean;
  skipInvalid?: boolean;
}

export interface ExportResult {
  success: boolean;
  filePath?: string;
  count?: number;
  message: string;
}

export interface ImportResult {
  success: boolean;
  imported?: number;
  skipped?: number;
  errors?: string[];
  message: string;
}

export interface BackupResult {
  success: boolean;
  backupDir?: string;
  files?: string[];
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Utility Functions ───────────────────────────────────────────

/**
 * Generate timestamp string for backup directories (YYYYMMDD-HHMMSS format)
 */
function generateTimestamp(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const minute = String(now.getUTCMinutes()).padStart(2, "0");
  const second = String(now.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

/**
 * Ensure backup directory exists
 */
function ensureBackupDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Write JSON file with optional pretty printing
 */
function writeJsonFile(filePath: string, data: unknown, pretty = true): void {
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  fs.writeFileSync(filePath, json, "utf8");
}

/**
 * Read and parse JSON file
 */
function readJsonFile<T>(filePath: string): T {
  const content = fs.readFileSync(filePath, "utf8");
  return JSON.parse(content) as T;
}

// ─── Export Functions ────────────────────────────────────────────

/**
 * Export all positions to JSON file
 */
export function exportPositionsToJson(
  outputPath?: string,
  options: ExportOptions = {}
): ExportResult {
  try {
    const { pretty = true, includeDataJson = true } = options;

    const positions = query<
      Record<string, unknown> & {
        address: string;
        trailing_state: string | null;
        notes: string | null;
        data_json: string | null;
      }
    >("SELECT * FROM positions ORDER BY deployed_at DESC");

    const exportedPositions = positions.map((p) => {
      const result: Record<string, unknown> = { ...p };

      // Parse JSON columns
      if (p.trailing_state) {
        result.trailing_state = parseJson(p.trailing_state);
      }
      if (p.notes) {
        result.notes = parseJson(p.notes);
      }

      // Include full data_json if requested
      if (includeDataJson && p.data_json) {
        result.parsed_data = parseJson(p.data_json);
      }

      // Remove internal data_json if not explicitly requested
      if (!includeDataJson) {
        delete result.data_json;
      }

      return result;
    });

    const filePath =
      outputPath ||
      path.join(PROJECT_ROOT, "backups", `positions-export-${generateTimestamp()}.json`);
    ensureBackupDir(path.dirname(filePath));

    writeJsonFile(
      filePath,
      {
        exported_at: new Date().toISOString(),
        count: exportedPositions.length,
        positions: exportedPositions,
      },
      pretty
    );

    log("db-backup", `Exported ${exportedPositions.length} positions to ${filePath}`);

    return {
      success: true,
      filePath,
      count: exportedPositions.length,
      message: `Exported ${exportedPositions.length} positions to ${filePath}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("db-backup-error", `Failed to export positions: ${errorMessage}`);
    return {
      success: false,
      message: `Failed to export positions: ${errorMessage}`,
    };
  }
}

/**
 * Export all pools and their deploys to JSON file
 */
export function exportPoolsToJson(outputPath?: string, options: ExportOptions = {}): ExportResult {
  try {
    const { pretty = true, includeDataJson = true } = options;

    const pools = query<
      Record<string, unknown> & {
        address: string;
        data_json: string | null;
      }
    >("SELECT * FROM pools ORDER BY total_deploys DESC, address");

    const exportedPools: Record<string, unknown> = {};

    for (const pool of pools) {
      const poolData: Record<string, unknown> = { ...pool };

      // Get deploys for this pool
      const deploys = query<
        Record<string, unknown> & {
          data_json: string | null;
        }
      >("SELECT * FROM pool_deploys WHERE pool_address = ? ORDER BY deployed_at", pool.address);

      // Get snapshots for this pool
      const snapshots = query<
        Record<string, unknown> & {
          in_range: number;
          data_json: string | null;
        }
      >(
        "SELECT * FROM position_snapshots WHERE position_address LIKE ? ORDER BY ts",
        `${pool.address}%`
      );

      // Get notes for this pool
      const notes = query<
        Record<string, unknown> & {
          data_json: string | null;
        }
      >(
        "SELECT * FROM position_events WHERE position_address = ? AND event_type = 'pool_note' ORDER BY ts",
        pool.address
      );

      // Parse JSON columns
      if (pool.data_json) {
        poolData.parsed_data = parseJson(pool.data_json);
      }

      poolData.deploys = deploys.map((d) => {
        const deploy: Record<string, unknown> = { ...d };
        if (includeDataJson && d.data_json) {
          deploy.parsed_data = parseJson(d.data_json);
        }
        if (!includeDataJson) {
          delete deploy.data_json;
        }
        return deploy;
      });

      poolData.snapshots = snapshots.map((s) => {
        const snapshot: Record<string, unknown> = { ...s };
        snapshot.in_range = s.in_range === 1;
        if (includeDataJson && s.data_json) {
          snapshot.parsed_data = parseJson(s.data_json);
        }
        if (!includeDataJson) {
          delete snapshot.data_json;
        }
        return snapshot;
      });

      poolData.notes = notes.map((n) => {
        const noteData = parseJson<{ note?: string; added_at?: string }>(n.data_json as string);
        return {
          note: noteData?.note,
          added_at: noteData?.added_at || n.ts,
        };
      });

      if (!includeDataJson) {
        delete poolData.data_json;
      }

      exportedPools[pool.address] = poolData;
    }

    const filePath =
      outputPath || path.join(PROJECT_ROOT, "backups", `pools-export-${generateTimestamp()}.json`);
    ensureBackupDir(path.dirname(filePath));

    writeJsonFile(
      filePath,
      {
        exported_at: new Date().toISOString(),
        count: pools.length,
        pools: exportedPools,
      },
      pretty
    );

    log("db-backup", `Exported ${pools.length} pools to ${filePath}`);

    return {
      success: true,
      filePath,
      count: pools.length,
      message: `Exported ${pools.length} pools to ${filePath}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("db-backup-error", `Failed to export pools: ${errorMessage}`);
    return {
      success: false,
      message: `Failed to export pools: ${errorMessage}`,
    };
  }
}

/**
 * Export lessons and performance records to JSON file
 */
export function exportLessonsToJson(
  outputPath?: string,
  options: ExportOptions = {}
): ExportResult {
  try {
    const { pretty = true, includeDataJson = true } = options;

    // Export lessons
    const lessons = query<
      Record<string, unknown> & {
        tags: string;
        data_json: string | null;
      }
    >("SELECT * FROM lessons ORDER BY created_at DESC");

    const exportedLessons = lessons.map((l) => {
      const lesson: Record<string, unknown> = { ...l };
      lesson.tags = parseJson(l.tags) ?? [];
      lesson.pinned = l.pinned === 1 || l.pinned === true;

      if (includeDataJson && l.data_json) {
        lesson.parsed_data = parseJson(l.data_json);
      }
      if (!includeDataJson) {
        delete lesson.data_json;
      }

      return lesson;
    });

    // Export performance records
    const performance = query<
      Record<string, unknown> & {
        bin_range: string | null;
        data_json: string | null;
      }
    >("SELECT * FROM performance ORDER BY recorded_at DESC");

    const exportedPerformance = performance.map((p) => {
      const perf: Record<string, unknown> = { ...p };
      perf.bin_range = parseJson(p.bin_range);

      if (includeDataJson && p.data_json) {
        perf.parsed_data = parseJson(p.data_json);
      }
      if (!includeDataJson) {
        delete perf.data_json;
      }

      return perf;
    });

    const filePath =
      outputPath ||
      path.join(PROJECT_ROOT, "backups", `lessons-export-${generateTimestamp()}.json`);
    ensureBackupDir(path.dirname(filePath));

    writeJsonFile(
      filePath,
      {
        exported_at: new Date().toISOString(),
        lessons_count: exportedLessons.length,
        performance_count: exportedPerformance.length,
        lessons: exportedLessons,
        performance: exportedPerformance,
      },
      pretty
    );

    log(
      "db-backup",
      `Exported ${exportedLessons.length} lessons and ${exportedPerformance.length} performance records to ${filePath}`
    );

    return {
      success: true,
      filePath,
      count: exportedLessons.length + exportedPerformance.length,
      message: `Exported ${exportedLessons.length} lessons and ${exportedPerformance.length} performance records to ${filePath}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("db-backup-error", `Failed to export lessons: ${errorMessage}`);
    return {
      success: false,
      message: `Failed to export lessons: ${errorMessage}`,
    };
  }
}

/**
 * Export signal weights and history to JSON file
 */
export function exportSignalWeightsToJson(
  outputPath?: string,
  options: ExportOptions = {}
): ExportResult {
  try {
    const { pretty = true } = options;

    const weights = query<Record<string, unknown>>("SELECT * FROM signal_weights ORDER BY signal");

    const history = query<Record<string, unknown>>(
      "SELECT * FROM signal_weight_history ORDER BY changed_at DESC"
    );

    const filePath =
      outputPath ||
      path.join(PROJECT_ROOT, "backups", `signal-weights-export-${generateTimestamp()}.json`);
    ensureBackupDir(path.dirname(filePath));

    writeJsonFile(
      filePath,
      {
        exported_at: new Date().toISOString(),
        weights_count: weights.length,
        history_count: history.length,
        weights,
        history,
      },
      pretty
    );

    log(
      "db-backup",
      `Exported ${weights.length} signal weights and ${history.length} history entries to ${filePath}`
    );

    return {
      success: true,
      filePath,
      count: weights.length + history.length,
      message: `Exported ${weights.length} signal weights and ${history.length} history entries to ${filePath}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("db-backup-error", `Failed to export signal weights: ${errorMessage}`);
    return {
      success: false,
      message: `Failed to export signal weights: ${errorMessage}`,
    };
  }
}

/**
 * Export everything to a timestamped backup directory
 */
export function exportAllToJson(): BackupResult {
  try {
    const timestamp = generateTimestamp();
    const backupDir = path.join(PROJECT_ROOT, "backups", timestamp);
    ensureBackupDir(backupDir);

    const files: string[] = [];

    // Export positions
    const positionsResult = exportPositionsToJson(path.join(backupDir, "positions.json"));
    if (positionsResult.success && positionsResult.filePath) {
      files.push(positionsResult.filePath);
    }

    // Export pools
    const poolsResult = exportPoolsToJson(path.join(backupDir, "pools.json"));
    if (poolsResult.success && poolsResult.filePath) {
      files.push(poolsResult.filePath);
    }

    // Export lessons
    const lessonsResult = exportLessonsToJson(path.join(backupDir, "lessons.json"));
    if (lessonsResult.success && lessonsResult.filePath) {
      files.push(lessonsResult.filePath);
    }

    // Export signal weights
    const weightsResult = exportSignalWeightsToJson(path.join(backupDir, "signal-weights.json"));
    if (weightsResult.success && weightsResult.filePath) {
      files.push(weightsResult.filePath);
    }

    // Create manifest
    const manifest = {
      backup_timestamp: timestamp,
      created_at: new Date().toISOString(),
      files: files.map((f) => path.basename(f)),
      counts: {
        positions: positionsResult.count ?? 0,
        pools: poolsResult.count ?? 0,
        lessons: lessonsResult.count ?? 0,
        signal_weights: weightsResult.count ?? 0,
      },
    };
    writeJsonFile(path.join(backupDir, "manifest.json"), manifest);

    log("db-backup", `Full backup created in ${backupDir}`);

    return {
      success: true,
      backupDir,
      files,
      message: `Full backup created in ${backupDir} with ${files.length} files`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("db-backup-error", `Failed to create full backup: ${errorMessage}`);
    return {
      success: false,
      message: `Failed to create full backup: ${errorMessage}`,
    };
  }
}

/**
 * Export in legacy JSON format (compatible with original lessons.json and pool-memory.json)
 */
export function exportToLegacyFormat(outputDir?: string): BackupResult {
  try {
    const dir = outputDir || path.join(PROJECT_ROOT, "backups", `legacy-${generateTimestamp()}`);
    ensureBackupDir(dir);

    const files: string[] = [];

    // Export lessons in legacy format
    const lessons = query<
      Record<string, unknown> & {
        tags: string;
        data_json: string | null;
      }
    >("SELECT * FROM lessons ORDER BY created_at DESC");

    const performance = query<
      Record<string, unknown> & {
        bin_range: string | null;
        data_json: string | null;
      }
    >("SELECT * FROM performance ORDER BY recorded_at DESC");

    const legacyLessons = {
      lessons: lessons.map((l) => parseJson(l.data_json) ?? l),
      performance: performance.map((p) => parseJson(p.data_json) ?? p),
      exported_at: new Date().toISOString(),
    };

    const lessonsPath = path.join(dir, "lessons.json");
    writeJsonFile(lessonsPath, legacyLessons);
    files.push(lessonsPath);

    // Export pool memory in legacy format
    const pools = query<
      Record<string, unknown> & {
        address: string;
        data_json: string | null;
      }
    >("SELECT * FROM pools");

    const legacyPoolMemory: Record<string, unknown> = {};

    for (const pool of pools) {
      const deploys = query<
        Record<string, unknown> & {
          data_json: string | null;
        }
      >("SELECT * FROM pool_deploys WHERE pool_address = ? ORDER BY deployed_at", pool.address);

      const snapshots = query<
        Record<string, unknown> & {
          in_range: number;
          data_json: string | null;
        }
      >(
        "SELECT * FROM position_snapshots WHERE position_address LIKE ? ORDER BY ts",
        `${pool.address}%`
      );

      const noteEvents = query<
        Record<string, unknown> & {
          data_json: string | null;
        }
      >(
        "SELECT * FROM position_events WHERE position_address = ? AND event_type = 'pool_note' ORDER BY ts",
        pool.address
      );

      legacyPoolMemory[pool.address] = {
        ...(parseJson(pool.data_json) ?? pool),
        deploys: deploys.map((d) => parseJson(d.data_json) ?? d),
        snapshots: snapshots.map((s) => ({
          ...(parseJson(s.data_json) ?? s),
          in_range: s.in_range === 1,
        })),
        notes: noteEvents.map((n) => parseJson(n.data_json) ?? n),
      };
    }

    const poolMemoryPath = path.join(dir, "pool-memory.json");
    writeJsonFile(poolMemoryPath, legacyPoolMemory);
    files.push(poolMemoryPath);

    log("db-backup", `Legacy format backup created in ${dir}`);

    return {
      success: true,
      backupDir: dir,
      files,
      message: `Legacy format backup created in ${dir} with ${files.length} files`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("db-backup-error", `Failed to create legacy backup: ${errorMessage}`);
    return {
      success: false,
      message: `Failed to create legacy backup: ${errorMessage}`,
    };
  }
}

// ─── Import Functions ────────────────────────────────────────────

/**
 * Validate import data structure
 */
export function validateImportData(
  data: unknown,
  type: "positions" | "pools" | "lessons"
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!data || typeof data !== "object") {
    errors.push("Data must be an object");
    return { valid: false, errors, warnings };
  }

  const obj = data as Record<string, unknown>;

  switch (type) {
    case "positions": {
      if (!Array.isArray(obj.positions)) {
        errors.push("Missing or invalid 'positions' array");
      } else {
        if (obj.positions.length === 0) {
          warnings.push("Positions array is empty");
        }
        // Validate first item structure
        const first = obj.positions[0] as Record<string, unknown> | undefined;
        if (first && !first.address && !first.position) {
          warnings.push("Position items may be missing 'address' field");
        }
      }
      break;
    }

    case "pools": {
      if (!obj.pools || typeof obj.pools !== "object") {
        errors.push("Missing or invalid 'pools' object");
      } else {
        const pools = obj.pools as Record<string, unknown>;
        const keys = Object.keys(pools);
        if (keys.length === 0) {
          warnings.push("Pools object is empty");
        }
      }
      break;
    }

    case "lessons": {
      if (!Array.isArray(obj.lessons)) {
        errors.push("Missing or invalid 'lessons' array");
      } else if (obj.lessons.length === 0) {
        warnings.push("Lessons array is empty");
      }
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Import positions from JSON file
 */
export function importPositionsFromJson(
  jsonPath: string,
  options: ImportOptions = {}
): ImportResult {
  try {
    const { validateOnly = false, skipInvalid = true } = options;

    if (!fs.existsSync(jsonPath)) {
      return {
        success: false,
        message: `File not found: ${jsonPath}`,
      };
    }

    const data = readJsonFile<{
      positions?: Array<Record<string, unknown>>;
    }>(jsonPath);

    const validation = validateImportData(data, "positions");
    if (!validation.valid) {
      return {
        success: false,
        errors: validation.errors,
        message: `Validation failed: ${validation.errors.join(", ")}`,
      };
    }

    if (validateOnly) {
      return {
        success: true,
        message: `Validation passed. Found ${data.positions?.length ?? 0} positions.`,
      };
    }

    const positions = data.positions || [];
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    transaction(() => {
      for (const pos of positions) {
        try {
          // Map fields to database schema
          const address = (pos.address as string) || (pos.position as string);
          if (!address) {
            if (skipInvalid) {
              skipped++;
              continue;
            }
            throw new Error("Position missing address");
          }

          // Check if position already exists
          const existing = query<{ count: number }>(
            "SELECT COUNT(*) as count FROM positions WHERE address = ?",
            address
          );
          if (existing[0]?.count > 0) {
            skipped++;
            continue;
          }

          run(
            `INSERT INTO positions (address, pool, pool_name, strategy, deployed_at, closed_at, 
              closed, amount_sol, pnl_pct, pnl_usd, fees_earned_usd, initial_value_usd, 
              final_value_usd, minutes_held, close_reason, trailing_state, notes, data_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            address,
            pos.pool ?? null,
            pos.pool_name ?? pos.pair ?? null,
            pos.strategy ?? "spot",
            pos.deployed_at ?? new Date().toISOString(),
            pos.closed_at ?? null,
            pos.closed === true || pos.closed === 1 ? 1 : 0,
            pos.amount_sol ?? null,
            pos.pnl_pct ?? null,
            pos.pnl_usd ?? null,
            pos.fees_earned_usd ?? pos.total_fees_claimed_usd ?? null,
            pos.initial_value_usd ?? null,
            pos.final_value_usd ?? null,
            pos.minutes_held ?? null,
            pos.close_reason ?? null,
            stringifyJson(pos.trailing_state ?? null),
            stringifyJson(pos.notes ?? []),
            stringifyJson(pos)
          );

          imported++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Position ${pos.address || "unknown"}: ${msg}`);
          if (!skipInvalid) throw err;
          skipped++;
        }
      }
    });

    log("db-backup", `Imported ${imported} positions, skipped ${skipped}`);

    return {
      success: true,
      imported,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      message: `Imported ${imported} positions, skipped ${skipped}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("db-backup-error", `Failed to import positions: ${errorMessage}`);
    return {
      success: false,
      message: `Failed to import positions: ${errorMessage}`,
    };
  }
}

/**
 * Import pools from JSON file
 */
export function importPoolsFromJson(jsonPath: string, options: ImportOptions = {}): ImportResult {
  try {
    const { validateOnly = false, skipInvalid = true } = options;

    if (!fs.existsSync(jsonPath)) {
      return {
        success: false,
        message: `File not found: ${jsonPath}`,
      };
    }

    const data = readJsonFile<{
      pools?: Record<string, Record<string, unknown>>;
    }>(jsonPath);

    const validation = validateImportData(data, "pools");
    if (!validation.valid) {
      return {
        success: false,
        errors: validation.errors,
        message: `Validation failed: ${validation.errors.join(", ")}`,
      };
    }

    if (validateOnly) {
      const poolCount = Object.keys(data.pools || {}).length;
      return {
        success: true,
        message: `Validation passed. Found ${poolCount} pools.`,
      };
    }

    const pools = data.pools || {};
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    transaction(() => {
      for (const [address, poolData] of Object.entries(pools)) {
        try {
          const pool = poolData as Record<string, unknown>;

          // Check if pool already exists
          const existing = query<{ count: number }>(
            "SELECT COUNT(*) as count FROM pools WHERE address = ?",
            address
          );
          if (existing[0]?.count > 0) {
            skipped++;
            continue;
          }

          // Insert pool
          run(
            `INSERT INTO pools (address, name, base_mint, total_deploys, avg_pnl_pct, win_rate,
              adjusted_win_rate, cooldown_until, cooldown_reason, base_mint_cooldown_until,
              base_mint_cooldown_reason, data_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            address,
            pool.name ?? null,
            pool.base_mint ?? null,
            pool.total_deploys ?? 0,
            pool.avg_pnl_pct ?? null,
            pool.win_rate ?? null,
            pool.adjusted_win_rate ?? null,
            pool.cooldown_until ?? null,
            pool.cooldown_reason ?? null,
            pool.base_mint_cooldown_until ?? null,
            pool.base_mint_cooldown_reason ?? null,
            stringifyJson(pool)
          );

          // Import deploys if present
          if (Array.isArray(pool.deploys)) {
            for (const deploy of pool.deploys) {
              const d = deploy as Record<string, unknown>;
              run(
                `INSERT INTO pool_deploys (pool_address, deployed_at, closed_at, pnl_pct, pnl_usd,
                  range_efficiency, minutes_held, close_reason, strategy, volatility_at_deploy, data_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                address,
                d.deployed_at ?? null,
                d.closed_at ?? null,
                d.pnl_pct ?? null,
                d.pnl_usd ?? null,
                d.range_efficiency ?? null,
                d.minutes_held ?? null,
                d.close_reason ?? null,
                d.strategy ?? null,
                d.volatility_at_deploy ?? d.volatility ?? null,
                stringifyJson(d)
              );
            }
          }

          imported++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Pool ${address}: ${msg}`);
          if (!skipInvalid) throw err;
          skipped++;
        }
      }
    });

    log("db-backup", `Imported ${imported} pools, skipped ${skipped}`);

    return {
      success: true,
      imported,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      message: `Imported ${imported} pools, skipped ${skipped}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("db-backup-error", `Failed to import pools: ${errorMessage}`);
    return {
      success: false,
      message: `Failed to import pools: ${errorMessage}`,
    };
  }
}

/**
 * Import lessons from JSON file
 */
export function importLessonsFromJson(jsonPath: string, options: ImportOptions = {}): ImportResult {
  try {
    const { validateOnly = false, skipInvalid = true } = options;

    if (!fs.existsSync(jsonPath)) {
      return {
        success: false,
        message: `File not found: ${jsonPath}`,
      };
    }

    const data = readJsonFile<{
      lessons?: Array<Record<string, unknown>>;
      performance?: Array<Record<string, unknown>>;
    }>(jsonPath);

    const validation = validateImportData(data, "lessons");
    if (!validation.valid) {
      return {
        success: false,
        errors: validation.errors,
        message: `Validation failed: ${validation.errors.join(", ")}`,
      };
    }

    if (validateOnly) {
      return {
        success: true,
        message: `Validation passed. Found ${data.lessons?.length ?? 0} lessons.`,
      };
    }

    const lessons = data.lessons || [];
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    transaction(() => {
      for (const lesson of lessons) {
        try {
          const id = (lesson.id as number) || Date.now() + imported;

          // Check if lesson already exists
          const existing = query<{ count: number }>(
            "SELECT COUNT(*) as count FROM lessons WHERE id = ?",
            id
          );
          if (existing[0]?.count > 0) {
            skipped++;
            continue;
          }

          run(
            `INSERT INTO lessons (id, rule, tags, outcome, context, pool, pnl_pct, 
              range_efficiency, created_at, pinned, role, data_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            lesson.rule ?? "",
            stringifyJson(lesson.tags ?? []),
            lesson.outcome ?? "neutral",
            lesson.context ?? null,
            lesson.pool ?? null,
            lesson.pnl_pct ?? null,
            lesson.range_efficiency ?? null,
            lesson.created_at ?? new Date().toISOString(),
            lesson.pinned === true || lesson.pinned === 1 ? 1 : 0,
            lesson.role ?? null,
            stringifyJson(lesson)
          );

          imported++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Lesson ${lesson.id || "unknown"}: ${msg}`);
          if (!skipInvalid) throw err;
          skipped++;
        }
      }

      // Import performance records if present
      if (Array.isArray(data.performance)) {
        for (const perf of data.performance) {
          try {
            run(
              `INSERT INTO performance (position, pool, pool_name, strategy, amount_sol, pnl_pct,
                pnl_usd, fees_earned_usd, initial_value_usd, final_value_usd, minutes_held,
                minutes_in_range, range_efficiency, close_reason, base_mint, bin_step,
                volatility, fee_tvl_ratio, organic_score, bin_range, recorded_at, data_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              perf.position ?? null,
              perf.pool ?? null,
              perf.pool_name ?? null,
              perf.strategy ?? null,
              perf.amount_sol ?? null,
              perf.pnl_pct ?? null,
              perf.pnl_usd ?? null,
              perf.fees_earned_usd ?? null,
              perf.initial_value_usd ?? null,
              perf.final_value_usd ?? null,
              perf.minutes_held ?? null,
              perf.minutes_in_range ?? null,
              perf.range_efficiency ?? null,
              perf.close_reason ?? null,
              perf.base_mint ?? null,
              perf.bin_step ?? null,
              perf.volatility ?? null,
              perf.fee_tvl_ratio ?? null,
              perf.organic_score ?? null,
              stringifyJson(perf.bin_range ?? null),
              perf.recorded_at ?? new Date().toISOString(),
              stringifyJson(perf)
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Performance ${perf.position || "unknown"}: ${msg}`);
            if (!skipInvalid) throw err;
          }
        }
      }
    });

    log("db-backup", `Imported ${imported} lessons, skipped ${skipped}`);

    return {
      success: true,
      imported,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      message: `Imported ${imported} lessons, skipped ${skipped}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("db-backup-error", `Failed to import lessons: ${errorMessage}`);
    return {
      success: false,
      message: `Failed to import lessons: ${errorMessage}`,
    };
  }
}

// ─── Database Reset ──────────────────────────────────────────────

/**
 * Reset database - clear all data with confirmation
 */
export function resetDatabase(confirm: boolean = false): {
  success: boolean;
  message: string;
  cleared?: Record<string, number>;
} {
  if (!confirm) {
    return {
      success: false,
      message: "Database reset requires explicit confirmation. Use resetDatabase(true).",
    };
  }

  try {
    const cleared: Record<string, number> = {};

    transaction(() => {
      // Clear in reverse dependency order
      const tables = [
        "position_events",
        "position_snapshots",
        "pool_deploys",
        "performance",
        "lessons",
        "signal_weight_history",
        "signal_weights",
        "positions",
        "pools",
      ];

      for (const table of tables) {
        const result = run(`DELETE FROM ${table}`);
        cleared[table] = result.changes;
      }
    });

    log("db-backup-warn", "Database reset complete");

    return {
      success: true,
      message: "Database reset complete. All data cleared.",
      cleared,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("db-backup-error", `Database reset failed: ${errorMessage}`);
    return {
      success: false,
      message: `Database reset failed: ${errorMessage}`,
    };
  }
}

// ─── List Backups ────────────────────────────────────────────────

/**
 * List available backups
 */
export function listBackups(): {
  backups: Array<{
    name: string;
    path: string;
    created_at: string;
    files: string[];
  }>;
} {
  const backupsDir = path.join(PROJECT_ROOT, "backups");

  if (!fs.existsSync(backupsDir)) {
    return { backups: [] };
  }

  const entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  const backups: Array<{
    name: string;
    path: string;
    created_at: string;
    files: string[];
  }> = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const backupPath = path.join(backupsDir, entry.name);
      const files = fs.readdirSync(backupPath).filter((f) => f.endsWith(".json"));

      // Try to parse timestamp from name
      let createdAt = new Date().toISOString();
      const match = entry.name.match(/^(\d{8})-(\d{6})$/);
      if (match) {
        const [, date, time] = match;
        const year = date.slice(0, 4);
        const month = date.slice(4, 6);
        const day = date.slice(6, 8);
        const hour = time.slice(0, 2);
        const minute = time.slice(2, 4);
        const second = time.slice(4, 6);
        createdAt = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
      }

      backups.push({
        name: entry.name,
        path: backupPath,
        created_at: createdAt,
        files,
      });
    }
  }

  // Sort by creation date (newest first)
  backups.sort((a, b) => b.created_at.localeCompare(a.created_at));

  return { backups };
}
