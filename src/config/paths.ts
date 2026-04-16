import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Find project root by looking for package.json marker.
 * Starts from the given directory and walks up until package.json is found.
 */
function findProjectRoot(startDir: string): string {
  let current = startDir;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return startDir;
}

/**
 * Project root directory.
 * Priority: MERIDIAN_ROOT env var > auto-detect via package.json > fallback to __dirname
 */
export const PROJECT_ROOT = process.env.MERIDIAN_ROOT
  ? path.resolve(process.env.MERIDIAN_ROOT)
  : findProjectRoot(__dirname);

export const USER_CONFIG_PATH = path.join(PROJECT_ROOT, "user-config.json");
export const ENV_PATH = path.join(PROJECT_ROOT, ".env");
export const LESSONS_FILE = path.join(PROJECT_ROOT, "lessons.json");
export const POOL_MEMORY_FILE = path.join(PROJECT_ROOT, "pool-memory.json");
export const SMART_WALLETS_FILE = path.join(PROJECT_ROOT, "smart-wallets.json");
export const DB_PATH = path.join(PROJECT_ROOT, "meridian.db");
