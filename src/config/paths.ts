import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// If running from dist/, go up two levels to project root (dist/src → project root)
export const PROJECT_ROOT = __dirname.includes(path.sep + "dist" + path.sep)
  ? path.join(__dirname, "..", "..")
  : __dirname;

export const USER_CONFIG_PATH = path.join(PROJECT_ROOT, "user-config.json");
export const ENV_PATH = path.join(PROJECT_ROOT, ".env");
export const LESSONS_FILE = path.join(PROJECT_ROOT, "lessons.json");
export const POOL_MEMORY_FILE = path.join(PROJECT_ROOT, "pool-memory.json");
export const SMART_WALLETS_FILE = path.join(PROJECT_ROOT, "smart-wallets.json");
