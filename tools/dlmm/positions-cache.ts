// tools/dlmm/positions-cache.ts
// Positions cache with async mutex lock for thread safety

import { Mutex } from "async-mutex";
import type { PositionsResult, EnrichedPosition } from "../../src/types/dlmm.js";

// Cache configuration
const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes

// Cache state
let _positionsCache: PositionsResult | null = null;
let _positionsCacheAt = 0;
let _positionsInflight: Promise<PositionsResult> | null = null;

// Async mutex to prevent race conditions on cache state
const positionsCacheMutex = new Mutex();

/**
 * Execute function with exclusive lock on positions cache
 * Prevents concurrent modifications to cache state
 */
export async function withPositionsCacheLock<T>(fn: () => Promise<T>): Promise<T> {
  return positionsCacheMutex.runExclusive(fn);
}

/**
 * Get cached positions if valid
 * @param force - Bypass cache and force refresh
 * @returns Cached positions or null if expired/invalid
 */
export function getCachedPositions(force = false): PositionsResult | null {
  if (force) return null;
  if (!_positionsCache) return null;
  if (Date.now() - _positionsCacheAt > POSITIONS_CACHE_TTL) return null;
  return _positionsCache;
}

/**
 * Set positions cache
 * @param positions - Positions result to cache
 */
export async function setPositionsCache(positions: PositionsResult): Promise<void> {
  await withPositionsCacheLock(async () => {
    _positionsCache = positions;
    _positionsCacheAt = Date.now();
  });
}

/**
 * Invalidate positions cache
 * Sets cache timestamp to 0, forcing next fetch to refresh
 */
export async function invalidatePositionsCache(): Promise<void> {
  await withPositionsCacheLock(async () => {
    _positionsCacheAt = 0;
  });
}

/**
 * Get in-flight positions promise (if fetch is ongoing)
 * Used to deduplicate concurrent fetch requests
 */
export function getPositionsInflight(): Promise<PositionsResult> | null {
  return _positionsInflight;
}

/**
 * Set in-flight positions promise
 * @param promise - The ongoing fetch promise
 */
export function setPositionsInflight(promise: Promise<PositionsResult> | null): void {
  _positionsInflight = promise;
}

/**
 * Find a position in the cache by address
 * @param positionAddress - Position address to find
 * @returns Enriched position or undefined
 */
export function findPositionInCache(
  positionAddress: string
): EnrichedPosition | undefined {
  return _positionsCache?.positions.find((p) => p.position === positionAddress);
}

/**
 * Get pool address for a position from cache
 * @param positionAddress - Position address
 * @returns Pool address or undefined
 */
export function getPoolFromCache(positionAddress: string): string | undefined {
  return findPositionInCache(positionAddress)?.pool;
}

/**
 * Get cache age in milliseconds
 * @returns Time since last cache update
 */
export function getPositionsCacheAge(): number {
  if (!_positionsCacheAt) return Infinity;
  return Date.now() - _positionsCacheAt;
}

/**
 * Check if positions cache is valid (not expired)
 */
export function isPositionsCacheValid(): boolean {
  return getPositionsCacheAge() < POSITIONS_CACHE_TTL;
}
