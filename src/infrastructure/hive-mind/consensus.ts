/**
 * Hive Mind — raw consensus query functions.
 *
 * Each function queries the hive server and caches the result
 * in the shared TTLCache. All functions fail-open (return null on error).
 *
 * Phase 4: All functions in this module are soft-deprecated.
 * Prefer pull-based endpoints (pullLessons, pullPresets) for new code.
 * These legacy consensus queries are preserved for backward compatibility.
 */

import type {
  HivePulse,
  LessonConsensus,
  PatternConsensus,
  PoolConsensus,
  ThresholdConsensus,
} from "../../types/hive-mind.js";
import { _consensusCache, CACHE_KEY, CONSENSUS_CACHE_TTL_MS } from "./cache.js";
import { fetchWithTimeout } from "./client.js";
import { readConfig, recordPathUsage, warnDeprecation } from "./config.js";

/**
 * Query pool consensus from the hive.
 * Results are TTL-cached to avoid repeated network calls.
 *
 * @deprecated Phase 4: Legacy consensus endpoint. Prefer pull-based data where available.
 *             This function is preserved for backward compatibility.
 */
export async function queryPoolConsensus(poolAddress: string): Promise<PoolConsensus | null> {
  try {
    warnDeprecation("queryPoolConsensus");
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const cacheKey = `${CACHE_KEY.POOL}${poolAddress}`;
    const cached = _consensusCache.get(cacheKey) as PoolConsensus | null | undefined;
    if (cached !== undefined) return cached;

    const res = await fetchWithTimeout(
      `${cfg.hiveMindUrl}/api/consensus/pool/${encodeURIComponent(poolAddress)}`,
      { headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` } }
    );

    if (!res.ok) {
      _consensusCache.set(cacheKey, null, CONSENSUS_CACHE_TTL_MS);
      return null;
    }
    const data = (await res.json()) as PoolConsensus;
    _consensusCache.set(cacheKey, data, CONSENSUS_CACHE_TTL_MS);
    recordPathUsage("legacy_consensus");
    return data;
  } catch {
    return null;
  }
}

/**
 * Query lesson consensus by tags.
 * Results are TTL-cached to avoid repeated network calls.
 *
 * @deprecated Phase 4: Legacy consensus endpoint. Prefer pullLessons() for new code.
 *             This function is preserved for backward compatibility.
 */
export async function queryLessonConsensus(tags?: string[]): Promise<LessonConsensus[] | null> {
  try {
    warnDeprecation("queryLessonConsensus");
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const tagKey = Array.isArray(tags) && tags.length > 0 ? tags.sort().join(",") : "_all";
    const cacheKey = `${CACHE_KEY.LESSON}${tagKey}`;
    const cached = _consensusCache.get(cacheKey) as LessonConsensus[] | null | undefined;
    if (cached !== undefined) return cached;

    const qs =
      Array.isArray(tags) && tags.length > 0 ? `?tags=${encodeURIComponent(tags.join(","))}` : "";
    const res = await fetchWithTimeout(`${cfg.hiveMindUrl}/api/consensus/lessons${qs}`, {
      headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` },
    });

    if (!res.ok) {
      _consensusCache.set(cacheKey, null, CONSENSUS_CACHE_TTL_MS);
      return null;
    }
    const data = (await res.json()) as LessonConsensus[];
    _consensusCache.set(cacheKey, data, CONSENSUS_CACHE_TTL_MS);
    recordPathUsage("legacy_consensus");
    return data;
  } catch {
    return null;
  }
}

/**
 * Query pattern consensus for a given volatility level.
 * Results are TTL-cached to avoid repeated network calls.
 *
 * @deprecated Phase 4: Legacy consensus endpoint. No pull-based replacement yet.
 *             This function is preserved for backward compatibility.
 */
export async function queryPatternConsensus(
  volatility?: number
): Promise<PatternConsensus[] | null> {
  try {
    warnDeprecation("queryPatternConsensus");
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const volKey = volatility != null ? String(volatility) : "_all";
    const cacheKey = `${CACHE_KEY.PATTERN}${volKey}`;
    const cached = _consensusCache.get(cacheKey) as PatternConsensus[] | null | undefined;
    if (cached !== undefined) return cached;

    const qs = volatility != null ? `?volatility=${encodeURIComponent(volatility)}` : "";
    const res = await fetchWithTimeout(`${cfg.hiveMindUrl}/api/consensus/patterns${qs}`, {
      headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` },
    });

    if (!res.ok) {
      _consensusCache.set(cacheKey, null, CONSENSUS_CACHE_TTL_MS);
      return null;
    }
    const data = (await res.json()) as PatternConsensus[];
    _consensusCache.set(cacheKey, data, CONSENSUS_CACHE_TTL_MS);
    recordPathUsage("legacy_consensus");
    return data;
  } catch {
    return null;
  }
}

/**
 * Query median threshold consensus across all agents.
 * Results are TTL-cached to avoid repeated network calls.
 *
 * @deprecated Phase 4: Legacy consensus endpoint. Prefer pullPresets() for new code.
 *             This function is preserved for backward compatibility.
 */
export async function queryThresholdConsensus(): Promise<ThresholdConsensus | null> {
  try {
    warnDeprecation("queryThresholdConsensus");
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const cacheKey = `${CACHE_KEY.THRESHOLD}_all`;
    const cached = _consensusCache.get(cacheKey) as ThresholdConsensus | null | undefined;
    if (cached !== undefined) return cached;

    const res = await fetchWithTimeout(`${cfg.hiveMindUrl}/api/consensus/thresholds`, {
      headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` },
    });

    if (!res.ok) {
      _consensusCache.set(cacheKey, null, CONSENSUS_CACHE_TTL_MS);
      return null;
    }
    const data = (await res.json()) as ThresholdConsensus;
    _consensusCache.set(cacheKey, data, CONSENSUS_CACHE_TTL_MS);
    recordPathUsage("legacy_consensus");
    return data;
  } catch {
    return null;
  }
}

/**
 * Get global hive pulse stats.
 *
 * @deprecated Phase 4: Legacy pulse endpoint. This function is preserved for backward compatibility.
 *             Use telemetry/getHiveMindStatus() for local path status instead.
 */
export async function getHivePulse(): Promise<HivePulse | null> {
  try {
    warnDeprecation("getHivePulse");
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const res = await fetchWithTimeout(`${cfg.hiveMindUrl}/api/pulse`, {
      headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` },
    });

    if (!res.ok) return null;
    recordPathUsage("legacy_pulse");
    return (await res.json()) as HivePulse;
  } catch {
    return null;
  }
}
