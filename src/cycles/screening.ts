import { agentLoop } from "../agent/agent.js";
import { computeDeployAmount, config } from "../config/config.js";
import { LLM } from "../config/constants.js";
import { cycleState } from "../infrastructure/cycle-state.js";
import { log } from "../infrastructure/logger.js";
import {
  getLastScreeningMessageId,
  sendMessage,
  setLastScreeningMessageId,
  isEnabled as telegramEnabled,
  updateExistingLiveMessage,
} from "../infrastructure/telegram.js";
import type { CycleOptions, LiveMessageHandler } from "../types/index.js";
import type { TelegramMessage } from "../types/telegram.js";
import { getErrorMessage } from "../utils/errors.js";
import { fetchAndEnrichCandidates, runPreFlightChecks } from "./screening/candidate-fetcher.js";
import { applyLateFilters } from "./screening/filters.js";
import { buildCandidateBlocks, buildScreeningPrompt } from "./screening/prompt-builder.js";
import { applyEdgeProximityFilter, scoreAndRankCandidates } from "./screening/scoring.js";

// ═══════════════════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════════════════

/** Type guard: checks if a sendMessage return value carries a message_id. */
function hasMessageId(value: unknown): value is TelegramMessage & { message_id: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message_id" in value &&
    typeof (value as TelegramMessage).message_id === "number"
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/** Strip reasoning blocks that some models leak into output */
function stripThink(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Format a report with divider, timestamp, and next screening time footer.
 */
function formatReportWithTimestamp(report: string, scheduled = false): string {
  const now = new Date();
  const timestamp = `🕐 ${now.getDate().toString().padStart(2, "0")} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][now.getMonth()]} ${now.getFullYear().toString().slice(2)} ${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;

  // Calculate next screening time (validate interval with fallback to 10 min default)
  const intervalMin = config.schedule.screeningIntervalMin ?? 10;
  if (intervalMin <= 0) {
    throw new Error(`Invalid screeningIntervalMin: ${config.schedule.screeningIntervalMin}`);
  }
  const nextScreening = new Date(now.getTime() + intervalMin * 60 * 1000);
  const nextScreeningTime = `⏭️ Next: ${nextScreening.getDate().toString().padStart(2, "0")} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][nextScreening.getMonth()]} ${nextScreening.getHours().toString().padStart(2, "0")}:${nextScreening.getMinutes().toString().padStart(2, "0")} (${scheduled ? "scheduled" : "manual"})`;

  return `${report}\n\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n${timestamp} | ${nextScreeningTime}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Race Guard Accessors
// ═══════════════════════════════════════════════════════════════════════════

// NOTE: These are now delegated to cycleState for centralized state management

export function getScreeningLastTriggered(): number {
  return cycleState.getScreeningLastTriggered();
}

export function setScreeningLastTriggered(time: number): void {
  cycleState.setScreeningLastTriggered(time);
}

export function isScreeningBusy(): boolean {
  return cycleState.isScreeningBusy();
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Screening Cycle
// ═══════════════════════════════════════════════════════════════════════════

export async function runScreeningCycle(
  options: CycleOptions = {},
  deps?: {
    timers?: { screeningLastRun: number | null };
    setScreeningBusy?: (busy: boolean) => void;
    isScreeningBusy?: () => boolean;
    getScreeningLastTriggered?: () => number;
    setScreeningLastTriggered?: (time: number) => void;
  }
): Promise<string | null> {
  return cycleState.getScreeningMutex().runExclusive(async () => {
    const { silent = false, scheduled = false } = options;

    // Use deps functions if provided, otherwise use cycleState
    const setBusy =
      deps?.setScreeningBusy ??
      ((busy: boolean) => {
        cycleState.setScreeningBusy(busy);
      });
    const setLastTriggered =
      deps?.setScreeningLastTriggered ??
      ((time: number) => {
        cycleState.setScreeningLastTriggered(time);
      });

    setBusy(true);
    setLastTriggered(Date.now());

    let screenReport: string | null = null;
    let liveMessage: LiveMessageHandler | null = null;

    try {
      // Run pre-flight checks
      const preFlightResult = await runPreFlightChecks(silent);
      if ("error" in preFlightResult) {
        screenReport = preFlightResult.error;
        setBusy(false);
        // Format with timestamp even for early returns
        if (!silent && telegramEnabled()) {
          const formattedReport = formatReportWithTimestamp(stripThink(screenReport), scheduled);
          // NOTE: The read → update → write pattern on message ID is safe because the
          // screening cycle mutex (runScreening is wrapped in setBusy) ensures only one
          // screening cycle runs at a time, preventing concurrent mutation of the ID.
          const existingMessageId = getLastScreeningMessageId();
          if (existingMessageId) {
            const updated = await updateExistingLiveMessage(
              "🔍 Screening Cycle",
              formattedReport,
              existingMessageId
            );
            if (!updated) {
              const sent = await sendMessage(`🔍 Screening Cycle\n\n${formattedReport}`);
              if (hasMessageId(sent)) {
                setLastScreeningMessageId(sent.message_id);
              }
            }
          } else {
            const sent = await sendMessage(`🔍 Screening Cycle\n\n${formattedReport}`);
            if (hasMessageId(sent)) {
              setLastScreeningMessageId(sent.message_id);
            }
          }
        }
        return screenReport;
      }

      const { prePositions, preBalance: balance, liveMessage: msg } = preFlightResult;
      liveMessage = msg;

      if (deps?.timers) {
        deps.timers.screeningLastRun = Date.now();
      }

      log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);

      // Compute deploy amount
      const deployAmount = computeDeployAmount(balance.sol);
      log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${balance.sol} SOL)`);

      // Load active strategy
      const { getActiveStrategy } = await import("../domain/strategy-library.js");
      const activeStrategy = getActiveStrategy();
      const strategyBlock = activeStrategy
        ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${(activeStrategy.range as { bins_above?: number })?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
        : `No active strategy — use default bid_ask, bins_above: 0, SOL only.`;

      // Fetch and enrich candidates
      const { candidates: enrichedCandidates, earlyFiltered } = await fetchAndEnrichCandidates(
        config.screening.maxCandidatesEnriched
      );

      // Apply late filters
      const { passing, lateFiltered } = applyLateFilters(enrichedCandidates);

      // Prioritize late examples (more informative - survived early screening)
      const examplesToShow = [...lateFiltered.slice(0, 2), ...earlyFiltered.slice(0, 1)];

      if (passing.length === 0) {
        let message = "No candidates passed screening.";
        if (examplesToShow.length > 0) {
          message += "\n\nFiltered examples:\n";
          for (const ex of examplesToShow) {
            message += `- ${ex.name} (${ex.pool_address.slice(0, 8)}...): ${ex.filter_reason}\n`;
          }
        }
        screenReport = message;
        return screenReport;
      }

      // Score and rank candidates
      const scoredCandidates = await scoreAndRankCandidates(passing);

      // Apply edge proximity filter — reject candidates at range boundary
      const binsAbove = activeStrategy
        ? ((activeStrategy.range as { bins_above?: number })?.bins_above ?? 0)
        : 0;
      const { passing: edgePassing, edgeFiltered } = applyEdgeProximityFilter(
        scoredCandidates,
        binsAbove
      );

      // Add edge-filtered examples to the report (highest priority — survived all prior checks)
      if (edgeFiltered.length > 0) {
        examplesToShow.unshift(...edgeFiltered.slice(0, 2));
      }

      if (edgePassing.length === 0) {
        let message = "No candidates passed screening.";
        if (examplesToShow.length > 0) {
          message += "\n\nFiltered examples:\n";
          for (const ex of examplesToShow.slice(0, 4)) {
            message += `- ${ex.name} (${ex.pool_address.slice(0, 8)}...): ${ex.filter_reason}\n`;
          }
        }
        screenReport = message;
        return screenReport;
      }

      // Take top N candidates for LLM evaluation (from edge-passing candidates)
      const topCandidatesForLLM = edgePassing.slice(0, Math.min(5, edgePassing.length));

      // Build candidate blocks
      const candidateBlocks = buildCandidateBlocks(topCandidatesForLLM, 5);

      // Build and send screening prompt
      const prompt = buildScreeningPrompt(
        strategyBlock,
        prePositions,
        deployAmount,
        edgePassing,
        candidateBlocks,
        balance.sol
      );

      const { content } = await agentLoop(
        prompt,
        config.llm.maxSteps,
        [],
        "SCREENER",
        config.llm.screeningModel,
        LLM.DEFAULT_SCREENING_MAX_TOKENS,
        {
          onToolStart: async ({ name }: { name: string }) => {
            await liveMessage?.toolStart(name);
          },
          onToolFinish: async ({
            name,
            result,
            success,
          }: {
            name: string;
            result: unknown;
            success: boolean;
          }) => {
            await liveMessage?.toolFinish(name, result, success);
          },
        }
      );
      screenReport = content;
    } catch (error) {
      log("cron_error", `Screening cycle failed: ${getErrorMessage(error)}`);
      screenReport = `Screening cycle failed: ${getErrorMessage(error)}`;
    } finally {
      setBusy(false);
      if (!silent && telegramEnabled()) {
        if (screenReport) {
          const formattedReport = formatReportWithTimestamp(stripThink(screenReport), scheduled);
          const isDeployed = formattedReport.includes("🚀 DEPLOYED");

          if (liveMessage) {
            await liveMessage
              .finalize(formattedReport)
              .catch((e) => log("telegram_error", getErrorMessage(e)));

            // If screening deployed successfully, clear message ID so next cycle creates fresh
            // If screening was skipped/no deploy, keep message ID for reuse
            if (isDeployed) {
              setLastScreeningMessageId(null);
            }
          } else {
            // No live message handler - check if we have an existing message to update.
            // Safe from race conditions: screening cycle mutex prevents concurrent access.
            const existingMessageId = getLastScreeningMessageId();
            if (existingMessageId) {
              // Try to update existing message
              const updated = await updateExistingLiveMessage(
                "🔍 Screening Cycle",
                formattedReport,
                existingMessageId
              );
              if (!updated) {
                // Update failed (message deleted or too old), create new
                const sent = await sendMessage(`🔍 Screening Cycle\n\n${formattedReport}`);
                if (hasMessageId(sent)) {
                  setLastScreeningMessageId(sent.message_id);
                }
              }
            } else {
              // No existing message, create new
              const sent = await sendMessage(`🔍 Screening Cycle\n\n${formattedReport}`);
              if (hasMessageId(sent)) {
                setLastScreeningMessageId(sent.message_id);
              }
            }
          }
        }
      }
    }
    return screenReport;
  });
}
