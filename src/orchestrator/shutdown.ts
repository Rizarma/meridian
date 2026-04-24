// src/orchestrator/shutdown.ts
// Graceful shutdown logic and signal handlers

import { getMyPositions, stopPoolCache } from "../../tools/dlmm.js";
import { TIMEOUT } from "../config/constants.js";
import { closeInfrastructure } from "../di-container.js";
import { destroyConsensusCache } from "../infrastructure/hive-mind.js";
import { closeLogStreams, log } from "../infrastructure/logger.js";
import { stopPolling } from "../infrastructure/telegram.js";
import { cache } from "../utils/cache.js";
import { getErrorMessage } from "../utils/errors.js";

const SHUTDOWN_TIMEOUT_MS = TIMEOUT.SHUTDOWN_MS;

// Forward reference — will be set by the main orchestrator module
let _stopCronJobs: () => void = () => {};

export function registerStopCronJobs(fn: () => void): void {
  _stopCronJobs = fn;
}

export async function shutdown(signal: string): Promise<void> {
  log("shutdown", `Received ${signal}. Shutting down gracefully...`);

  // Create a timeout promise
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Shutdown timeout")), SHUTDOWN_TIMEOUT_MS);
  });

  try {
    // Race cleanup against timeout
    await Promise.race([
      (async () => {
        stopPolling();
        _stopCronJobs();
        stopPoolCache();
        destroyConsensusCache();
        cache.destroy();

        // Get final positions state
        const positionsResult = await getMyPositions();
        log("shutdown", `Open positions at shutdown: ${positionsResult.total_positions ?? 0}`);

        // Close log streams properly
        closeLogStreams();
        await closeInfrastructure();

        // Small delay to let final logs flush
        await new Promise((resolve) => setTimeout(resolve, TIMEOUT.LOG_FLUSH_MS));
      })(),
      timeoutPromise,
    ]);

    log("shutdown", "Graceful shutdown completed");
  } catch (error) {
    log("shutdown", `Shutdown error or timeout: ${getErrorMessage(error)}`);
  } finally {
    process.exit(0);
  }
}

export function registerShutdownHandlers(): void {
  process.on("SIGINT", async () => {
    await shutdown("SIGINT");
  });
  process.on("SIGTERM", async () => {
    await shutdown("SIGTERM");
  });
}
