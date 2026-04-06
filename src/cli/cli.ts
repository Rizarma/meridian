#!/usr/bin/env node
/**
 * meridian — Solana DLMM LP Agent CLI
 * Direct tool invocation with JSON output. Agent-native.
 */

import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import { ParseArgsOptionsConfig, parseArgs } from "util";

import type {
  BlacklistAddOutput,
  BlacklistListOutput,
  CandidatesOutput,
  CLIDieFn,
  CLIFlags,
  CLIOutputFn,
  CLISubcommand,
  CycleOutput,
  EnrichedCandidate,
  EvolveOutput,
  LessonsAddOutput,
  LessonsListOutput,
  PerformanceOutput,
  PoolMemoryOutput,
} from "../types/cli.js";
import type {
  ActiveBinResult,
  PositionPnL,
  PositionsResult,
  SearchPoolsResult,
  WalletPositionsResult,
} from "../types/dlmm.js";
import type { PoolMemoryEntry } from "../types/pool-memory.js";
import type { CondensedPool, TopCandidatesResult } from "../types/screening.js";
import type { WalletPositionCheck } from "../types/smart-wallets.js";
import type {
  TokenHoldersResult,
  TokenInfo,
  TokenInfoResult,
  TokenNarrative,
} from "../types/token.js";

// ─── DRY_RUN must be set before any tool imports ─────────────────
if (process.argv.includes("--dry-run")) process.env.DRY_RUN = "true";

// ─── Load .env from ~/.meridian/ if present ──────────────────────
const meridianDir: string = path.join(os.homedir(), ".meridian");
const meridianEnv: string = path.join(meridianDir, ".env");
if (fs.existsSync(meridianEnv)) {
  const { config: loadDotenv } = await import("dotenv");
  loadDotenv({ path: meridianEnv, override: false });
}

// ─── Output helpers ───────────────────────────────────────────────
/**
 * Output data as formatted JSON to stdout
 * @param data - The data to output
 */
const out: CLIOutputFn = (data: unknown): void => {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
};

/**
 * Output error message as JSON to stderr and exit
 * @param msg - Error message
 * @param extra - Additional error context
 */
const die: CLIDieFn = (msg: string, extra: Record<string, unknown> = {}): never => {
  process.stderr.write(JSON.stringify({ error: msg, ...extra }) + "\n");
  process.exit(1);
};

