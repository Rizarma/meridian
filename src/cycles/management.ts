import { closePosition, getMyPositions } from "../../tools/dlmm.js";
import { agentLoop } from "../agent/agent.js";
import { computeDeployAmount, config } from "../config/config.js";
import {
  TRAILING_DROP_CONFIRM_DELAY_MS,
  TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
  TRAILING_PEAK_CONFIRM_DELAY_MS,
  TRAILING_PEAK_CONFIRM_TOLERANCE,
} from "../config/constants.js";
import { evaluateManagementExitRules } from "../domain/exit-rules.js";
import { addPoolNote, recallForPool, recordPositionSnapshot } from "../domain/pool-memory.js";
import { checkSmartWalletsOnPool } from "../domain/smart-wallets.js";
import {
  clearAllConfirmationTimers,
  clearPeakConfirmationTimer,
  clearTrailingDropConfirmationTimer,
  deletePeakConfirmTimer,
  deleteTrailingDropConfirmTimer,
  getPeakConfirmTimer,
  getTrailingDropConfirmTimer,
  setPeakConfirmTimer,
  setTrailingDropConfirmTimer,
} from "../infrastructure/confirmation-timers.js";
import { log } from "../infrastructure/logger.js";
import {
  getTrackedPosition,
  queuePeakConfirmation,
  queueTrailingDropConfirmation,
  resolvePendingPeak,
  resolvePendingTrailingDrop,
  updatePnlAndCheckExits,
} from "../infrastructure/state.js";
import {
  createLiveMessage,
  notifyOutOfRange,
  sendHTML,
  sendMessage,
  isEnabled as telegramEnabled,
} from "../infrastructure/telegram.js";
import type {
  ActionDecision,
  CycleOptions,
  EnrichedPosition,
  LiveMessageHandler,
} from "../types/index.js";
import { getErrorMessage } from "../utils/errors.js";

