import { getMyPositions } from "../../../tools/dlmm.js";
import { getTopCandidates } from "../../../tools/screening.js";
import { getTokenInfo, getTokenNarrative } from "../../../tools/token.js";
import { getWalletBalances } from "../../../tools/wallet.js";
import { config } from "../../config/config.js";
import { SCREENING } from "../../config/constants.js";
import { recallForPool } from "../../domain/pool-memory.js";
import { checkSmartWalletsOnPool } from "../../domain/smart-wallets.js";
import { log } from "../../infrastructure/logger.js";
import {
  createLiveMessage,
  getLastScreeningMessageId,
  isEnabled as telegramEnabled,
  updateExistingLiveMessage,
} from "../../infrastructure/telegram.js";
import type {
  CondensedPool,
  EnrichedPosition,
  FilteredExample,
  LiveMessageHandler,
  ReconCandidate,
} from "../../types/index.js";
import { getErrorMessage } from "../../utils/errors.js";
import { isValidBalanceResponse, isValidPositionsResponse } from "../../utils/validation-args.js";

// ═══════════════════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════════════════

export interface PreFlightData {
  prePositions: { total_positions: number; positions?: EnrichedPosition[] };
  preBalance: { sol: number };
  liveMessage: LiveMessageHandler | null;
}

export interface CandidateFetchResult {
  candidates: ReconCandidate[];
  earlyFiltered: FilteredExample[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Pre-Flight Checks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run pre-flight checks before screening cycle.
 * Validates positions count and SOL balance.
 *
 * @param silent - Whether to suppress Telegram notifications
 * @returns Pre-flight data or error message
 */
export async function runPreFlightChecks(
  silent: boolean
): Promise<PreFlightData | { error: string }> {
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

// ═══════════════════════════════════════════════════════════════════════════
// Candidate Fetching & Enrichment
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch and enrich candidates with smart wallet, narrative, and token info.
 *
 * @param limit - Maximum number of candidates to fetch
 * @returns Enriched candidates and early filtered examples
 */
export async function fetchAndEnrichCandidates(limit: number): Promise<CandidateFetchResult> {
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
