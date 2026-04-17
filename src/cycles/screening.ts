import { getActiveBin, getMyPositions } from "../../tools/dlmm.js";
import { getTopCandidates } from "../../tools/screening.js";
import { getTokenInfo, getTokenNarrative } from "../../tools/token.js";
import { getWalletBalances } from "../../tools/wallet.js";
import { agentLoop } from "../agent/agent.js";
import { computeDeployAmount, config } from "../config/config.js";
import { LIMITS, LLM, SCREENING } from "../config/constants.js";
import { recallForPool } from "../domain/pool-memory.js";
import { loadWeights } from "../domain/signal-weights.js";
import { checkSmartWalletsOnPool } from "../domain/smart-wallets.js";
import { cycleState } from "../infrastructure/cycle-state.js";
import { log } from "../infrastructure/logger.js";
import {
  createLiveMessage,
  getLastScreeningMessageId,
  sendMessage,
  setLastScreeningMessageId,
  isEnabled as telegramEnabled,
  updateExistingLiveMessage,
} from "../infrastructure/telegram.js";
import type {
  CondensedPool,
  CycleOptions,
  EnrichedPosition,
  FilteredExample,
  LiveMessageHandler,
  ReconCandidate,
} from "../types/index.js";
import { getErrorMessage } from "../utils/errors.js";
import {
  isValidBalanceResponse,
  isValidNarrativeResponse,
  isValidPositionsResponse,
  isValidSmartWalletResponse,
  isValidTokenInfoResponse,
} from "../utils/validation-args.js";

// ═══════════════════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════════════════

interface ScoredCandidate {
  candidate: ReconCandidate;
  score: number;
  activeBin: number | null;
}

interface PreFlightData {
  prePositions: { total_positions: number; positions?: EnrichedPosition[] };
  preBalance: { sol: number };
  liveMessage: LiveMessageHandler | null;
}

interface CandidateFetchResult {
  candidates: ReconCandidate[];
  earlyFiltered: FilteredExample[];
}

interface LateFilterResult {
  passing: ReconCandidate[];
  lateFiltered: FilteredExample[];
}

/**
 * Format a report with divider, timestamp, and next screening time footer.
 */
function formatReportWithTimestamp(report: string, scheduled = false): string {
  const now = new Date();
  const timestamp = `🕐 ${now.getDate().toString().padStart(2, "0")} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][now.getMonth()]} ${now.getFullYear().toString().slice(2)} ${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;

  // Calculate next screening time
  const nextScreening = new Date(now.getTime() + config.schedule.screeningIntervalMin * 60 * 1000);
  const nextScreeningTime = `⏭️ Next: ${nextScreening.getDate().toString().padStart(2, "0")} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][nextScreening.getMonth()]} ${nextScreening.getHours().toString().padStart(2, "0")}:${nextScreening.getMinutes().toString().padStart(2, "0")} (${scheduled ? "scheduled" : "manual"})`;

  return `${report}\n\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n${timestamp} | ${nextScreeningTime}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Weighted Candidate Scoring
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute a weighted composite score for a candidate based on signal weights.
 * Higher score = better candidate based on historical performance.
 */
