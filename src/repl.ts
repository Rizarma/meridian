import chalk from "chalk";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import logUpdate from "log-update";
import { join } from "path";
import type { Interface as ReadlineInterface } from "readline";
import readline from "readline";
import { closePosition, getMyPositions } from "../tools/dlmm.js";
import { getTopCandidates } from "../tools/screening.js";
import { getWalletBalances } from "../tools/wallet.js";
import { agentLoop } from "./agent/agent.js";
import { colors } from "./cli/colors.js";
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
//  CONFIGURATION
// ═══════════════════════════════════════════
const HISTORY_FILE = join(process.cwd(), ".repl_history");
const MAX_HISTORY_LINES = 1000;
const HISTORY_SAVE_INTERVAL = 60000; // Save every minute

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

// Track if there's been output since last status bar draw (prevents corrupting logs)
let _outputSinceLastStatus = false;

// Current candidates for number-based selection
let _startupCandidates: CondensedPool[] = [];

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
//  COMMAND REGISTRY SYSTEM
// ═══════════════════════════════════════════
interface CommandContext {
  rl: ReadlineInterface;
  deps: REPLDependencies;
  args: string[];
  rawInput: string;
}

interface Command {
  name: string;
  description: string;
  handler: (ctx: CommandContext) => Promise<void>;
  aliases?: string[];
  hidden?: boolean; // Hide from /help (e.g., internal commands)
}

const commandRegistry = new Map<string, Command>();
const commandNames: string[] = [];

function registerCommand(cmd: Command): void {
  commandRegistry.set(cmd.name, cmd);
  commandNames.push(cmd.name);
  cmd.aliases?.forEach((alias) => {
    commandRegistry.set(alias, cmd);
  });
}

function getCommand(input: string): Command | undefined {
  const trimmed = input.trim().toLowerCase();
  // Check exact match first
  if (commandRegistry.has(trimmed)) {
    return commandRegistry.get(trimmed);
  }
  // Check for commands with arguments (e.g., "/learn <addr>")
  for (const [name, cmd] of commandRegistry) {
    if (trimmed.startsWith(name + " ") || trimmed === name) {
      return cmd;
    }
  }
  return undefined;
}

function parseCommand(input: string): {
  command: Command | undefined;
  args: string[];
  rawInput: string;
} {
  const trimmed = input.trim();
  const cmd = getCommand(trimmed);
  if (!cmd) {
    return { command: undefined, args: [], rawInput: trimmed };
  }

  // Extract arguments (everything after the command name)
  const cmdName = trimmed.split(" ")[0];
  const argsStr = trimmed.slice(cmdName.length).trim();
  const args = argsStr ? argsStr.split(/\s+/) : [];

  return { command: cmd, args, rawInput: trimmed };
}

// ═══════════════════════════════════════════
//  TAB COMPLETION
// ═══════════════════════════════════════════
function createCompleter(): readline.Completer {
  return (line: string): [string[], string] => {
    const trimmed = line.trim().toLowerCase();

    // If empty or just whitespace, show all commands
    if (!trimmed) {
      return [commandNames, ""];
    }

    // Filter commands that start with the input
    const hits = commandNames.filter((cmd) => cmd.startsWith(trimmed));

    // Also include number completions if we have candidates
    if (/^\d*$/.test(trimmed)) {
      const maxNum = Math.min(_startupCandidates.length, 9);
      for (let i = 1; i <= maxNum; i++) {
        const numStr = String(i);
        if (numStr.startsWith(trimmed) && !hits.includes(numStr)) {
          hits.push(numStr);
        }
      }
    }

    return [hits, trimmed];
  };
}

// ═══════════════════════════════════════════
//  PERSISTENT HISTORY
// ═══════════════════════════════════════════
function loadHistory(): string[] {
  try {
    if (existsSync(HISTORY_FILE)) {
      const content = readFileSync(HISTORY_FILE, "utf8");
      return content.split("\n").filter((line) => line.trim());
    }
  } catch (e) {
    // Ignore errors, start with empty history
  }
  return [];
}

function saveHistory(history: string[]): void {
  try {
    // Keep only last MAX_HISTORY_LINES
    const linesToSave = history.slice(-MAX_HISTORY_LINES);
    writeFileSync(HISTORY_FILE, linesToSave.join("\n") + "\n");
  } catch (e) {
    // Ignore save errors
  }
}

function appendHistoryEntry(entry: string): void {
  try {
    appendFileSync(HISTORY_FILE, entry + "\n");
  } catch (e) {
    // Ignore append errors
  }
}