// ─── SKILL.md generation ──────────────────────────────────────────
const SKILL_MD: string = `# meridian — Solana DLMM LP Agent CLI

Data dir: ~/.meridian/

## Commands

### meridian balance
Returns wallet SOL and token balances.
\`\`\`
Output: { wallet, sol, sol_usd, usdc, tokens: [{mint, symbol, balance, usd_value}], total_usd }
\`\`\`

### meridian positions
Returns all open DLMM positions.
\`\`\`
Output: { positions: [{position, pool, pair, in_range, age_minutes, ...}], total_positions }
\`\`\`

### meridian pnl <position_address>
Returns PnL for a specific position.
\`\`\`
Output: { pnl_pct, pnl_usd, unclaimed_fee_usd, all_time_fees_usd, current_value_usd, lower_bin, upper_bin, active_bin }
\`\`\`

### meridian screen [--dry-run] [--silent]
Runs one AI screening cycle to find and deploy new positions.
\`\`\`
Output: { done: true, report: "..." }
\`\`\`

### meridian manage [--dry-run] [--silent]
Runs one AI management cycle over open positions.
\`\`\`
Output: { done: true, report: "..." }
\`\`\`

### meridian deploy --pool <addr> --amount <sol> [--bins-below 69] [--bins-above 0] [--strategy bid_ask|spot] [--dry-run]
Deploys a new LP position. All safety checks apply.
\`\`\`
Output: { success, position, pool_name, txs, price_range, bin_step }
\`\`\`

### meridian claim --position <addr>
Claims accumulated swap fees for a position.
\`\`\`
Output: { success, position, txs, base_mint }
\`\`\`

### meridian close --position <addr> [--skip-swap] [--dry-run]
Closes a position. Auto-swaps base token to SOL unless --skip-swap.
\`\`\`
Output: { success, pnl_pct, pnl_usd, txs, base_mint }
\`\`\`

### meridian swap --from <mint> --to <mint> --amount <n> [--dry-run]
Swaps tokens via Jupiter. Use "SOL" as mint shorthand.
\`\`\`
Output: { success, tx, input_amount, output_amount }
\`\`\`

### meridian candidates [--limit 5]
Returns top pool candidates fully enriched: pool metrics, token audit, holders, smart wallets, narrative, active bin, pool memory.
\`\`\`
Output: { candidates: [{name, pool, bin_step, fee_pct, volume, tvl, organic_score, active_bin, smart_wallets, token: {holders, audit, global_fees_sol, ...}, holders, narrative, pool_memory}] }
\`\`\`

### meridian study --pool <addr> [--limit 4]
Studies top LPers on a pool. Returns behaviour patterns, hold times, win rates, strategies.
\`\`\`
Output: { pool, patterns: {top_lper_count, avg_hold_hours, avg_win_rate, ...}, lpers: [{owner, summary, positions}] }
\`\`\`

### meridian token-info --query <mint_or_symbol>
Returns token audit, mcap, launchpad, price stats, fee data.
\`\`\`
Output: { results: [{mint, symbol, mcap, launchpad, audit, stats_1h, global_fees_sol, ...}] }
\`\`\`

### meridian token-holders --mint <addr> [--limit 20]
Returns holder distribution, bot %, top holder concentration.
\`\`\`
Output: { mint, holders, top_10_real_holders_pct, bundlers_pct_in_top_100, global_fees_sol, ... }
\`\`\`

### meridian token-narrative --mint <addr>
Returns AI-generated narrative about the token.
\`\`\`
Output: { mint, narrative }
\`\`\`

### meridian pool-detail --pool <addr> [--timeframe 5m]
Returns detailed pool metrics for a specific pool.
\`\`\`
Output: { pool, name, bin_step, fee_pct, volume, tvl, volatility, ... }
\`\`\`

### meridian search-pools --query <name_or_symbol> [--limit 10]
Searches pools by name or token symbol.
\`\`\`
Output: { pools: [{pool, name, bin_step, fee_pct, tvl, volume, ...}] }
\`\`\`

### meridian active-bin --pool <addr>
Returns the current active bin for a pool.
\`\`\`
Output: { pool, binId, price }
\`\`\`

### meridian wallet-positions --wallet <addr>
Returns DLMM positions for any wallet address.
\`\`\`
Output: { wallet, positions: [...], total_positions }
\`\`\`

### meridian config get
Returns the full runtime config.

### meridian config set <key> <value>
Updates a config key. Parses value as JSON when possible.
\`\`\`
Valid keys: minTvl, maxTvl, minVolume, maxPositions, deployAmountSol, managementIntervalMin, screeningIntervalMin, managementModel, screeningModel, generalModel, autoSwapAfterClaim, minClaimAmount, outOfRangeWaitMinutes
\`\`\`

### meridian lessons [--limit 50]
Lists all lessons from lessons.json. Shows rule, tags, pinned status, outcome, role.
\`\`\`
Output: { total, lessons: [{id, rule, tags, outcome, pinned, role, created_at}] }
\`\`\`

### meridian lessons add <text>
Adds a manual lesson with outcome=manual, role=null (applies to all roles).
\`\`\`
Output: { saved: true, rule, outcome, role }
\`\`\`

### meridian pool-memory --pool <addr>
Returns deploy history for a specific pool from pool-memory.json.
\`\`\`
Output: { pool_address, known, name, total_deploys, win_rate, avg_pnl_pct, last_outcome, notes, history }
\`\`\`

### meridian evolve
Runs evolveThresholds() over all closed position data and updates user-config.json.
\`\`\`
Output: { evolved, changes, rationale }
\`\`\`

### meridian blacklist add --mint <addr> --reason <text>
Permanently blacklists a token mint so it is never deployed into.
\`\`\`
Output: { blacklisted, mint, reason }
\`\`\`

### meridian blacklist list
Lists all blacklisted token mints with reasons and timestamps.
\`\`\`
Output: { count, blacklist: [{mint, symbol, reason, added_at}] }
\`\`\`

### meridian performance [--limit 200]
Shows all closed position performance history with summary stats.
\`\`\`
Output: { summary: { total_positions_closed, total_pnl_usd, avg_pnl_pct, win_rate_pct, total_lessons }, count, positions: [...] }
\`\`\`

### meridian start [--dry-run]
Starts the autonomous agent with cron jobs (management + screening).

## Flags
--dry-run     Skip all on-chain transactions
--silent      Suppress Telegram notifications for this run
`;