function computeCandidateScore(candidate: ReconCandidate, weights: Record<string, number>): number {
  const { pool, sw, n } = candidate;
  let score = 0;

  // Normalize and weight numeric signals (0-1 scale * weight)
  // organic_score: 0-100 scale
  if (pool.organic_score != null) {
    score += (pool.organic_score / 100) * (weights.organic_score ?? 1.0);
  }

  // fee_tvl_ratio: typically 0-5%, normalize to 0-1 (cap at 5%)
  if (pool.fee_active_tvl_ratio != null) {
    const normalizedFeeTvl = Math.min(pool.fee_active_tvl_ratio / 5, 1);
    score += normalizedFeeTvl * (weights.fee_tvl_ratio ?? 1.0);
  }

  // volume: log scale, normalize (cap at $1M)
  if (pool.volume_window != null && pool.volume_window > 0) {
    const normalizedVol = Math.min(Math.log10(pool.volume_window) / 6, 1);
    score += normalizedVol * (weights.volume ?? 1.0);
  }

  // mcap: log scale, normalize (sweet spot $100K-$10M)
  if (pool.mcap != null && pool.mcap > 0) {
    const normalizedMcap = Math.min(Math.max(Math.log10(pool.mcap) / 8, 0), 1);
    score += normalizedMcap * (weights.mcap ?? 1.0);
  }

  // holders: normalize (cap at 10K)
  if (pool.holders != null) {
    const normalizedHolders = Math.min(pool.holders / 10000, 1);
    score += normalizedHolders * (weights.holder_count ?? 1.0);
  }

  // volatility: inverted — moderate volatility is good (2-5 range)
  if (pool.volatility != null) {
    // Ideal volatility: 2-5, score peaks at 3.5
    const volScore = Math.max(0, 1 - Math.abs(pool.volatility - 3.5) / 5);
    score += volScore * (weights.volatility ?? 1.0);
  }

  // Boolean signals - validate before using
  const smartWalletResult = isValidSmartWalletResponse(sw) ? sw : null;
  if (smartWalletResult?.in_pool?.length) {
    score += (weights.smart_wallets_present ?? 1.0) * 0.5; // bonus for smart wallets
  }

  // Narrative quality (categorical) - validate before using
  const narrativeResult = isValidNarrativeResponse(n) ? n : null;
  const narrative = narrativeResult?.narrative;
  if (narrative && narrative.length > 50) {
    // Simple heuristic: longer, specific narrative = better
    score += (weights.narrative_quality ?? 1.0) * 0.3;
  }

  // Risk penalties (multiplicative)
  if (pool.is_rugpull) score *= 0.3;
  if (pool.is_wash) score *= 0.1;
  if (pool.risk_level != null && pool.risk_level >= 4) score *= 0.7;
  if (pool.bundle_pct != null && pool.bundle_pct > 40) score *= 0.8;

  // OKX bullish tags bonus
  if (pool.smart_money_buy) score *= 1.1;
  if (pool.dev_sold_all) score *= 1.05;

  return Math.round(score * 1000) / 1000;
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
 * Sanitize untrusted prompt text for safe inclusion in LLM prompts.
 * Removes newlines, special characters, and truncates to max length.
 */
export function sanitizeUntrustedPromptText(
  text: string | null | undefined,
  maxLen = LIMITS.MAX_PROMPT_SANITIZE_LENGTH
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

/**
 * Run pre-flight checks before screening cycle.
 * Validates positions count and SOL balance.
 *
 * @param silent - Whether to suppress Telegram notifications
 * @returns Pre-flight data or error message
 */
async function runPreFlightChecks(silent: boolean): Promise<PreFlightData | { error: string }> {
  let liveMessage: LiveMessageHandler | null = null;

  try {
    const [positionsResult, balanceResult] = await Promise.all([
      getMyPositions({ force: true }),
      getWalletBalances(),
    ]);

    // Validate API responses before type assertions
    if (!isValidPositionsResponse(positionsResult)) {
      log("cron_error", "Invalid positions response format from getMyPositions");
      return { error: "Screening failed: Invalid positions data format." };
    }
    if (!isValidBalanceResponse(balanceResult)) {
      log("cron_error", "Invalid balance response format from getWalletBalances");
      return { error: "Screening failed: Invalid balance data format." };
    }

    const prePositions = positionsResult as unknown as {
      total_positions: number;
      positions?: EnrichedPosition[];
    };
    const preBalance = balanceResult;

    // Check max positions limit
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log(
        "cron",
        `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`
      );
      return {
        error: `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`,
      };
    }

    // Check SOL balance (skip in dry-run mode)
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log(
        "cron",
        `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`
      );
      return {
        error: `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`,
      };
    }

    // Create or update live message if Telegram is enabled
    if (!silent && telegramEnabled()) {
      const existingMessageId = getLastScreeningMessageId();
      if (existingMessageId) {
        // Try to update existing message
        liveMessage = await updateExistingLiveMessage(
          "🔍 Screening Cycle",
          "Scanning candidates...",
          existingMessageId
        );
        if (!liveMessage) {
          // Failed to update (message deleted or too old), create new
          liveMessage = await createLiveMessage(
            "🔍 Screening Cycle",
            "Scanning candidates...",
            "screening"
          );
        }
      } else {
        // No existing message or too old, create new
        liveMessage = await createLiveMessage(
          "🔍 Screening Cycle",
          "Scanning candidates...",
          "screening"
        );
      }
    }

    return { prePositions, preBalance, liveMessage };
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${getErrorMessage(e)}`);
    return { error: `Screening pre-check failed: ${getErrorMessage(e)}` };
  }
}

/**
 * Fetch and enrich candidates with smart wallet, narrative, and token info.
 *
 * @param limit - Maximum number of candidates to fetch
 * @returns Enriched candidates and early filtered examples
 */
async function fetchAndEnrichCandidates(limit: number): Promise<CandidateFetchResult> {
  const topCandidatesResult = await getTopCandidates({ limit }).catch((e: unknown): null => {
    log("screening_warn", `Failed to fetch top candidates: ${getErrorMessage(e)}`);
    return null;
  });

  const {
    candidates: initialCandidates,
    filtered_examples: earlyFiltered,
  }: {
    candidates: CondensedPool[];
    filtered_examples: FilteredExample[];
  } = topCandidatesResult ?? {
    candidates: [],
    filtered_examples: [],
  };

  const candidates = initialCandidates ?? [];
  const enrichedCandidates: ReconCandidate[] = [];

  // Enrich each candidate with additional data
  for (const pool of candidates) {
    const mint = pool.base?.mint;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: pool.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);

    enrichedCandidates.push({
      pool,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value : null,
      mem: recallForPool(pool.pool),
    });

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, SCREENING.RECON_DELAY_MS));
  }

  return { candidates: enrichedCandidates, earlyFiltered };
}

/**
 * Apply late-stage filters to enriched candidates.
 * Filters out candidates based on launchpad and bot holder criteria.
 *
 * @param candidates - Enriched candidates to filter
 * @returns Passing candidates and filtered examples with reasons
 */
function applyLateFilters(candidates: ReconCandidate[]): LateFilterResult {
  const lateFiltered: FilteredExample[] = [];

  const passing = candidates.filter(({ pool, ti }) => {
    // Validate token info response before using
    const tokenInfo = isValidTokenInfoResponse(ti) ? ti : null;
    const launchpad = tokenInfo?.results?.[0]?.launchpad ?? null;

    // Launchpad allow filter
    const allowlist = config.screening.allowedLaunchpads;
    if (allowlist && allowlist.length > 0 && (!launchpad || !allowlist.includes(launchpad))) {
      log(
        "screening",
        `Skipping ${pool.name} — no launchpad / not in allowlist (${launchpad ?? "unknown"})`
      );
      lateFiltered.push({
        pool_address: pool.pool,
        name: pool.name || "Unknown",
        filter_reason: "No launchpad / not in allowlist",
      });
      return false;
    }

    // Launchpad block filter
    if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
      log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
      lateFiltered.push({
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
      lateFiltered.push({
        pool_address: pool.pool,
        name: pool.name || "Unknown",
        filter_reason: "Bot holders check failed",
      });
      return false;
    }

    return true;
  });

  return { passing, lateFiltered };
}

/**
 * Score and rank candidates by weighted composite score.
 * Also fetches active bin for each passing candidate.
 *
 * @param candidates - Candidates to score
 * @returns Scored and sorted candidates (highest score first)
 */
async function scoreAndRankCandidates(candidates: ReconCandidate[]): Promise<ScoredCandidate[]> {
  // Pre-fetch active_bin for all candidates in parallel
  const activeBinResults = await Promise.allSettled(
    candidates.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
  );

  const weights = loadWeights().weights;

  const scoredCandidates: ScoredCandidate[] = candidates.map((candidate, i) => ({
    candidate,
    score: computeCandidateScore(candidate, weights),
    activeBin:
      activeBinResults[i]?.status === "fulfilled"
        ? ((activeBinResults[i].value as { binId?: number } | null)?.binId ?? null)
        : null,
  }));

  // Sort by score descending (highest first)
  scoredCandidates.sort((a, b) => b.score - a.score);

  // Log ranking for debugging
  log(
    "screening",
    `Candidate ranking: ${scoredCandidates
      .map((s) => `${s.candidate.pool.name}(${s.score})`)
      .join(", ")}`
  );

  return scoredCandidates;
}

/**
 * Build candidate prompt blocks for LLM evaluation.
 * Creates formatted text blocks for each top candidate.
 *
 * @param scoredCandidates - Scored candidates to build blocks for
 * @param topN - Number of top candidates to include
 * @returns Array of formatted candidate blocks
 */
function buildCandidateBlocks(scoredCandidates: ScoredCandidate[], topN: number): string[] {
  const topCandidates = scoredCandidates.slice(0, Math.min(topN, scoredCandidates.length));

  return topCandidates.map(({ candidate: { pool, sw, n, ti, mem }, score, activeBin }) => {
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
        ? `  narrative_untrusted: ${sanitizeUntrustedPromptText((n as { narrative?: string }).narrative, LIMITS.MAX_PROMPT_SANITIZE_LENGTH)}`
        : `  narrative_untrusted: none`,
      mem
        ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, LIMITS.MAX_PROMPT_SANITIZE_LENGTH)}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    return block;
  });
}

/**
 * Build the screening prompt for the LLM agent.
 *
 * @param strategyBlock - Active strategy description
 * @param prePositions - Current positions data
 * @param deployAmount - Computed deploy amount in SOL
 * @param scoredCandidates - All scored candidates for ranking display
 * @param candidateBlocks - Formatted candidate blocks for top candidates
 * @returns Complete prompt string for the screening agent
 */
function buildScreeningPrompt(
  strategyBlock: string,
  prePositions: { total_positions: number },
  deployAmount: number,
  scoredCandidates: ScoredCandidate[],
  candidateBlocks: string[]
): string {
  return `
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${preBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

CANDIDATE RANKING (by weighted score from historical performance):
${scoredCandidates.map((s, i) => `${i + 1}. ${s.candidate.pool.name}: ${s.score}`).join("\n")}

TOP CANDIDATES FOR EVALUATION (${candidateBlocks.length} of ${scoredCandidates.length} passing pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Pick the best candidate from the TOP CANDIDATES above. These are already ranked by weighted signal score based on historical profitability.
2. Consider the SIGNAL WEIGHTS in your system prompt — signals with higher weights have proven more predictive of success.
3. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   bins_below = round(35 + (volatility/5)*55) clamped to [35,90].
4. Report in this exact format (no tables, no extra sections):
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
5. If no pool qualifies, report in this exact format instead:
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
  `;
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

// Module-level variable to hold preBalance for prompt building
let preBalance: { sol: number } = { sol: 0 };

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
          // ... rest of message handling
          const existingMessageId = getLastScreeningMessageId();
          if (existingMessageId) {
            const updated = await updateExistingLiveMessage(
              "🔍 Screening Cycle",
              formattedReport,
              existingMessageId
            );
            if (!updated) {
              const sent = await sendMessage(`🔍 Screening Cycle\n\n${formattedReport}`);
              if (sent && typeof sent === "object" && "message_id" in sent) {
                setLastScreeningMessageId((sent as { message_id: number }).message_id);
              }
            }
          } else {
            const sent = await sendMessage(`🔍 Screening Cycle\n\n${formattedReport}`);
            if (sent && typeof sent === "object" && "message_id" in sent) {
              setLastScreeningMessageId((sent as { message_id: number }).message_id);
            }
          }
        }
        return screenReport;
      }

      const { prePositions, preBalance: balance, liveMessage: msg } = preFlightResult;
      preBalance = balance;
      liveMessage = msg;

      if (deps?.timers) {
        deps.timers.screeningLastRun = Date.now();
      }

      log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);

      // Compute deploy amount
      const deployAmount = computeDeployAmount(preBalance.sol);
      log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${preBalance.sol} SOL)`);

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

      // Take top N candidates for LLM evaluation
      const topCandidatesForLLM = scoredCandidates.slice(0, Math.min(5, scoredCandidates.length));

      // Build candidate blocks
      const candidateBlocks = buildCandidateBlocks(topCandidatesForLLM, 5);

      // Build and send screening prompt
      const prompt = buildScreeningPrompt(
        strategyBlock,
        prePositions,
        deployAmount,
        scoredCandidates,
        candidateBlocks
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
            // No live message handler - check if we have an existing message to update
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
                if (sent && typeof sent === "object" && "message_id" in sent) {
                  setLastScreeningMessageId((sent as { message_id: number }).message_id);
                }
              }
            } else {
              // No existing message, create new
              const sent = await sendMessage(`🔍 Screening Cycle\n\n${formattedReport}`);
              if (sent && typeof sent === "object" && "message_id" in sent) {
                setLastScreeningMessageId((sent as { message_id: number }).message_id);
              }
            }
          }
        }
      }
    }
    return screenReport;
  });
}
