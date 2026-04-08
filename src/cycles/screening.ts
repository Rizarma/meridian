import { Mutex } from "async-mutex";
import { getActiveBin, getMyPositions } from "../../tools/dlmm.js";
import { getTopCandidates } from "../../tools/screening.js";
import { getTokenInfo, getTokenNarrative } from "../../tools/token.js";
import { getWalletBalances } from "../../tools/wallet.js";
import { agentLoop } from "../agent/agent.js";
import { computeDeployAmount, config } from "../config/config.js";
import { recallForPool } from "../domain/pool-memory.js";
import { checkSmartWalletsOnPool } from "../domain/smart-wallets.js";
import { log } from "../infrastructure/logger.js";
import {
  createLiveMessage,
  sendMessage,
  isEnabled as telegramEnabled,
} from "../infrastructure/telegram.js";
import type {
  CondensedPool,
  CycleOptions,
  EnrichedPosition,
  FilteredExample,
  LiveMessageHandler,
  ReconCandidate,
} from "../types/index.js";

// Module-level state for race condition guards
let _screeningBusy = false;
let _screeningLastTriggered = 0;
const screeningMutex = new Mutex();

/** Strip reasoning blocks that some models leak into output */
function stripThink(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function sanitizeUntrustedPromptText(
  text: string | null | undefined,
  maxLen = 500
): string | null {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

// Race guard accessors for external modules (e.g., management.ts)
export function getScreeningLastTriggered(): number {
  return _screeningLastTriggered;
}

export function setScreeningLastTriggered(time: number): void {
  _screeningLastTriggered = time;
}

export function isScreeningBusy(): boolean {
  return _screeningBusy;
}

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
  return screeningMutex.runExclusive(async () => {
    const { silent = false } = options;

    // Use deps functions if provided, otherwise use module-level state
    const setBusy =
      deps?.setScreeningBusy ??
      ((busy: boolean) => {
        _screeningBusy = busy;
      });
    const setLastTriggered =
      deps?.setScreeningLastTriggered ??
      ((time: number) => {
        _screeningLastTriggered = time;
      });

    setBusy(true); // set immediately — mutex ensures atomic check-and-set
    setLastTriggered(Date.now()); // CRITICAL: race condition guard must be set at start

    // Hard guards — don't even run the agent if preconditions aren't met
    let prePositions: { total_positions: number; positions?: EnrichedPosition[] };
    let preBalance: { sol: number };
    let liveMessage: LiveMessageHandler | null = null;
    let screenReport: string | null = null;
    try {
      const [positionsResult, balanceResult] = await Promise.all([
        getMyPositions({ force: true }),
        getWalletBalances(),
      ]);
      prePositions = positionsResult as unknown as {
        total_positions: number;
        positions?: EnrichedPosition[];
      };
      preBalance = balanceResult as { sol: number };
      if (prePositions.total_positions >= config.risk.maxPositions) {
        log(
          "cron",
          `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`
        );
        screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
        setBusy(false);
        return screenReport;
      }
      const minRequired = config.management.deployAmountSol + config.management.gasReserve;
      const isDryRun = process.env.DRY_RUN === "true";
      if (!isDryRun && preBalance.sol < minRequired) {
        log(
          "cron",
          `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`
        );
        screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
        setBusy(false);
        return screenReport;
      }
    } catch (e) {
      log("cron_error", `Screening pre-check failed: ${(e as Error).message}`);
      screenReport = `Screening pre-check failed: ${(e as Error).message}`;
      setBusy(false);
      return screenReport;
    }
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
    }
    if (deps?.timers) {
      deps.timers.screeningLastRun = Date.now();
    }
    log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
    try {
      // Reuse pre-fetched balance — no extra RPC call needed
      const currentBalance = preBalance;
      const deployAmount = computeDeployAmount(currentBalance.sol);
      log(
        "cron",
        `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`
      );

      // Load active strategy
      const { getActiveStrategy } = await import("../domain/strategy-library.js");
      const activeStrategy = getActiveStrategy();
      const strategyBlock = activeStrategy
        ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${(activeStrategy.range as { bins_above?: number })?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
        : `No active strategy — use default bid_ask, bins_above: 0, SOL only.`;

      // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
      const topCandidatesResult = await getTopCandidates({
        limit: config.screening.maxCandidatesEnriched,
      }).catch((e: unknown): null => {
        log("screening_warn", `Failed to fetch top candidates: ${(e as Error).message}`);
        return null;
      });
      const {
        candidates: initialCandidates,
        filtered_examples: earlyFilteredExamples,
      }: {
        candidates: CondensedPool[];
        filtered_examples: FilteredExample[];
      } = topCandidatesResult ?? {
        candidates: [],
        filtered_examples: [],
      };
      const candidates = initialCandidates ?? [];

      // Array for late-stage filtered examples
      const lateFilteredExamples: FilteredExample[] = [];

      const allCandidates: ReconCandidate[] = [];
      for (const pool of candidates) {
        const mint = pool.base?.mint;
        const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
          checkSmartWalletsOnPool({ pool_address: pool.pool }),
          mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
          mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
        ]);
        allCandidates.push({
          pool,
          sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
          n: narrative.status === "fulfilled" ? narrative.value : null,
          ti: tokenInfo.status === "fulfilled" ? tokenInfo.value : null,
          mem: recallForPool(pool.pool),
        });
        await new Promise((r) => setTimeout(r, 150)); // avoid 429s
      }

      // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
      const passing = allCandidates.filter(({ pool, ti }) => {
        const tokenInfo = ti as {
          results?: Array<{
            launchpad?: string;
            audit?: { bot_holders_pct?: number };
          }>;
        } | null;
        const launchpad = tokenInfo?.results?.[0]?.launchpad ?? null;

        // Launchpad allow filter
        const allowlist = config.screening.allowedLaunchpads;
        if (allowlist && allowlist.length > 0 && (!launchpad || !allowlist.includes(launchpad))) {
          log(
            "screening",
            `Skipping ${pool.name} — no launchpad / not in allowlist (${launchpad ?? "unknown"})`
          );
          lateFilteredExamples.push({
            pool_address: pool.pool,
            name: pool.name || "Unknown",
            filter_reason: "No launchpad / not in allowlist",
          });
          return false;
        }

        // Launchpad block filter
        if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
          log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
          lateFilteredExamples.push({
            pool_address: pool.pool,
            name: pool.name || "Unknown",
            filter_reason: "In launchpad blocklist",
          });
          return false;
        }

        // Bot holders filter
        const botPct = tokenInfo?.results?.[0]?.audit?.bot_holders_pct;
        const maxBotHoldersPct = config.screening.maxBotHoldersPct;
        if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
          log(
            "screening",
            `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`
          );
          lateFilteredExamples.push({
            pool_address: pool.pool,
            name: pool.name || "Unknown",
            filter_reason: "Bot holders check failed",
          });
          return false;
        }
        return true;
      });

      // Prioritize late examples (more informative - survived early screening)
      const examplesToShow = [
        ...lateFilteredExamples.slice(0, 2),
        ...earlyFilteredExamples.slice(0, 1),
      ];

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

      // Pre-fetch active_bin for all passing candidates in parallel
      const activeBinResults = await Promise.allSettled(
        passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
      );

      // Build compact candidate blocks
      const candidateBlocks = passing.map(({ pool, sw, n, ti, mem }, i) => {
        const tokenInfo = ti as {
          results?: Array<{
            audit?: { bot_holders_pct?: number; top_holders_pct?: number };
            global_fees_sol?: number;
            launchpad?: string;
            stats_1h?: { price_change?: number; net_buyers?: number };
          }>;
        } | null;
        const botPct = tokenInfo?.results?.[0]?.audit?.bot_holders_pct ?? "?";
        const top10Pct = tokenInfo?.results?.[0]?.audit?.top_holders_pct ?? "?";
        const feesSol = tokenInfo?.results?.[0]?.global_fees_sol ?? "?";
        const launchpad = tokenInfo?.results?.[0]?.launchpad ?? null;
        const priceChange = tokenInfo?.results?.[0]?.stats_1h?.price_change;
        const netBuyers = tokenInfo?.results?.[0]?.stats_1h?.net_buyers;
        const activeBinResult = activeBinResults[i];
        const activeBin =
          activeBinResult?.status === "fulfilled"
            ? (activeBinResult.value as { binId?: number } | null)?.binId
            : null;

        // OKX signals
        const okxParts = [
          pool.risk_level != null ? `risk=${pool.risk_level}` : null,
          pool.bundle_pct != null ? `bundle=${pool.bundle_pct}%` : null,
          pool.sniper_pct != null ? `sniper=${pool.sniper_pct}%` : null,
          pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%` : null,
          pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%` : null,
          pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
          pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
        ]
          .filter(Boolean)
          .join(", ");
        const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;

        const okxTags = [
          pool.smart_money_buy ? "smart_money_buy" : null,
          pool.kol_in_clusters ? "kol_in_clusters" : null,
          pool.dex_boost ? "dex_boost" : null,
          pool.dex_screener_paid ? "dex_screener_paid" : null,
          pool.dev_sold_all ? "dev_sold_all(bullish)" : null,
        ]
          .filter(Boolean)
          .join(", ");

        const smartWalletResult = sw as { in_pool?: Array<{ name: string }> } | null;

        const block = [
          `POOL: ${pool.name} (${pool.pool})`,
          `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
          `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
          okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
          okxTags ? `  tags: ${okxTags}` : null,
          pool.price_vs_ath_pct != null
            ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}`
            : null,
          `  smart_wallets: ${smartWalletResult?.in_pool?.length ?? 0} present${smartWalletResult?.in_pool?.length ? ` → CONFIDENCE BOOST (${smartWalletResult.in_pool.map((w) => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          priceChange != null
            ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}`
            : null,
          n && (n as { narrative?: string }).narrative
            ? `  narrative_untrusted: ${sanitizeUntrustedPromptText((n as { narrative?: string }).narrative, 500)}`
            : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ]
          .filter(Boolean)
          .join("\n");

        return block;
      });

      const { content } = await agentLoop(
        `
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
2. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   bins_below = round(35 + (volatility/5)*55) clamped to [35,90].
3. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Downside buffer: <negative %>

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
4. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- Keep the whole report compact and highly scannable for Telegram.
      `,
        config.llm.maxSteps,
        [],
        "SCREENER",
        config.llm.screeningModel,
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
      screenReport = content;
    } catch (error) {
      log("cron_error", `Screening cycle failed: ${(error as Error).message}`);
      screenReport = `Screening cycle failed: ${(error as Error).message}`;
    } finally {
      setBusy(false);
      if (!silent && telegramEnabled()) {
        if (screenReport) {
          if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
          else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => {});
        }
      }
    }
    return screenReport;
  });
}