fs.mkdirSync(meridianDir, { recursive: true });
fs.writeFileSync(path.join(meridianDir, "SKILL.md"), SKILL_MD);

// ─── Parse args ───────────────────────────────────────────────────
const argv: string[] = process.argv.slice(2);
const subcommand: string | undefined = argv.find((a: string) => !a.startsWith("-"));
const sub2: string | undefined = argv.filter((a: string) => !a.startsWith("-"))[1]; // for "config get/set"
const silent: boolean = argv.includes("--silent");

if (!subcommand || subcommand === "help" || argv.includes("--help")) {
  process.stdout.write(SKILL_MD);
  process.exit(0);
}

// ─── Parse flags ──────────────────────────────────────────────────
const parseArgsOptions: ParseArgsOptionsConfig = {
  pool: { type: "string" },
  amount: { type: "string" },
  position: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  strategy: { type: "string" },
  query: { type: "string" },
  mint: { type: "string" },
  wallet: { type: "string" },
  timeframe: { type: "string" },
  reason: { type: "string" },
  "bins-below": { type: "string" },
  "bins-above": { type: "string" },
  "amount-x": { type: "string" },
  "amount-y": { type: "string" },
  bps: { type: "string" },
  "no-claim": { type: "boolean" },
  "skip-swap": { type: "boolean" },
  "dry-run": { type: "boolean" },
  silent: { type: "boolean" },
  limit: { type: "string" },
};

const { values: flags } = parseArgs({
  args: argv,
  options: parseArgsOptions,
  allowPositionals: true,
  strict: false,
});

// Cast flags to CLIFlags for proper typing
const typedFlags = flags as CLIFlags;

// ─── Commands ─────────────────────────────────────────────────────