// ═══════════════════════════════════════════
//  SIGNAL HANDLING
// ═══════════════════════════════════════════
function setupSignalHandlers(deps: REPLDependencies): void {
  let shuttingDown = false;

  const handleShutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(colors.yellow("\nForce exit..."));
      process.exit(1);
    }
    shuttingDown = true;
    console.log(colors.yellow(`\nReceived ${signal}, shutting down gracefully...`));
    try {
      // Clear the status bar before shutdown to leave terminal clean
      clearStatusBar();
      await deps.shutdown(signal);
      process.exit(0);
    } catch (e) {
      console.error(colors.red(`Shutdown error: ${(e as Error).message}`));
      process.exit(1);
    }
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));

  // Handle uncaught errors gracefully
  process.on("uncaughtException", (err) => {
    console.error(colors.red(`\nUncaught exception: ${err.message}`));
    log("error", `Uncaught exception: ${err.message}`);
    // Don't exit immediately, let user decide
  });

  process.on("unhandledRejection", (reason) => {
    console.error(colors.red(`\nUnhandled rejection: ${reason}`));
    log("error", `Unhandled rejection: ${reason}`);
  });
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

function buildStatusBar(deps: REPLDependencies): string {
  const mgmt = formatCountdown(
    nextRunIn(deps.timers.managementLastRun, config.schedule.managementIntervalMin)
  );
  const scrn = formatCountdown(
    nextRunIn(deps.timers.screeningLastRun, config.schedule.screeningIntervalMin)
  );
  return chalk.dim(`[manage: ${mgmt} | screen: ${scrn}]`);
}

function drawStatusBar(deps: REPLDependencies): void {
  if (!_ttyInterface) return;

  // @ts-ignore - line is a private property
  const currentLine = _ttyInterface.line;

  // Don't draw status bar if user is typing (has input on current line)
  if (currentLine && currentLine.length > 0) return;

  const statusText = buildStatusBar(deps);

  // Use log-update to render status bar at the bottom of the terminal
  // This handles terminal resize gracefully and avoids race conditions with console output
  logUpdate(statusText);
}

function clearStatusBar(): void {
  logUpdate.clear();
}

function refreshPrompt(deps: REPLDependencies): void {
  if (!_ttyInterface) return;

  // @ts-ignore - line is a private property
  const currentLine = _ttyInterface.line;

  // Skip if user is typing
  if (currentLine && currentLine.length > 0) return;

  // Just redraw the status bar in-place
  drawStatusBar(deps);
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
      const cur = config.features.solMode ? "◎" : "$";
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
          `✅ Closed ${pos.pair}\nPnL: ${config.features.solMode ? "◎" : "$"}${closeResult.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}`
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
    console.log(colors.yellow("Agent is busy, please wait..."));
    rl.prompt();
    return;
  }
  busy = true;
  rl.pause();
  try {
    await fn();
  } catch (e) {
    console.error(colors.red(`Error: ${(e as Error).message}`));
  } finally {
    busy = false;
    rl.setPrompt(buildPrompt(deps));
    rl.resume();
    rl.prompt();
  }
}

// ═══════════════════════════════════════════
//  COMMAND HANDLERS
// ═══════════════════════════════════════════

const cmdHelp: Command = {
  name: "/help",
  description: "Show available commands",
  handler: async ({ rl }) => {
    console.log(colors.cyan("\nAvailable commands:"));
    console.log();

    const visibleCommands = Array.from(commandRegistry.values())
      .filter((cmd) => !cmd.hidden)
      .filter((cmd, idx, arr) => arr.findIndex((c) => c.name === cmd.name) === idx); // Remove duplicates from aliases

    for (const cmd of visibleCommands) {
      const aliases = cmd.aliases?.length ? colors.dim(` (${cmd.aliases.join(", ")})`) : "";
      console.log(`  ${colors.green(cmdName(cmd.name).padEnd(20))} ${cmd.description}${aliases}`);
    }

    console.log();
    console.log(colors.dim("Tip: Press TAB for command completion"));
    console.log();
    rl.prompt();
  },
};

const cmdStop: Command = {
  name: "/stop",
  description: "Shut down the agent",
  handler: async ({ deps }) => {
    await deps.shutdown("user command");
  },
};

