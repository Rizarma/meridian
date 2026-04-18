import { config } from "../../config/config.js";
import { log } from "../../infrastructure/logger.js";
import type { FilteredExample, ReconCandidate } from "../../types/index.js";
import { isValidTokenInfoResponse } from "../../utils/validation-args.js";

// ═══════════════════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════════════════

export interface LateFilterResult {
  passing: ReconCandidate[];
  lateFiltered: FilteredExample[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Late-Stage Filters
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply late-stage filters to enriched candidates.
 * Filters out candidates based on launchpad and bot holder criteria.
 *
 * @param candidates - Enriched candidates to filter
 * @returns Passing candidates and filtered examples with reasons
 */
export function applyLateFilters(candidates: ReconCandidate[]): LateFilterResult {
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
