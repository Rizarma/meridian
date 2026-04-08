import * as cron from "node-cron";
import { getMyPositions, stopPoolCache } from "../tools/dlmm.js";
import { agentLoop } from "./agent/agent.js";
import { config, registerCronRestarter } from "./config/config.js";
import {
  runManagementCycle as runManagementCycleImpl,
  schedulePeakConfirmation,
  scheduleTrailingDropConfirmation,
} from "./cycles/management.js";
import {
  getScreeningLastTriggered,
  isScreeningBusy,
  runScreeningCycle as runScreeningCycleImpl,
  setScreeningLastTriggered,
} from "./cycles/screening.js";
import { generateBriefing } from "./infrastructure/briefing.js";
import { closeLogStreams, log } from "./infrastructure/logger.js";
import {
  getLastBriefingDate,
  getTrackedPosition,
  queuePeakConfirmation,
  queueTrailingDropConfirmation,
  setLastBriefingDate,
  updatePnlAndCheckExits,
} from "./infrastructure/state.js";
import { sendHTML, stopPolling, isEnabled as telegramEnabled } from "./infrastructure/telegram.js";
import { startNonTTY, startREPL } from "./repl.js";
import type { CronTaskList, CycleOptions, CycleTimers } from "./types/index.js";
import { cache } from "./utils/cache.js";
import { getErrorMessage } from "./utils/errors.js";
import { recordActivity } from "./utils/health-check.js";
import { isArray } from "./utils/validation.js";

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
//  GLOBAL STATE
// ═══════════════════════════════════════════
let _cronTasks: CronTaskList = [];
let _pnlPollInterval: NodeJS.Timeout | undefined;
let _managementBusy = false;
let _pollTriggeredAt = 0;
let cronStarted = false;

const timers: CycleTimers = {
  managementLastRun: null,
  screeningLastRun: null,
};

// ═══════════════════════════════════════════
//  STATE ACCESSORS
// ═══════════════════════════════════════════
export function isManagementBusy(): boolean {
  return _managementBusy;
}

export function setManagementBusy(busy: boolean): void {
  _managementBusy = busy;
}

export function getTimers(): CycleTimers {
  return timers;
}

function setCronStarted(started: boolean): void {
  cronStarted = started;
}

