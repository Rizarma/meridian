/**
 * Admin Tools
 *
 * System-level administrative tools for agent management.
 */

import { execSync, spawn } from "node:child_process";
import { error, success } from "../src/types/result.js";
import { registerTool } from "./registry.js";

// ═══════════════════════════════════════════════════════════════════════════
// Tool Registrations
// ═══════════════════════════════════════════════════════════════════════════

registerTool({
  name: "self_update",
  handler: async () => {
    try {
      const result = execSync("git pull", {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim();
      if (result.includes("Already up to date")) {
        return success({
          updated: false,
          message: "Already up to date — no restart needed.",
        });
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return success({
        updated: true,
        message: `Updated! Restarting in 3s...\n${result}`,
      });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      return error(errorMsg, { code: "SELF_UPDATE_FAILED" });
    }
  },
  roles: ["GENERAL"],
  isWriteTool: true, // Protected by safety check
});
