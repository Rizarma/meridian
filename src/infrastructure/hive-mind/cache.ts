/**
 * Hive Mind — consensus cache.
 *
 * TTLCache instance shared across consensus query modules.
 */

import { TTLCache } from "../../utils/cache.js";
import { CACHE_KEY, CONSENSUS_CACHE_TTL_MS } from "./config.js";

// ─── Shared Consensus Cache ───────────────────────────────────────

const _consensusCache = new TTLCache<string, unknown>(false);

export { _consensusCache, CACHE_KEY, CONSENSUS_CACHE_TTL_MS };

/**
 * Destroy the consensus cache (call during shutdown).
 */
export function destroyConsensusCache(): void {
  _consensusCache.destroy();
}
