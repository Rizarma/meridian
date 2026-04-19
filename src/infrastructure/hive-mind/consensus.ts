/**
 * Hive Mind — raw consensus query functions.
 *
 * Each function queries the hive server and caches the result
 * in the shared TTLCache. All functions fail-open (return null on error).
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
import { readConfig } from "./config.js";

/**
 * Query pool consensus from the hive.
 * Results are TTL-cached to avoid repeated network calls.
 */
export async function queryPoolConsensus(poolAddress: string): Promise<PoolConsensus | null> {
  try {
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
    return data;
  } catch {
    return null;
  }
}

/**
 * Query lesson consensus by tags.
 * Results are TTL-cached to avoid repeated network calls.
 */
export async function queryLessonConsensus(tags?: string[]): Promise<LessonConsensus[] | null> {
  try {
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
    return data;
  } catch {
    return null;
  }
}

/**
 * Query pattern consensus for a given volatility level.
 * Results are TTL-cached to avoid repeated network calls.
 */
export async function queryPatternConsensus(
  volatility?: number
): Promise<PatternConsensus[] | null> {
  try {
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
    return data;
  } catch {
    return null;
  }
}

/**
 * Query median threshold consensus across all agents.
 * Results are TTL-cached to avoid repeated network calls.
 */
export async function queryThresholdConsensus(): Promise<ThresholdConsensus | null> {
  try {
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
    return data;
  } catch {
    return null;
  }
}

/**
 * Get global hive pulse stats.
 */
export async function getHivePulse(): Promise<HivePulse | null> {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;

    const res = await fetchWithTimeout(`${cfg.hiveMindUrl}/api/pulse`, {
      headers: { Authorization: `Bearer ${cfg.hiveMindApiKey}` },
    });

    if (!res.ok) return null;
    return (await res.json()) as HivePulse;
  } catch {
    return null;
  }
}
