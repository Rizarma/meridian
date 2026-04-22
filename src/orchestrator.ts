// src/orchestrator.ts
// Main entry point — composes submodules and starts the agent

import { config } from "./config/config.js";
import { TIMEOUT } from "./config/constants.js";
import { bootstrapFromPortfolio } from "./domain/portfolio-sync.js";
import { cycleState } from "./infrastructure/cycle-state.js";
import { setupDatabase } from "./infrastructure/db-migrations.js";
import { bootstrapSync } from "./infrastructure/hive-mind.js";
import { log } from "./infrastructure/logger.js";
// Orchestrator submodules
import { maybeRunMissedBriefing } from "./orchestrator/briefing.js";
import {
  registerCronAutoRestart,
  runManagementCycle,
  runScreeningCycle,
  startCronJobs,
  stopCronJobs,
} from "./orchestrator/cron-manager.js";
import {
  registerShutdownHandlers,
  registerStopCronJobs,
  shutdown,
} from "./orchestrator/shutdown.js";
import { isManagementBusy, setCronStarted } from "./orchestrator/state-accessors.js";
import { startNonTTY, startREPL } from "./repl.js";
import { logStartupValidation, runStartupValidation } from "./utils/service-validation.js";

export { maybeRunMissedBriefing } from "./orchestrator/briefing.js";
// Re-export for backward compatibility (cli.ts dynamic imports)
export {
  runManagementCycle,
  runScreeningCycle,
  startCronJobs,
  stopCronJobs,
} from "./orchestrator/cron-manager.js";
export { shutdown } from "./orchestrator/shutdown.js";
export { getTimers, isManagementBusy, setManagementBusy } from "./orchestrator/state-accessors.js";

// ═══════════════════════════════════════════
//  SANITIZATION HELPERS
// ═══════════════════════════════════════════

/**
 * Sanitize a model name to prevent potential API key leakage in logs.
 * If the model string looks like an API key (contains "sk-" or is very long),
 * mask it and only show the last 4 characters.
 */
function sanitizeModelName(model: string): string {
  if (!model) return model;
  // If it looks like an API key (contains "sk-" or is longer than 40 chars), mask it
  if (model.includes("sk-") || model.length > 40) {
    const last4 = model.slice(-4);
    return `${model.slice(0, 8)}...${last4}`;
  }
  return model;
}

// ═══════════════════════════════════════════
//  WIRING
// ═══════════════════════════════════════════

// Wire shutdown module to cron-manager's stopCronJobs
registerStopCronJobs(stopCronJobs);

// Register shutdown signal handlers
registerShutdownHandlers();

// Register cron restarter — when update_config changes intervals, running cron jobs get replaced
registerCronAutoRestart();

// ═══════════════════════════════════════════
//  MAIN ENTRY POINT
// ═══════════════════════════════════════════
function launchCron(): void {
  if (!cycleState.isCronStarted()) {
    cycleState.setCronStarted(true);
    // Seed timers so countdown starts from now
    cycleState.getTimers().managementLastRun = Date.now();
    cycleState.getTimers().screeningLastRun = Date.now();
    startCronJobs();
  }
}

export async function start(): Promise<void> {
  // Initialize database schema first (creates tables if they don't exist)
  const dbSetup = setupDatabase();
  if (!dbSetup.success) {
    log("startup_error", `Database setup failed: ${dbSetup.message}`);
    throw new Error(dbSetup.message);
  } else {
    log("startup", dbSetup.message);
  }

  // Run service validation first
  const validationResult = await runStartupValidation();
  logStartupValidation(validationResult);

  // Warn if critical services are down
  if (!validationResult.allCriticalHealthy) {
    log("startup_warn", "Some critical services are unhealthy — agent may not function correctly");
    // Small delay so user can see the warning
    await new Promise((resolve) => setTimeout(resolve, TIMEOUT.STARTUP_WARN_MS));
  }

  // Hive Mind bootstrap sync — non-blocking, fail-open
  bootstrapSync();

  // Portfolio Sync bootstrap — opt-in, only when enabled and few lessons
  if (config.portfolioSync.enabled) {
    const walletKey = process.env.WALLET_PRIVATE_KEY;
    if (walletKey) {
      try {
        // Dynamic import to avoid circular deps and to only load bs58/web3 when needed
        const { getWallet } = await import("./utils/wallet.js");
        const wallet = getWallet();
        const walletAddress = wallet.publicKey.toString();

        // Count existing lessons to decide if bootstrap is useful
        const { query } = await import("./infrastructure/db.js");
        const lessonRows = query<{ count: number }>("SELECT COUNT(*) as count FROM lessons");
        const lessonCount = lessonRows[0]?.count ?? 0;

        if (lessonCount < 5) {
          await bootstrapFromPortfolio(walletAddress, config.portfolioSync);
        } else {
          log("portfolio_sync", `Skipping bootstrap — already have ${lessonCount} lessons`);
        }
      } catch (err) {
        log(
          "portfolio_sync_warn",
          `Portfolio bootstrap skipped: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // Start REPL or non-TTY mode
  const isTTY = process.stdin.isTTY;

  const replDeps = {
    launchCron,
    shutdown,
    timers: cycleState.getTimers(),
    isCronStarted: () => cycleState.isCronStarted(),
    setCronStarted,
    isManagementBusy,
    isScreeningBusy: () => cycleState.isScreeningBusy(),
    runManagementCycle,
    runScreeningCycle,
    startCronJobs,
    stopCronJobs,
    maybeRunMissedBriefing,
  };

  if (isTTY) {
    await startREPL(replDeps);
  } else {
    // Log startup only for non-TTY mode (REPL has its own formatted output)
    log("startup", "DLMM LP Agent starting...");
    log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
    log(
      "startup",
      `Models: general=${sanitizeModelName(config.llm.generalModel)}, screening=${sanitizeModelName(config.llm.screeningModel)}, management=${sanitizeModelName(config.llm.managementModel)}`
    );
    await startNonTTY(replDeps);
  }
}
