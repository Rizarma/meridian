/**
 * Tool Discovery Module
 *
 * Automatically discovers and imports all tool modules in the tools/ directory
 * AND explicitly imports root-level tool files that contain registrations.
 *
 * Phase 2: "Drop in a new tool with no central edits"
 * - New tool files added to tools/ are auto-discovered at startup
 * - Tools register themselves via side-effect imports
 */

import { readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, "..");

/**
 * Files to skip during discovery (core infrastructure, not tools)
 * These files provide the registration system but don't register tools themselves.
 */
const SKIP_FILES = [
  "registry.js",
  "middleware.js",
  "executor.js",
  "definitions.js",
  "discover.js", // self
];

/**
 * Root-level files containing tool registrations.
 * These are outside the tools/ directory and must be explicitly imported.
 */
const ROOT_TOOL_FILES = [
  "smart-wallets.js",
  "strategy-library.js",
  "pool-memory.js",
  "token-blacklist.js",
  "dev-blocklist.js",
  "lessons.js",
  "state.js",
  "config.js",
];

/**
 * Discovers and dynamically imports all tool modules.
 * - Scans tools/ directory for auto-discovery
 * - Explicitly imports root-level tool files
 * Runs at module load time to trigger side-effect registrations.
 */
export async function discoverTools(): Promise<void> {
  // 1. Auto-discover tools in tools/ directory
  const toolFiles = readdirSync(__dirname).filter(
    (f) => f.endsWith(".js") && !SKIP_FILES.includes(f)
  );

  for (const file of toolFiles) {
    try {
      const filePath = pathToFileURL(join(__dirname, file)).href;
      await import(filePath);
    } catch (error) {
      console.error(`[discover] Failed to import tools/${file}:`, (error as Error).message);
    }
  }

  // 2. Explicitly import root-level tool files
  for (const file of ROOT_TOOL_FILES) {
    try {
      const filePath = pathToFileURL(join(ROOT_DIR, file)).href;
      await import(filePath);
    } catch (error) {
      console.error(`[discover] Failed to import ${file}:`, (error as Error).message);
    }
  }
}

// Auto-run at module load
await discoverTools();
