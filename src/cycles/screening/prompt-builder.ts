import { config } from "../../config/config.js";
import { LIMITS } from "../../config/constants.js";
import type { ScoredCandidate } from "./scoring.js";

// ═══════════════════════════════════════════════════════════════════════════
// Prompt Sanitization
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// Prompt Building
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build candidate prompt blocks for LLM evaluation.
 * Creates formatted text blocks for each top candidate.
 *
 * @param scoredCandidates - Scored candidates to build blocks for
 * @param topN - Number of top candidates to include
 * @returns Array of formatted candidate blocks
 */
export function buildCandidateBlocks(scoredCandidates: ScoredCandidate[], topN: number): string[] {
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
 * @param preBalanceSol - Current SOL balance for display
 * @returns Complete prompt string for the screening agent
 */
export function buildScreeningPrompt(
  strategyBlock: string,
  prePositions: { total_positions: number },
  deployAmount: number,
  scoredCandidates: ScoredCandidate[],
  candidateBlocks: string[],
  preBalanceSol: number
): string {
  return `
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${preBalanceSol.toFixed(3)} | Deploy: ${deployAmount} SOL

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