const cmdStatus: Command = {
  name: "/status",
  description: "Refresh wallet + positions",
  handler: async ({ rl, deps }) => {
    await runBusy(rl, deps, async () => {
      const [wallet, positionsResult] = await Promise.all([
        getWalletBalances(),
        getMyPositions({ force: true }),
      ]);
      console.log(colors.cyan(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`));
      console.log(colors.cyan(`Positions: ${positionsResult.total_positions ?? 0}`));
      for (const p of positionsResult.positions || []) {
        const status = p.in_range ? colors.green("in-range ✓") : colors.yellow("OUT OF RANGE ⚠");
        console.log(
          `  ${colors.white(p.pair.padEnd(16))} ${status}  ${colors.dim("fees: ")}${config.features.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`
        );
      }
      console.log();
    });
  },
};

const cmdCandidates: Command = {
  name: "/candidates",
  description: "Refresh top pool list",
  handler: async ({ rl, deps }) => {
    await runBusy(rl, deps, async () => {
      const topCandidates = await getTopCandidates({ limit: 5 });
      const candidates = (topCandidates as { candidates?: CondensedPool[] }).candidates || [];
      _startupCandidates = candidates;
      const totalEligible = (topCandidates as { total_eligible?: number }).total_eligible ?? 0;
      const totalScreened = (topCandidates as { total_screened?: number }).total_screened ?? 0;
      console.log(
        colors.bold(
          `\nTop pools (${colors.cyan(totalEligible.toString())} eligible from ${colors.dim(totalScreened.toString())} screened):\n`
        )
      );
      console.log(formatCandidates(candidates));
      console.log();
    });
  },
};

const cmdBriefing: Command = {
  name: "/briefing",
  description: "Show morning briefing (last 24h)",
  handler: async ({ rl, deps }) => {
    await runBusy(rl, deps, async () => {
      const briefing = await generateBriefing();
      console.log(colors.dim(`\n${briefing.replace(/<[^>]*>/g, "")}\n`));
    });
  },
};

const cmdThresholds: Command = {
  name: "/thresholds",
  description: "Show current screening thresholds + performance stats",
  handler: async ({ rl }) => {
    const s = config.screening;
    console.log(colors.bold("\nCurrent screening thresholds:"));
    console.log(`  ${colors.cyan("minFeeActiveTvlRatio:")} ${s.minFeeActiveTvlRatio}`);
    console.log(`  ${colors.cyan("minOrganic:")}           ${s.minOrganic}`);
    console.log(`  ${colors.cyan("minHolders:")}           ${s.minHolders}`);
    console.log(`  ${colors.cyan("minTvl:")}               ${s.minTvl}`);
    console.log(`  ${colors.cyan("maxTvl:")}               ${s.maxTvl}`);
    console.log(`  ${colors.cyan("minVolume:")}            ${s.minVolume}`);
    console.log(`  ${colors.cyan("minTokenFeesSol:")}      ${s.minTokenFeesSol}`);
    console.log(`  ${colors.cyan("maxBundlePct:")}         ${s.maxBundlePct}`);
    console.log(`  ${colors.cyan("maxBotHoldersPct:")}     ${s.maxBotHoldersPct}`);
    console.log(`  ${colors.cyan("maxTop10Pct:")}          ${s.maxTop10Pct}`);
    console.log(`  ${colors.cyan("timeframe:")}            ${s.timeframe}`);
    const perf = getPerformanceSummary();
    if (perf) {
      console.log(colors.dim(`\n  Based on ${perf.total_positions_closed} closed positions`));
      console.log(
        `  ${colors.green("Win rate:")} ${perf.win_rate_pct}%  |  ${colors.green("Avg PnL:")} ${perf.avg_pnl_pct}%`
      );
    } else {
      console.log(colors.yellow("\n  No closed positions yet — thresholds are preset defaults."));
    }
    console.log();
    rl.prompt();
  },
};

const cmdLearn: Command = {
  name: "/learn",
  description: "Study top LPers from pools and save lessons",
  handler: async ({ rl, deps, args, rawInput }) => {
    await runBusy(rl, deps, async () => {
      const poolArg = args[0] || null;

      let poolsToStudy: Array<{ pool: string; name: string }> = [];

      if (poolArg) {
        poolsToStudy = [{ pool: poolArg, name: poolArg }];
      } else {
        // Fetch top 10 candidates across all eligible pools
        console.log(colors.dim("\nFetching top pool candidates to study...\n"));
        const topCandidates = await getTopCandidates({ limit: 10 });
        const candidates = (topCandidates as { candidates?: CondensedPool[] }).candidates || [];
        if (!candidates.length) {
          console.log(colors.yellow("No eligible pools found to study.\n"));
          return;
        }
        poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
      }

      console.log(colors.cyan(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`));
      for (const p of poolsToStudy) console.log(colors.dim(`  • ${p.name || p.pool}`));
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
      console.log(colors.dim(`\n${reply}\n`));
    });
  },
};

const cmdEvolve: Command = {
  name: "/evolve",
  description: "Manually trigger threshold evolution from performance data",
  handler: async ({ rl, deps }) => {
    await runBusy(rl, deps, async () => {
      const perf = getPerformanceSummary();
      if (!perf || perf.total_positions_closed < 5) {
        const needed = 5 - (perf?.total_positions_closed || 0);
        console.log(
          colors.yellow(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`)
        );
        return;
      }
      const fs = await import("fs");
      const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
      const result = evolveThresholds(lessonsData.performance, config);
      if (!result || Object.keys(result.changes).length === 0) {
        console.log(
          colors.yellow(
            "\nNo threshold changes needed — current settings already match performance data.\n"
          )
        );
      } else {
        // Import dynamically to avoid circular dependency
        const { reloadScreeningThresholds } = await import("./config/config.js");
        reloadScreeningThresholds();
        console.log(colors.green("\nThresholds evolved:"));
        for (const [key, val] of Object.entries(result.changes)) {
          console.log(
            `  ${colors.cyan(key)}: ${(result.rationale as Record<string, string>)[key]}`
          );
        }
        console.log(colors.green("\nSaved to user-config.json. Applied immediately.\n"));
      }
    });
  },
};

const cmdAuto: Command = {
  name: "auto",
  description: "Let the agent pick and deploy automatically",
  handler: async ({ rl, deps }) => {
    await runBusy(rl, deps, async () => {
      console.log(colors.cyan("\nAgent is picking and deploying...\n"));
      const { content: reply } = await agentLoop(
        `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
        config.llm.maxSteps,
        [],
        "SCREENER"
      );
      console.log(colors.dim(`\n${reply}\n`));
    });
  },
};

const cmdGo: Command = {
  name: "go",
  description: "Start cron without deploying",
  hidden: true,
  handler: async ({ deps, rl }) => {
    const wasAlreadyStarted = deps.isCronStarted ? deps.isCronStarted() : false;
    deps.launchCron();
    if (!wasAlreadyStarted) {
      console.log(colors.green("✓ Autonomous cycles are now running.\n"));
    }
    rl.prompt();
  },
};

// Helper to format command name for display
function cmdName(name: string): string {
  // Add color to slash commands
  if (name.startsWith("/")) {
    return colors.yellow(name);
  }
  return colors.green(name);
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

  // Setup signal handlers first
  setupSignalHandlers(deps);

  // Register all commands
  registerCommand(cmdHelp);
  registerCommand(cmdStop);
  registerCommand(cmdStatus);
  registerCommand(cmdCandidates);
  registerCommand(cmdBriefing);
  registerCommand(cmdThresholds);
  registerCommand(cmdLearn);
  registerCommand(cmdEvolve);
  registerCommand(cmdAuto);
  registerCommand(cmdGo);

  // Load persistent history
  const persistentHistory = loadHistory();

  const rl: ReadlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(deps),
    completer: createCompleter(),
    history: persistentHistory,
    historySize: 100,
  });

  // Store reference for prompt refresh
  _ttyInterface = rl;

  // Intercept console output to track when logs occur (prevents status bar corruption)
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...args: unknown[]) => {
    logUpdate.clear(); // Clear status bar before writing
    _outputSinceLastStatus = true;
    originalLog.apply(console, args);
    drawStatusBar(deps); // Redraw after writing
  };

  console.error = (...args: unknown[]) => {
    logUpdate.clear();
    _outputSinceLastStatus = true;
    originalError.apply(console, args);
    drawStatusBar(deps);
  };

  console.warn = (...args: unknown[]) => {
    logUpdate.clear();
    _outputSinceLastStatus = true;
    originalWarn.apply(console, args);
    drawStatusBar(deps);
  };

  // Save history periodically and on exit
  const historySaveInterval = setInterval(() => {
    // @ts-ignore - history is private but accessible
    saveHistory(rl.history || []);
  }, HISTORY_SAVE_INTERVAL);

  // Update prompt countdown every 30 seconds (slower refresh to reduce log spam)
  const promptRefreshInterval = setInterval(() => {
    if (!busy && _ttyInterface) {
      _ttyInterface.setPrompt(buildPrompt(deps));
    }
  }, 30_000);

  // Wrapper that calls orchestrator's launchCron and adds REPL-specific UI updates
  function launchCron(): void {
    const wasAlreadyStarted = deps.isCronStarted ? deps.isCronStarted() : false;
    deps.launchCron();
    if (!wasAlreadyStarted) {
      console.log(colors.green("✓ Autonomous cycles are now running.\n"));
    }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(
    colors.cyan(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`)
  );

  console.log(colors.dim("Fetching wallet and top pool candidates...\n"));

  busy = true;

  (async () => {
    try {
      const [wallet, positions, topCandidates] = await Promise.all([
        getWalletBalances(),
        getMyPositions({ force: true, silent: true }),
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
      _startupCandidates = candidates;

      console.log(
        colors.cyan("Wallet:    ") +
          colors.white(`${wallet.sol} SOL`) +
          colors.dim(`  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`)
      );
      console.log(
        colors.cyan("Positions: ") +
          colors.white(`${(positions as { total_positions?: number }).total_positions ?? 0} open\n`)
      );

      if ((positions as { total_positions?: number }).total_positions ?? 0 > 0) {
        console.log(colors.bold("Open positions:"));
        for (const p of (positions as { positions?: EnrichedPosition[] }).positions || []) {
          const status = p.in_range ? colors.green("in-range ✓") : colors.yellow("OUT OF RANGE ⚠");
          console.log(
            `  ${colors.white(p.pair.padEnd(16))} ${status}  ${colors.dim("fees: $")}${colors.green(p.unclaimed_fees_usd)}`
          );
        }
        console.log();
      }

      const totalEligible = (topCandidates as { total_eligible?: number }).total_eligible ?? 0;
      const totalScreened = (topCandidates as { total_screened?: number }).total_screened ?? 0;
      console.log(
        colors.bold(
          `Top pools (${colors.cyan(totalEligible.toString())} eligible from ${colors.dim(totalScreened.toString())} screened):\n`
        )
      );
      console.log(formatCandidates(candidates));
    } catch (e) {
      console.error(colors.red(`Startup fetch failed: ${(e as Error).message}`));
    } finally {
      busy = false;

      // Show commands
      console.log(
        colors.cyan(`
Commands:
  ${colors.green("1 / 2 / 3 ...")}  Deploy ${DEPLOY} SOL into that pool
  ${colors.green("auto")}           Let the agent pick and deploy automatically
  ${colors.yellow("/status")}        Refresh wallet + positions
  ${colors.yellow("/candidates")}    Refresh top pool list
  ${colors.yellow("/briefing")}      Show morning briefing (last 24h)
  ${colors.yellow("/learn")}         Study top LPers from the best current pool and save lessons
  ${colors.yellow("/learn <addr>")}  Study top LPers from a specific pool address
  ${colors.yellow("/thresholds")}    Show current screening thresholds + performance stats
  ${colors.yellow("/evolve")}        Manually trigger threshold evolution from performance data
  ${colors.yellow("/help")}          Show all available commands
  ${colors.red("/stop")}            Shut down
`)
      );

      // Start background services (logs autonomous message)
      launchCron();
      deps.maybeRunMissedBriefing().catch(() => {});
      const boundTelegramHandler = (msg: TelegramMessage) => telegramHandler(msg, deps);
      startPolling(boundTelegramHandler);

      // Show prompt after all logs
      rl.prompt();
    }
  })();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Save to persistent history
    appendHistoryEntry(input);

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= _startupCandidates.length) {
      await runBusy(rl, deps, async () => {
        const pool = _startupCandidates[pick - 1];
        console.log(colors.cyan(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`));
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(colors.dim(`\n${reply}\n`));
        launchCron();
      });
      return;
    }

    // ── Command registry lookup ─────────────
    const { command, args, rawInput } = parseCommand(input);

    if (command) {
      await command.handler({ rl, deps, args, rawInput });
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
      console.log(colors.dim(`\n${content}\n`));
    });
  });

  rl.on("close", () => {
    clearInterval(promptRefreshInterval);
    clearInterval(historySaveInterval);
    // @ts-ignore - history is private but accessible
    saveHistory(rl.history || []);
    deps.shutdown("stdin closed");
  });
}

// ═══════════════════════════════════════════
//  NON-TTY MODE
// ═══════════════════════════════════════════
export async function startNonTTY(deps: REPLDependencies): Promise<void> {
  // Setup signal handlers for non-TTY mode too
  setupSignalHandlers(deps);

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
