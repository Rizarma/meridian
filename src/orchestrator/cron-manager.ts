// src/orchestrator/cron-manager.ts
// Cron job scheduling, PnL polling, and cycle triggering

import * as cron from "node-cron";
import { getMyPositions } from "../../tools/dlmm.js";
import { agentLoop } from "../agent/agent.js";
import { config, registerCronRestarter } from "../config/config.js";
import { CYCLE, HIVE_MIND, RETRY, TIME } from "../config/constants.js";
import {
  runManagementCycle as runManagementCycleImpl,
  schedulePeakConfirmation,
  scheduleTrailingDropConfirmation,
} from "../cycles/management.js";
import { runScreeningCycle as runScreeningCycleImpl } from "../cycles/screening.js";
import { syncPoolPortfolio } from "../domain/portfolio-sync.js";
import { cycleState } from "../infrastructure/cycle-state.js";
import { heartbeat as hiveHeartbeat } from "../infrastructure/hive-mind.js";
import { log } from "../infrastructure/logger.js";
import {
  queuePeakConfirmation,
  queueTrailingDropConfirmation,
  updatePnlAndCheckExits,
} from "../infrastructure/state.js";
import type { CycleOptions } from "../types/index.js";
import { getErrorMessage } from "../utils/errors.js";
import { recordActivity } from "../utils/health-check.js";
import { isArray } from "../utils/validation.js";
import { maybeRunMissedBriefing, runBriefing } from "./briefing.js";

// ═══════════════════════════════════════════
//  CYCLE WRAPPERS
// ═══════════════════════════════════════════

