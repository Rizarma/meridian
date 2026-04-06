import type { Interface as ReadlineInterface } from "readline";
import readline from "readline";
import { closePosition, getMyPositions } from "../tools/dlmm.js";
import { getTopCandidates } from "../tools/screening.js";
import { getWalletBalances } from "../tools/wallet.js";
import { agentLoop } from "./agent/agent.js";
import { config } from "./config/config.js";
import {
  getScreeningLastTriggered,
  isScreeningBusy,
  setScreeningLastTriggered,
} from "./cycles/screening.js";
import { getPerformanceSummary } from "./domain/lessons.js";
import { evolveThresholds } from "./domain/threshold-evolution.js";
import { generateBriefing } from "./infrastructure/briefing.js";
import { log } from "./infrastructure/logger.js";
import {
  createLiveMessage,
  sendHTML,
  sendMessage,
  startPolling,
  stopPolling,
  isEnabled as telegramEnabled,
} from "./infrastructure/telegram.js";
import type { CondensedPool, EnrichedPosition } from "./types/index.js";
import type { TelegramMessage } from "./types/telegram.js";

// DEPLOY constant from config
const DEPLOY: number = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  SESSION STATE
// ═══════════════════════════════════════════
const sessionHistory: Array<{ role: string; content: string }> = []; // persists conversation across REPL turns
const MAX_HISTORY = 20; // keep last 20 messages (10 exchanges)
let busy = false;

// Telegram queue for messages received while agent is busy
const _telegramQueue: TelegramMessage[] = [];

// TTY interface reference for prompt refresh (null in non-TTY mode)
let _ttyInterface: readline.Interface | null = null;

// ═══════════════════════════════════════════
//  TYPE DEFINITIONS FOR DEPENDENCIES
// ═══════════════════════════════════════════
interface REPLDependencies {
  launchCron: () => void;
  shutdown: (signal: string) => Promise<void>;
  timers: { managementLastRun: number | null; screeningLastRun: number | null };
  isCronStarted: () => boolean;
  setCronStarted: (started: boolean) => void;
  isManagementBusy: () => boolean;
  isScreeningBusy: () => boolean;
  runManagementCycle: (opts?: { silent?: boolean }) => Promise<string | null>;
  runScreeningCycle: (opts?: { silent?: boolean }) => Promise<string | null>;
  startCronJobs: () => void;
  stopCronJobs: () => void;
  maybeRunMissedBriefing: () => Promise<void>;
}

// ═══════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════