/** Strip reasoning blocks that some models leak into output */
function stripThink(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function schedulePeakConfirmation(positionAddress: string): void {
  if (!positionAddress || getPeakConfirmTimer(positionAddress)) return;

  const timer = setTimeout((): void => {
    void (async (): Promise<void> => {
      deletePeakConfirmTimer(positionAddress);
      try {
        const result = await getMyPositions({ force: true, silent: true }).catch((): null => null);
        const positions = result?.positions;
        const position = positions?.find(
          (p: { position: string }) => p.position === positionAddress
        );
        resolvePendingPeak(
          positionAddress,
          position?.pnl_pct ?? null,
          TRAILING_PEAK_CONFIRM_TOLERANCE
        );
      } catch (error) {
        log(
          "state_warn",
          `Peak confirmation failed for ${positionAddress}: ${getErrorMessage(error)}`
        );
      }
    })();
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  setPeakConfirmTimer(positionAddress, timer);
}

export function scheduleTrailingDropConfirmation(
  positionAddress: string,
  onConfirmed?: () => void
) {
  if (!positionAddress || getTrailingDropConfirmTimer(positionAddress)) return;

  const timer = setTimeout((): void => {
    void (async (): Promise<void> => {
      deleteTrailingDropConfirmTimer(positionAddress);
      try {
        const result = await getMyPositions({ force: true, silent: true }).catch((): null => null);
        const position = result?.positions?.find(
          (p: { position: string }) => p.position === positionAddress
        );
        const resolved = resolvePendingTrailingDrop(
          positionAddress,
          position?.pnl_pct ?? null,
          config.management.trailingDropPct,
          TRAILING_DROP_CONFIRM_TOLERANCE_PCT
        );
        if (resolved?.confirmed) {
          log(
            "state",
            `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management`
          );
          // Trigger management cycle to close the position
          onConfirmed?.();
        }
      } catch (error: unknown) {
        log(
          "state_warn",
          `Trailing drop confirmation failed for ${positionAddress}: ${getErrorMessage(error)}`
        );
      }
    })();
  }, TRAILING_DROP_CONFIRM_DELAY_MS);

  setTrailingDropConfirmTimer(positionAddress, timer);
}

export async function runManagementCycle(
  options: CycleOptions = {},
  deps: {
    timers: { managementLastRun: number | null };
    setManagementBusy: (busy: boolean) => void;
    isManagementBusy: () => boolean;
    triggerScreening: (positionCount?: number) => Promise<void>;
    triggerScreeningImmediate?: () => Promise<void>;
    triggerManagement?: () => Promise<void>;
  }
): Promise<string | null> {
  const { silent = false } = options;
  if (deps.isManagementBusy()) return null;
  deps.setManagementBusy(true);
  deps.timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport: string | null = null;
  let positions: EnrichedPosition[] = [];
  let liveMessage: LiveMessageHandler | null = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch((): null => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      // Use immediate trigger (no cooldown) when there are no positions
      const trigger = deps.triggerScreeningImmediate ?? deps.triggerScreening;
      try {
        await trigger();
      } catch (e) {
        log("cron_error", `Triggered screening failed: ${(e as Error).message}`);
      }
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    }) as Array<EnrichedPosition & { recall: string | null }>;

    // JS trailing TP check
    const exitMap = new Map<string, string>();
    for (const p of positionData) {
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
        // Trailing TP needs confirmation before closing
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
              deps
                .triggerManagement?.()
                .catch((e: Error) =>
                  log("cron_error", `Trailing recheck management failed: ${e.message}`)
                );
            });
          }
          continue;
        }
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map<string, ActionDecision>();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, {
          action: "CLOSE",
          rule: "exit",
          reason: exitMap.get(p.position),
        });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      // Sanity-check PnL against tracked initial deposit — API sometimes returns bad data
      // giving -99% PnL which would incorrectly trigger stop loss
      const tracked = getTrackedPosition(p.position);
      const pnlSuspect = ((): boolean => {
        if (p.pnl_pct == null) return false;
        if (p.pnl_pct > -90) return false; // only flag extreme negatives
        // Cross-check: if we have a tracked deposit and current value isn't near zero, it's bad data
        if (tracked?.amount_sol && (p.total_value_usd ?? 0) > 0.01) {
          log(
            "cron_warn",
            `Suspect PnL for ${p.pair}: ${p.pnl_pct}% but position still has value — skipping PnL rules`
          );
          return true;
        }
        return false;
      })();

      // Use extracted exit-rules module for deterministic rule checks
      // Load tracked position to get strategy config
      const trackedPosition = getTrackedPosition(p.position);
      const strategyConfig = trackedPosition?.strategy_config;

      const exitDecision = evaluateManagementExitRules(
        p,
        config.management,
        pnlSuspect,
        strategyConfig
      );
      if (exitDecision) {
        actionMap.set(p.position, exitDecision);
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.features.solMode
        ? `◎${p.total_value_usd ?? "?"}`
        : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.features.solMode
        ? `◎${p.unclaimed_fees_usd ?? "?"}`
        : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act?.action === "INSTRUCTION" ? "HOLD (instruction)" : act?.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act?.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Trailing TP: ${act.reason}`;
      if (act?.action === "CLOSE" && act.rule && act.rule !== "exit")
        line += `\nRule ${act.rule}: ${act.reason}`;
      if (act?.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter((a) => a.action !== "STAY");
    const actionSummary =
      needsAction.length > 0
        ? needsAction
            .map((a) =>
              a.action === "INSTRUCTION"
                ? "EVAL instruction"
                : `${a.action}${a.reason ? ` (${a.reason})` : ""}`
            )
            .join(", ")
        : "no action";

    const cur = config.features.solMode ? "◎" : "$";
    mgmtReport =
      reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter((p) => {
      const a = actionMap.get(p.position);
      return a?.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      log(
        "cron",
        `Management: ${actionPositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`
      );

      const actionBlocks = actionPositions
        .map((p) => {
          const act = actionMap.get(p.position);
          return [
            `POSITION: ${p.pair} (${p.position})`,
            `  pool: ${p.pool}`,
            `  action: ${act?.action}${act?.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act?.rule === "exit" ? ` — ⚡ Trailing TP: ${act.reason}` : ""}`,
            `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
            `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
            p.instruction ? `  instruction: "${p.instruction}"` : null,
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n\n");

      const { content } = await agentLoop(
        `
MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position only — it handles fee claiming internally, do NOT call claim_fees first
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- ⚡ exit alerts: close immediately, no exceptions

Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
After executing, write a brief one-line result per position.
      `,
        config.llm.maxSteps,
        [],
        "MANAGER",
        config.llm.managementModel,
        2048,
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

      mgmtReport += `\n\n${content}`;
    } else {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch((): null => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    // Note: screeningCooldown check is handled by the orchestrator via _screeningLastTriggered
    if (afterCount < config.risk.maxPositions) {
      log(
        "cron",
        `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`
      );
      deps
        .triggerScreening(afterCount)
        .catch((e: Error) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${(error as Error).message}`);
    mgmtReport = `Management cycle failed: ${(error as Error).message}`;
  } finally {
    deps.setManagementBusy(false);
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => {});
      }
      for (const p of positions) {
        if (
          !p.in_range &&
          (p.minutes_out_of_range ?? 0) >= config.management.outOfRangeWaitMinutes
        ) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => {});
        }
      }
    }
  }
  return mgmtReport;
}