export async function runManagementCycle(options: CycleOptions = {}): Promise<string | null> {
  const screeningCooldownMs = CYCLE.SCREENING_COOLDOWN_MS;
  const result = await runManagementCycleImpl(options, {
    timers: cycleState.getTimers(),
    setManagementBusy: (busy: boolean) => {
      cycleState.setManagementBusy(busy);
    },
    isManagementBusy: () => cycleState.isManagementBusy(),
    triggerScreening: async (positionCount?: number): Promise<void> => {
      const afterCount =
        positionCount ??
        (await getMyPositions({ force: true }).catch((): null => null))?.positions?.length ??
        0;
      if (
        afterCount < config.risk.maxPositions &&
        Date.now() - cycleState.getScreeningLastTriggered() > screeningCooldownMs
      ) {
        await runScreeningCycle({ scheduled: true });
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
    timers: cycleState.getTimers(),
    isScreeningBusy: () => cycleState.isScreeningBusy(),
    getScreeningLastTriggered: () => cycleState.getScreeningLastTriggered(),
    setScreeningLastTriggered: (time: number) => cycleState.setScreeningLastTriggered(time),
  });
}

// ═══════════════════════════════════════════
//  PORTFOLIO SYNC REFRESH
// ═══════════════════════════════════════════

/**
 * Start a background interval that periodically refreshes portfolio data
 * for pools with open positions. Only runs when portfolioSync is enabled
 * and refreshIntervalMinutes > 0.
 *
 * Fail-open: errors are caught and logged, never crash the bot.
 */
export function startPortfolioRefreshCron(): void {
  if (!config.portfolioSync.enabled || config.portfolioSync.refreshIntervalMinutes <= 0) return;

  const intervalMs = config.portfolioSync.refreshIntervalMinutes * 60 * 1000;

  const interval = setInterval(async () => {
    try {
      const { getWallet } = await import("../utils/wallet.js");
      const wallet = getWallet();
      const walletAddress = wallet.publicKey.toString();

      // Get pools with open positions
      const { query } = await import("../infrastructure/db.js");
      const activePools = query<{ pool: string }>(
        "SELECT DISTINCT pool FROM position_state WHERE closed = 0"
      );

      if (activePools.length === 0) return;

      log("portfolio_sync", `Background refresh: syncing ${activePools.length} active pool(s)`);

      for (const { pool } of activePools) {
        try {
          await syncPoolPortfolio(walletAddress, pool);
        } catch (err) {
          log(
            "portfolio_sync_warn",
            `Background refresh failed for pool ${pool.slice(0, 8)}...: ${getErrorMessage(err)}`
          );
        }
      }
    } catch (err) {
      log("portfolio_sync_warn", `Background refresh failed: ${getErrorMessage(err)}`);
    }
  }, intervalMs);

  cycleState.setPortfolioRefreshInterval(interval);

  log(
    "portfolio_sync",
    `Portfolio refresh cron started — every ${config.portfolioSync.refreshIntervalMinutes}m`
  );
}

// ═══════════════════════════════════════════
//  CRON JOB MANAGEMENT
// ═══════════════════════════════════════════

export function stopCronJobs(): void {
  for (const task of cycleState.getCronTasks()) task.stop();
  const pnlPollInterval = cycleState.getPnlPollInterval();
  if (pnlPollInterval) clearInterval(pnlPollInterval);
  const portfolioRefreshInterval = cycleState.getPortfolioRefreshInterval();
  if (portfolioRefreshInterval) clearInterval(portfolioRefreshInterval);
  cycleState.setCronTasks([]);
  cycleState.setPnlPollInterval(undefined);
  cycleState.setPortfolioRefreshInterval(undefined);
}

export function startCronJobs(): void {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(
    `*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`,
    async () => {
      if (cycleState.isManagementBusy()) return;
      cycleState.getTimers().managementLastRun = Date.now();
      await runManagementCycle({ scheduled: true });
    }
  );

  const screenTask = cron.schedule(
    `*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`,
    (): void => {
      // Cross-protection: Screening yields to time-sensitive management
      if (cycleState.isManagementBusy()) {
        log("cron", "Screening skipped — management cycle running");
        return;
      }
      void runScreeningCycle({ scheduled: true });
    }
  );

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (cycleState.isManagementBusy()) return;
    cycleState.setManagementBusy(true);
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
      cycleState.setManagementBusy(false);
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
    `0 */${CYCLE.BRIEFING_WATCHDOG_INTERVAL_HOURS} * * *`,
    async () => {
      await maybeRunMissedBriefing();
    },
    { timezone: "UTC" }
  );

  // Lightweight PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  let _pnlPollConsecutiveFailures = 0;
  const pnlPollInterval = setInterval(() => {
    (async () => {
      if (cycleState.isManagementBusy() || cycleState.isScreeningBusy() || _pnlPollBusy) return;
      _pnlPollBusy = true;
      try {
        const result = await getMyPositions({ force: true, silent: true }).catch((err): null => {
          log("poll_error", `getMyPositions failed: ${getErrorMessage(err)}`);
          _pnlPollConsecutiveFailures++;
          if (_pnlPollConsecutiveFailures >= RETRY.MAX_PNL_POLL_FAILURES) {
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
            const trackedP = p.tracked_state;
            if (!p.pnl_pct_suspicious && queuePeakConfirmation(p.position, p.pnl_pct, trackedP)) {
              schedulePeakConfirmation(p.position);
            }
            const exit = updatePnlAndCheckExits(
              p.position,
              p,
              config.management,
              trackedP?.strategy_config,
              trackedP
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
              const cooldownMs = config.schedule.managementIntervalMin * TIME.MINUTE;
              const sinceLastTrigger = Date.now() - cycleState.getPollTriggeredAt();
              if (sinceLastTrigger >= cooldownMs) {
                cycleState.setPollTriggeredAt(Date.now());
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
  }, CYCLE.PNL_POLL_INTERVAL_MS);

  // Hive Mind heartbeat — periodic background sync with the hive server
  const hiveHeartbeatTask = cron.schedule(
    `*/${HIVE_MIND.HEARTBEAT_INTERVAL_MIN} * * * *`,
    async () => {
      await hiveHeartbeat();
    }
  );

  cycleState.setCronTasks([
    mgmtTask,
    screenTask,
    healthTask,
    briefingTask,
    briefingWatchdog,
    hiveHeartbeatTask,
  ]);
  // Store interval ref so stopCronJobs can clear it
  cycleState.setPnlPollInterval(pnlPollInterval);

  // Start portfolio refresh cron (no-op if portfolioSync is disabled)
  startPortfolioRefreshCron();

  log(
    "cron",
    `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`
  );
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
export function registerCronAutoRestart(): void {
  registerCronRestarter(() => {
    if (cycleState.isCronStarted()) startCronJobs();
  });
}