function nextRunIn(lastRun: number | null, intervalMin: number): number {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt(deps: REPLDependencies): string {
  const mgmt = formatCountdown(
    nextRunIn(deps.timers.managementLastRun, config.schedule.managementIntervalMin)
  );
  const scrn = formatCountdown(
    nextRunIn(deps.timers.screeningLastRun, config.schedule.screeningIntervalMin)
  );
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

function formatCandidates(candidates: CondensedPool[]): string {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl =
      `${p.fee_active_tvl_ratio ?? (p as { fee_tvl_ratio?: number }).fee_tvl_ratio}%`.padStart(8);
    const vol =
      `$${((p.volume_window || (p as { volume_24h?: number }).volume_24h || 0) / 1000).toFixed(1)}k`.padStart(
        8
      );
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

/** Strip reasoning blocks that some models leak into output */
function stripThink(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function appendHistory(userMsg: string, assistantMsg: string): void {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt(deps: REPLDependencies): void {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt(deps));
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue(deps: REPLDependencies): Promise<void> {
  while (_telegramQueue.length > 0 && !deps.isManagementBusy() && !isScreeningBusy() && !busy) {
    const queued = _telegramQueue.shift();
    if (queued) await telegramHandler(queued, deps);
  }
}

async function telegramHandler(msg: TelegramMessage, deps: REPLDependencies): Promise<void> {
  const text = msg?.text?.trim();
  if (!text) return;
  if (deps.isManagementBusy() || isScreeningBusy() || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(
        () => {}
      );
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${(e as Error).message}`).catch(() => {});
    }
    return;
  }

  if (text === "/positions") {
    try {
      const result = await getMyPositions({ force: true });
      const positions = result.positions || [];
      const totalPositions = result.total_positions ?? 0;
      if (totalPositions === 0) {
        await sendMessage("No open positions.");
        return;
      }
      const cur = config.management.solMode ? "◎" : "$";
      const lines = positions.map((p, i) => {
        const pnl =
          (p.pnl_usd ?? 0) >= 0 ? `+${cur}${p.pnl_usd ?? 0}` : `-${cur}${Math.abs(p.pnl_usd ?? 0)}`;
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const oor = !p.in_range ? " ⚠️OOR" : "";
        return `${i + 1}. ${p.pair} | ${cur}${p.total_value_usd} | PnL: ${pnl} | fees: ${cur}${p.unclaimed_fees_usd} | ${age}${oor}`;
      });
      await sendMessage(
        `📊 Open Positions (${totalPositions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`
      );
    } catch (e) {
      await sendMessage(`Error: ${(e as Error).message}`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const result = await getMyPositions({ force: true });
      const positions = result.positions || [];
      if (idx < 0 || idx >= positions.length) {
        await sendMessage(`Invalid number. Use /positions first.`);
        return;
      }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const closeResult = await closePosition({ position_address: pos.position });
      if (closeResult.success) {
        const closeTxs = closeResult.close_txs?.length ? closeResult.close_txs : closeResult.txs;
        const claimNote = closeResult.claim_txs?.length
          ? `\nClaim txs: ${closeResult.claim_txs.join(", ")}`
          : "";
        await sendMessage(
          `✅ Closed ${pos.pair}\nPnL: ${config.management.solMode ? "◎" : "$"}${closeResult.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}`
        );
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(closeResult)}`);
      }
    } catch (e) {
      await sendMessage(`Error: ${(e as Error).message}`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const result = await getMyPositions({ force: true });
      const positions = result.positions || [];
      if (idx < 0 || idx >= positions.length) {
        await sendMessage(`Invalid number. Use /positions first.`);
        return;
      }
      const pos = positions[idx];
      // Import dynamically to avoid circular dependency
      const { setPositionInstruction } = await import("./infrastructure/state.js");
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) {
      await sendMessage(`Error: ${(e as Error).message}`).catch(() => {});
    }
    return;
  }

  busy = true;
  let liveMessage: Awaited<ReturnType<typeof createLiveMessage>> | null = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest =
      !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel =
      agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(
      text,
      config.llm.maxSteps,
      sessionHistory as unknown as Parameters<typeof agentLoop>[2],
      agentRole,
      agentModel,
      null,
      {
        requireTool: true,
        interactive: true,
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
    appendHistory(text, content);
    if (content) {
      if (liveMessage) await liveMessage.finalize(stripThink(content));
      else await sendMessage(stripThink(content));
    }
  } catch (e) {
    if (liveMessage) await liveMessage.fail((e as Error).message).catch(() => {});
    else await sendMessage(`Error: ${(e as Error).message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt(deps);
    drainTelegramQueue(deps).catch(() => {});
  }
}

async function runBusy(
  rl: ReadlineInterface,
  deps: REPLDependencies,
  fn: () => Promise<void>
): Promise<void> {
  if (busy) {
    console.log("Agent is busy, please wait...");
    rl.prompt();
    return;
  }
  busy = true;
  rl.pause();
  try {
    await fn();
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
  } finally {
    busy = false;
    rl.setPrompt(buildPrompt(deps));
    rl.resume();
    rl.prompt();
  }
}

// ═══════════════════════════════════════════
//  MAIN REPL ENTRY POINT
// ═══════════════════════════════════════════
export async function startREPL(deps: REPLDependencies): Promise<void> {
  const isTTY = process.stdin.isTTY;

  if (!isTTY) {
    await startNonTTY(deps);
    return;
  }

  const rl: ReadlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(deps),
  });

  // Store reference for prompt refresh
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt(deps));
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  // Wrapper that calls orchestrator's launchCron and adds REPL-specific UI updates
  function launchCron(): void {
    const wasAlreadyStarted = deps.isCronStarted ? deps.isCronStarted() : false;
    deps.launchCron();
    if (!wasAlreadyStarted) {
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt(deps));
      rl.prompt(true);
    }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  let startupCandidates: CondensedPool[] = [];

  (async () => {
    try {
      const [wallet, positions, topCandidates] = await Promise.all([
        getWalletBalances(),
        getMyPositions({ force: true }),
        getTopCandidates({ limit: 5 }),
      ]);

      const candidates =
        (
          topCandidates as {
            candidates?: CondensedPool[];
            total_eligible?: number;
            total_screened?: number;
          }
        ).candidates || [];
      startupCandidates = candidates;

      console.log(
        `Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`
      );
      console.log(
        `Positions: ${(positions as { total_positions?: number }).total_positions ?? 0} open\n`
      );

      if ((positions as { total_positions?: number }).total_positions ?? 0 > 0) {
        console.log("Open positions:");
        for (const p of (positions as { positions?: EnrichedPosition[] }).positions || []) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
        }
        console.log();
      }

      const totalEligible = (topCandidates as { total_eligible?: number }).total_eligible ?? 0;
      const totalScreened = (topCandidates as { total_screened?: number }).total_screened ?? 0;
      console.log(`Top pools (${totalEligible} eligible from ${totalScreened} screened):\n`);
      console.log(formatCandidates(candidates));
    } catch (e) {
      console.error(`Startup fetch failed: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  })();

  // Always start autonomous cycles on launch
  launchCron();

  // Run missed briefing check
  deps.maybeRunMissedBriefing().catch(() => {});

  // Create telegram handler bound to deps
  const boundTelegramHandler = (msg: TelegramMessage) => telegramHandler(msg, deps);
  startPolling(boundTelegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runBusy(rl, deps, async () => {
        const pool = startupCandidates[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(rl, deps, async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") {
      await deps.shutdown("user command");
      return;
    }

    if (input === "/status") {
      await runBusy(rl, deps, async () => {
        const [wallet, positionsResult] = await Promise.all([
          getWalletBalances(),
          getMyPositions({ force: true }),
        ]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positionsResult.total_positions ?? 0}`);
        for (const p of positionsResult.positions || []) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(
            `  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`
          );
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(rl, deps, async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(rl, deps, async () => {
        const topCandidates = await getTopCandidates({ limit: 5 });
        const candidates = (topCandidates as { candidates?: CondensedPool[] }).candidates || [];
        startupCandidates = candidates;
        const totalEligible = (topCandidates as { total_eligible?: number }).total_eligible ?? 0;
        const totalScreened = (topCandidates as { total_screened?: number }).total_screened ?? 0;
        console.log(`\nTop pools (${totalEligible} eligible from ${totalScreened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(rl, deps, async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy: Array<{ pool: string; name: string }> = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const topCandidates = await getTopCandidates({ limit: 10 });
          const candidates = (topCandidates as { candidates?: CondensedPool[] }).candidates || [];
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy.map((p, i) => `${i + 1}. ${p.name} (${p.pool})`).join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(rl, deps, async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log(
            "\nNo threshold changes needed — current settings already match performance data.\n"
          );
        } else {
          // Import dynamically to avoid circular dependency
          const { reloadScreeningThresholds } = await import("./config/config.js");
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${(result.rationale as Record<string, string>)[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(rl, deps, async () => {
      log("user", input);
      const { content } = await agentLoop(
        input,
        config.llm.maxSteps,
        sessionHistory as unknown as Parameters<typeof agentLoop>[2],
        "GENERAL",
        config.llm.generalModel,
        null,
        { requireTool: true }
      );
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => deps.shutdown("stdin closed"));
}

// ═══════════════════════════════════════════
//  NON-TTY MODE
// ═══════════════════════════════════════════
export async function startNonTTY(deps: REPLDependencies): Promise<void> {
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  deps.startCronJobs();

  // Run missed briefing check
  deps.maybeRunMissedBriefing().catch(() => {});

  // Create telegram handler bound to deps
  const boundTelegramHandler = (msg: TelegramMessage) => telegramHandler(msg, deps);
  startPolling(boundTelegramHandler);

  (async () => {
    try {
      const startupStep3 =
        process.env.DRY_RUN === "true"
          ? `3. Ignore wallet SOL threshold in dry run: get_top_candidates then simulate deploy ${DEPLOY} SOL.`
          : `3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL.`;
      await agentLoop(
        `
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. ${startupStep3} 4. Report.
      `,
        config.llm.maxSteps,
        [],
        "SCREENER"
      );
    } catch (e) {
      log("startup_error", (e as Error).message);
    }
  })();
}

// ═══════════════════════════════════════════
//  TELEGRAM HANDLER FACTORY
// ═══════════════════════════════════════════
export function createTelegramHandler(deps: REPLDependencies) {
  return (msg: TelegramMessage) => telegramHandler(msg, deps);
}

// ═══════════════════════════════════════════
//  BUSY STATE ACCESSOR (for orchestrator)
// ═══════════════════════════════════════════
export function isReplBusy(): boolean {
  return busy;
}