// ═══════════════════════════════════════════
//  BRIEFING FUNCTIONS
// ═══════════════════════════════════════════
async function runBriefing(): Promise<void> {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${getErrorMessage(error)}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
export async function maybeRunMissedBriefing(): Promise<void> {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

// ═══════════════════════════════════════════
//  CRON JOB MANAGEMENT
// ═══════════════════════════════════════════
export function stopCronJobs(): void {
  for (const task of _cronTasks) task.stop();
  if (_pnlPollInterval) clearInterval(_pnlPollInterval);
  _cronTasks = [];
  _pnlPollInterval = undefined;
}

export async function runManagementCycle(options: CycleOptions = {}): Promise<string | null> {
  const screeningCooldownMs = 5 * 60 * 1000;
  const result = await runManagementCycleImpl(options, {
    timers,
    setManagementBusy: (busy: boolean) => {
      _managementBusy = busy;
    },
    isManagementBusy: () => _managementBusy,
    triggerScreening: async (positionCount?: number): Promise<void> => {
      const afterCount =
        positionCount ??
        (await getMyPositions({ force: true }).catch((): null => null))?.positions?.length ??
        0;
      if (
        afterCount < config.risk.maxPositions &&
        Date.now() - getScreeningLastTriggered() > screeningCooldownMs
      ) {
        await runScreeningCycle();
      }
    },
    triggerScreeningImmediate: async () => {
      await runScreeningCycle();
    },
    triggerManagement: async () => {
      await runManagementCycle({ silent: true });
    },
  });
  recordActivity();
  return result;
}

export async function runScreeningCycle(options: CycleOptions = {}): Promise<string | null> {
  return runScreeningCycleImpl(options, {
    timers,
    isScreeningBusy,
    getScreeningLastTriggered,
    setScreeningLastTriggered,
  });
}

export function startCronJobs(): void {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(
    `*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`,
    async () => {
      if (_managementBusy) return;
      timers.managementLastRun = Date.now();
      await runManagementCycle();
    }
  );

  const screenTask = cron.schedule(
    `*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`,
    (): void => {
      void runScreeningCycle();
    }
  );

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(
        `
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `,
        config.llm.maxSteps,
        [],
        "MANAGER"
      );
    } catch (error) {
      log("cron_error", `Health check failed: ${getErrorMessage(error)}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(
    `0 1 * * *`,
    async () => {
      await runBriefing();
    },
    { timezone: "UTC" }
  );

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(
    `0 */6 * * *`,
    async () => {
      await maybeRunMissedBriefing();
    },
    { timezone: "UTC" }
  );

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  let _pnlPollConsecutiveFailures = 0;
  const MAX_PNL_POLL_FAILURES = 5;
  const pnlPollInterval = setInterval(() => {
    (async () => {
      if (_managementBusy || isScreeningBusy() || _pnlPollBusy) return;
      _pnlPollBusy = true;
      try {
        const result = await getMyPositions({ force: true, silent: true }).catch((err): null => {
          log("poll_error", `getMyPositions failed: ${getErrorMessage(err)}`);
          _pnlPollConsecutiveFailures++;
          if (_pnlPollConsecutiveFailures >= MAX_PNL_POLL_FAILURES) {
            log("poll_error", "PnL poll failing consistently - backing off");
            // Could disable polling here if needed
          }
          return null;
        });

        if (!result) return; // Early exit on failure

        // Validate positions array before processing
        const rawPositions = result?.positions;
        if (!isArray(rawPositions)) {
          log("poll_error", "Invalid positions response: positions is not an array");
          return;
        }
        if (rawPositions.length === 0) {
          _pnlPollConsecutiveFailures = 0; // Reset on successful empty poll
          return;
        }

        // Process each position with individual error handling
        for (const p of rawPositions) {
          try {
            if (!p.pnl_pct_suspicious && queuePeakConfirmation(p.position, p.pnl_pct)) {
              schedulePeakConfirmation(p.position);
            }
            const trackedP = getTrackedPosition(p.position);
            const exit = updatePnlAndCheckExits(
              p.position,
              p,
              config.management,
              trackedP?.strategy_config
            );
            if (exit) {
              // Trailing TP needs confirmation - queue it and continue polling
              if (exit.action === "TRAILING_TP" && exit.needs_confirmation) {
                if (
                  queueTrailingDropConfirmation(
                    p.position,
                    exit.peak_pnl_pct ?? null,
                    exit.current_pnl_pct ?? null,
                    config.management.trailingDropPct ?? null
                  )
                ) {
                  scheduleTrailingDropConfirmation(p.position, () => {
                    runManagementCycle({ silent: true }).catch((e: Error) =>
                      log("cron_error", `Trailing drop-triggered management failed: ${e.message}`)
                    );
                  });
                }
                continue;
              }
              const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
              const sinceLastTrigger = Date.now() - _pollTriggeredAt;
              if (sinceLastTrigger >= cooldownMs) {
                _pollTriggeredAt = Date.now();
                log(
                  "state",
                  `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`
                );
                runManagementCycle({ silent: true }).catch((e: Error) =>
                  log("cron_error", `Poll-triggered management failed: ${e.message}`)
                );
              } else {
                log(
                  "state",
                  `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round(
                    (cooldownMs - sinceLastTrigger) / 1000
                  )}s left)`
                );
              }
              break;
            }
          } catch (positionError) {
            log(
              "poll_error",
              `Error processing position ${p.position}: ${getErrorMessage(positionError)}`
            );
            // Continue to next position
          }
        }
        // Reset consecutive failures on successful poll completion
        _pnlPollConsecutiveFailures = 0;
        recordActivity();
      } catch (error) {
        log("poll_error", `PnL poll error: ${getErrorMessage(error)}`);
        _pnlPollConsecutiveFailures++;
      } finally {
        _pnlPollBusy = false;
      }
    })().catch((e) => {
      log("poll_error", `Unhandled PnL poll error: ${getErrorMessage(e)}`);
      _pnlPollBusy = false;
    });
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _pnlPollInterval = pnlPollInterval;
  log(
    "cron",
    `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`
  );
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
const SHUTDOWN_TIMEOUT_MS = 5000;

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
        stopCronJobs();
        stopPoolCache();
        cache.destroy();

        // Get final positions state
        const positionsResult = await getMyPositions();
        log("shutdown", `Open positions at shutdown: ${positionsResult.total_positions ?? 0}`);

        // Close log streams properly
        closeLogStreams();

        // Small delay to let final logs flush
        await new Promise((resolve) => setTimeout(resolve, 100));
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

process.on("SIGINT", async () => {
  await shutdown("SIGINT");
});
process.on("SIGTERM", async () => {
  await shutdown("SIGTERM");
});

// ═══════════════════════════════════════════
//  MAIN ENTRY POINT
// ═══════════════════════════════════════════
function launchCron(): void {
  if (!cronStarted) {
    cronStarted = true;
    // Seed timers so countdown starts from now
    timers.managementLastRun = Date.now();
    timers.screeningLastRun = Date.now();
    startCronJobs();
  }
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => {
  if (cronStarted) startCronJobs();
});

export async function start(): Promise<void> {
  // Start REPL or non-TTY mode
  const isTTY = process.stdin.isTTY;

  const replDeps = {
    launchCron,
    shutdown,
    timers,
    isCronStarted: () => cronStarted,
    setCronStarted,
    isManagementBusy,
    isScreeningBusy,
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