switch (subcommand as CLISubcommand) {
  // ── balance ──────────────────────────────────────────────────────
  case "balance": {
    const { getWalletBalances } = await import("../../tools/wallet.js");
    out(await getWalletBalances());
    break;
  }

  // ── positions ────────────────────────────────────────────────────
  case "positions": {
    const { getMyPositions } = await import("../../tools/dlmm.js");
    out(await getMyPositions({ force: true }));
    break;
  }

  // ── pnl <position_address> ───────────────────────────────────────
  case "pnl": {
    const posAddr: string | undefined = argv.find(
      (a: string, i: number) =>
        !a.startsWith("-") && i > 0 && argv[i - 1] !== "--position" && a !== "pnl"
    );
    const positionAddress: string | undefined = typedFlags.position || posAddr;
    if (!positionAddress) die("Usage: meridian pnl <position_address>");

    const { getTrackedPosition } = await import("../infrastructure/state.js");
    const { getPositionPnl, getMyPositions } = await import("../../tools/dlmm.js");

    let poolAddress: string | undefined;
    const tracked = getTrackedPosition(positionAddress);
    if (tracked?.pool) {
      poolAddress = tracked.pool;
    } else {
      // Fall back: scan positions to find pool
      const pos: PositionsResult = await getMyPositions({ force: true });
      const found = pos.positions?.find((p) => p.position === positionAddress);
      if (!found) die("Position not found", { position: positionAddress });
      poolAddress = found.pool;
    }

    const pnlResult = await getPositionPnl({
      pool_address: poolAddress,
      position_address: positionAddress,
    });
    // Handle both success and error cases
    if ("error" in pnlResult) {
      out(pnlResult);
    } else {
      const pnl = pnlResult as PositionPnL & { strategy?: string; instruction?: string };
      if (tracked?.strategy) pnl.strategy = tracked.strategy;
      if (tracked?.instruction) pnl.instruction = tracked.instruction;
      out(pnl);
    }
    break;
  }

  // ── candidates ───────────────────────────────────────────────────
  case "candidates": {
    const { getTopCandidates } = await import("../../tools/screening.js");
    const { getActiveBin } = await import("../../tools/dlmm.js");
    const { getTokenInfo, getTokenHolders, getTokenNarrative } = await import(
      "../../tools/token.js"
    );
    const { checkSmartWalletsOnPool } = await import("../domain/smart-wallets.js");
    const { recallForPool } = await import("../domain/pool-memory.js");

    const limit: number = parseInt(typedFlags.limit || "5");
    const raw: TopCandidatesResult = await getTopCandidates({ limit });
    const pools: CondensedPool[] = raw.candidates || [];

    const enriched: EnrichedCandidate[] = [];
    for (const pool of pools) {
      const mint: string | undefined = pool.base?.mint;
      const [activeBin, smartWallets, tokenInfo, holders, narrative] = await Promise.allSettled([
        getActiveBin({ pool_address: pool.pool }),
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve<TokenInfoResult | null>(null),
        mint ? getTokenHolders({ mint }) : Promise.resolve<TokenHoldersResult | null>(null),
        mint ? getTokenNarrative({ mint }) : Promise.resolve<TokenNarrative | null>(null),
      ]);
      const ti: TokenInfo | undefined =
        tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : undefined;
      enriched.push({
        pool: pool.pool,
        name: pool.name,
        bin_step: pool.bin_step ?? 0,
        fee_pct: pool.fee_pct,
        fee_active_tvl_ratio: pool.fee_active_tvl_ratio ?? undefined,
        volume: pool.volume_window ?? 0,
        tvl: pool.active_tvl ?? 0,
        volatility: pool.volatility ?? undefined,
        mcap: pool.mcap ?? undefined,
        organic_score: pool.organic_score,
        active_pct: pool.active_pct ?? undefined,
        price_change_pct: pool.price_change_pct ?? undefined,
        active_bin:
          activeBin.status === "fulfilled"
            ? ((activeBin.value as ActiveBinResult | undefined)?.binId ?? null)
            : null,
        smart_wallets:
          smartWallets.status === "fulfilled"
            ? ((smartWallets.value as WalletPositionCheck | undefined)?.in_pool || []).map(
                (w) => w.name
              )
            : [],
        token: {
          mint,
          symbol: pool.base?.symbol,
          holders: pool.holders,
          mcap: ti?.mcap,
          launchpad: ti?.launchpad,
          global_fees_sol: ti?.global_fees_sol ?? undefined,
          price_change_1h: ti?.stats_1h?.price_change
            ? parseFloat(ti.stats_1h.price_change)
            : undefined,
          net_buyers_1h: ti?.stats_1h?.net_buyers ?? undefined,
          audit: {
            top10_pct: ti?.audit?.top_holders_pct
              ? parseFloat(ti.audit.top_holders_pct)
              : undefined,
            bots_pct: ti?.audit?.bot_holders_pct ? parseFloat(ti.audit.bot_holders_pct) : undefined,
          },
        },
        holders: holders.status === "fulfilled" ? holders.value : null,
        narrative:
          narrative.status === "fulfilled"
            ? ((narrative.value as TokenNarrative | null)?.narrative ?? null)
            : null,
        pool_memory: recallForPool(pool.pool),
      });
      await new Promise((r: (value: void) => void) => setTimeout(r, 150)); // avoid 429s
    }

    const output: CandidatesOutput = { candidates: enriched, total_screened: raw.total_screened };
    out(output);
    break;
  }

  // ── token-info ──────────────────────────────────────────────────
  case "token-info": {
    const query: string | undefined =
      typedFlags.query ||
      typedFlags.mint ||
      argv.find((a: string, i: number) => !a.startsWith("-") && i > 0 && a !== "token-info");
    if (!query) die("Usage: meridian token-info --query <mint_or_symbol>");
    const { getTokenInfo } = await import("../../tools/token.js");
    out(await getTokenInfo({ query }));
    break;
  }

  // ── token-holders ─────────────────────────────────────────────
  case "token-holders": {
    const mint: string | undefined =
      typedFlags.mint ||
      argv.find((a: string, i: number) => !a.startsWith("-") && i > 0 && a !== "token-holders");
    if (!mint) die("Usage: meridian token-holders --mint <addr>");
    const { getTokenHolders } = await import("../../tools/token.js");
    const limit: number = typedFlags.limit ? parseInt(typedFlags.limit) : 20;
    out(await getTokenHolders({ mint, limit }));
    break;
  }

  // ── token-narrative ───────────────────────────────────────────
  case "token-narrative": {
    const mint: string | undefined =
      typedFlags.mint ||
      argv.find((a: string, i: number) => !a.startsWith("-") && i > 0 && a !== "token-narrative");
    if (!mint) die("Usage: meridian token-narrative --mint <addr>");
    const { getTokenNarrative } = await import("../../tools/token.js");
    out(await getTokenNarrative({ mint }));
    break;
  }

  // ── pool-detail ───────────────────────────────────────────────
  case "pool-detail": {
    if (!typedFlags.pool) die("Usage: meridian pool-detail --pool <addr> [--timeframe 5m]");
    const { getPoolDetail } = await import("../../tools/screening.js");
    out(
      await getPoolDetail({
        pool_address: typedFlags.pool,
        timeframe: typedFlags.timeframe || "5m",
      })
    );
    break;
  }

  // ── search-pools ──────────────────────────────────────────────
  case "search-pools": {
    const query: string | undefined =
      typedFlags.query ||
      argv.find((a: string, i: number) => !a.startsWith("-") && i > 0 && a !== "search-pools");
    if (!query) die("Usage: meridian search-pools --query <name_or_symbol>");
    const { searchPools } = await import("../../tools/dlmm.js");
    const limit: number = typedFlags.limit ? parseInt(typedFlags.limit) : 10;
    out(await searchPools({ query, limit }));
    break;
  }

  // ── active-bin ────────────────────────────────────────────────
  case "active-bin": {
    if (!typedFlags.pool) die("Usage: meridian active-bin --pool <addr>");
    const { getActiveBin } = await import("../../tools/dlmm.js");
    out(await getActiveBin({ pool_address: typedFlags.pool }));
    break;
  }

  // ── wallet-positions ──────────────────────────────────────────
  case "wallet-positions": {
    const wallet: string | undefined =
      typedFlags.wallet ||
      argv.find((a: string, i: number) => !a.startsWith("-") && i > 0 && a !== "wallet-positions");
    if (!wallet) die("Usage: meridian wallet-positions --wallet <addr>");
    const { getWalletPositions } = await import("../../tools/dlmm.js");
    out(await getWalletPositions({ wallet_address: wallet }));
    break;
  }

  // ── deploy ───────────────────────────────────────────────────────
  case "deploy": {
    if (!typedFlags.pool) die("Usage: meridian deploy --pool <addr> --amount <sol>");
    const amountX: number | undefined = typedFlags["amount-x"]
      ? parseFloat(typedFlags["amount-x"])
      : undefined;
    if (!typedFlags.amount && !amountX) die("--amount or --amount-x is required");

    const { executeTool } = await import("../../tools/executor.js");
    out(
      await executeTool("deploy_position", {
        pool_address: typedFlags.pool,
        amount_y: typedFlags.amount ? parseFloat(typedFlags.amount) : undefined,
        amount_x: amountX,
        strategy: typedFlags.strategy,
        single_sided_x: argv.includes("--single-sided-x"),
        bins_below: typedFlags["bins-below"] ? parseInt(typedFlags["bins-below"]) : undefined,
        bins_above: typedFlags["bins-above"] ? parseInt(typedFlags["bins-above"]) : undefined,
        allow_duplicate_pool: argv.includes("--allow-duplicate-pool"),
      })
    );
    break;
  }

  // ── claim ────────────────────────────────────────────────────────
  case "claim": {
    if (!typedFlags.position) die("Usage: meridian claim --position <addr>");
    const { executeTool } = await import("../../tools/executor.js");
    out(await executeTool("claim_fees", { position_address: typedFlags.position }));
    break;
  }

  // ── close ────────────────────────────────────────────────────────
  case "close": {
    if (!typedFlags.position) die("Usage: meridian close --position <addr>");
    const { executeTool } = await import("../../tools/executor.js");
    out(
      await executeTool("close_position", {
        position_address: typedFlags.position,
        skip_swap: typedFlags["skip-swap"] ?? false,
      })
    );
    break;
  }

  // ── swap ─────────────────────────────────────────────────────────
  case "swap": {
    if (!typedFlags.from || !typedFlags.to || !typedFlags.amount)
      die("Usage: meridian swap --from <mint> --to <mint> --amount <n>");
    const { executeTool } = await import("../../tools/executor.js");
    out(
      await executeTool("swap_token", {
        input_mint: typedFlags.from,
        output_mint: typedFlags.to,
        amount: parseFloat(typedFlags.amount),
      })
    );
    break;
  }

  // ── screen ───────────────────────────────────────────────────────
  case "screen": {
    const { runScreeningCycle } = await import("../cycles/screening.js");
    const report: string | null = await runScreeningCycle({ silent });
    const output: CycleOutput = { done: true, report: report || "No action taken" };
    out(output);
    break;
  }

  // ── manage ───────────────────────────────────────────────────────
  case "manage": {
    const { runManagementCycle } = await import("../orchestrator.js");
    const report: string | null = await runManagementCycle({ silent });
    const output: CycleOutput = { done: true, report: report || "No action taken" };
    out(output);
    break;
  }

  // ── config ───────────────────────────────────────────────────────
  case "config": {
    if (sub2 === "get" || !sub2) {
      const { config } = await import("../config/config.js");
      out(config as unknown as Record<string, unknown>);
    } else if (sub2 === "set") {
      const key: string | undefined = argv.filter((a: string) => !a.startsWith("-"))[2];
      const rawVal: string | undefined = argv.filter((a: string) => !a.startsWith("-"))[3];
      if (!key || rawVal === undefined) die("Usage: meridian config set <key> <value>");
      let value: unknown = rawVal;
      try {
        value = JSON.parse(rawVal);
      } catch {
        /* keep as string */
      }
      const { executeTool } = await import("../../tools/executor.js");
      out(
        await executeTool("update_config", { changes: { [key]: value }, reason: "CLI config set" })
      );
    } else {
      die(`Unknown config subcommand: ${sub2}. Use: get, set`);
    }
    break;
  }

  // ── study ────────────────────────────────────────────────────────
  case "study": {
    if (!typedFlags.pool) die("Usage: meridian study --pool <addr> [--limit 4]");
    const { studyTopLPers } = await import("../../tools/study.js");
    const limit: number = typedFlags.limit ? parseInt(typedFlags.limit) : 4;
    out(await studyTopLPers({ pool_address: typedFlags.pool, limit }));
    break;
  }

  // ── start ────────────────────────────────────────────────────────
  case "start": {
    const { startCronJobs } = await import("../orchestrator.js");
    process.stderr.write("[meridian] Starting autonomous agent...\n");
    startCronJobs();
    break;
  }

  // ── lessons ──────────────────────────────────────────────────────
  case "lessons": {
    if (sub2 === "add") {
      const text: string = argv
        .filter((a: string) => !a.startsWith("-"))
        .slice(2)
        .join(" ");
      if (!text) die("Usage: meridian lessons add <text>");
      const { addLesson } = await import("../domain/lessons.js");
      addLesson(text, [], { pinned: false, role: null });
      const output: LessonsAddOutput = { saved: true, rule: text, outcome: "manual", role: null };
      out(output);
    } else {
      const { listLessons } = await import("../domain/lessons.js");
      const limit: number = typedFlags.limit ? parseInt(typedFlags.limit) : 50;
      out(listLessons({ limit }) as unknown as LessonsListOutput);
    }
    break;
  }

  // ── pool-memory ──────────────────────────────────────────────────
  case "pool-memory": {
    if (!typedFlags.pool) die("Usage: meridian pool-memory --pool <addr>");
    const { getPoolMemory } = await import("../domain/pool-memory.js");
    out(getPoolMemory({ pool_address: typedFlags.pool }) as unknown as PoolMemoryOutput);
    break;
  }

  // ── evolve ───────────────────────────────────────────────────────
  case "evolve": {
    const { config } = await import("../config/config.js");
    const { evolveThresholds } = await import("../domain/threshold-evolution.js");
    const fs2: typeof fs = await import("fs");
    const lessonsFile: string = "./lessons.json";
    interface LessonsData {
      performance?: Array<Record<string, unknown>>;
    }
    let perfData: Array<Record<string, unknown>> = [];
    if (fs2.existsSync(lessonsFile)) {
      try {
        const data: LessonsData = JSON.parse(fs2.readFileSync(lessonsFile, "utf8")) as LessonsData;
        perfData = data.performance || [];
      } catch {
        /* no data */
      }
    }
    const result = evolveThresholds(
      perfData as unknown as import("../types/lessons.js").PerformanceRecord[],
      config
    );
    if (!result) {
      const output: EvolveOutput = {
        evolved: false,
        reason: `Need at least 5 closed positions (have ${perfData.length})`,
      };
      out(output);
    } else {
      const rationaleStr = Object.entries(result.rationale)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ");
      const output: EvolveOutput = {
        evolved: Object.keys(result.changes).length > 0,
        changes: result.changes,
        rationale: rationaleStr,
      };
      out(output);
    }
    break;
  }

  // ── blacklist ────────────────────────────────────────────────────
  case "blacklist": {
    if (sub2 === "add") {
      if (!typedFlags.mint) die("Usage: meridian blacklist add --mint <addr> --reason <text>");
      if (!typedFlags.reason) die("--reason is required");
      const { addToBlacklist } = await import("../domain/token-blacklist.js");
      out(
        addToBlacklist({
          mint: typedFlags.mint,
          reason: typedFlags.reason,
        }) as unknown as BlacklistAddOutput
      );
    } else if (sub2 === "list" || !sub2) {
      const { listBlacklist } = await import("../domain/token-blacklist.js");
      out(listBlacklist() as unknown as BlacklistListOutput);
    } else {
      die(`Unknown blacklist subcommand: ${sub2}. Use: add, list`);
    }
    break;
  }

  // ── performance ──────────────────────────────────────────────────
  case "performance": {
    const { getPerformanceHistory, getPerformanceSummary } = await import("../domain/lessons.js");
    const limit: number = typedFlags.limit ? parseInt(typedFlags.limit) : 200;
    const history = getPerformanceHistory({ hours: 999999, limit });
    const summary = getPerformanceSummary();
    const output: PerformanceOutput = {
      summary: summary as PerformanceOutput["summary"],
      count: history.count,
      positions: history.positions,
    };
    out(output);
    break;
  }

  // ── withdraw-liquidity ─────────────────────────────────────────
  case "withdraw-liquidity": {
    if (!typedFlags.position)
      die("Usage: meridian withdraw-liquidity --position <addr> --pool <addr> [--bps 10000]");
    if (!typedFlags.pool) die("--pool is required");
    const dlmmModule = await import("../../tools/dlmm.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withdrawLiquidity = (dlmmModule as Record<string, unknown>).withdrawLiquidity as (
      ...args: unknown[]
    ) => Promise<unknown>;
    out(
      await withdrawLiquidity({
        position_address: typedFlags.position,
        pool_address: typedFlags.pool,
        bps: typedFlags.bps ? parseInt(typedFlags.bps) : 10000,
        claim_fees: !argv.includes("--no-claim"),
      })
    );
    break;
  }

  // ── add-liquidity ──────────────────────────────────────────────
  case "add-liquidity": {
    if (!typedFlags.position)
      die(
        "Usage: meridian add-liquidity --position <addr> --pool <addr> [--amount-x <n>] [--amount-y <n>]"
      );
    if (!typedFlags.pool) die("--pool is required");
    const dlmmModule = await import("../../tools/dlmm.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addLiquidity = (dlmmModule as Record<string, unknown>).addLiquidity as (
      ...args: unknown[]
    ) => Promise<unknown>;
    out(
      await addLiquidity({
        position_address: typedFlags.position,
        pool_address: typedFlags.pool,
        amount_x: typedFlags["amount-x"] ? parseFloat(typedFlags["amount-x"]) : 0,
        amount_y: typedFlags["amount-y"] ? parseFloat(typedFlags["amount-y"]) : 0,
        strategy: typedFlags.strategy || "spot",
        single_sided_x: argv.includes("--single-sided-x"),
      })
    );
    break;
  }

  default:
    die(`Unknown command: ${subcommand}. Run 'meridian help' for usage.`);
}
