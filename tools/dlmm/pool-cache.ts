// tools/dlmm/pool-cache.ts
// Pool cache with LRU and automatic expiration

import { PublicKey } from "@solana/web3.js";
import { LRUCache } from "./lru-cache.js";
import { loadDlmmSdk } from "./sdk-loader.js";
import { getSharedConnection } from "../../src/infrastructure/connection.js";
import type { DLMMPool } from "./sdk-loader.js";

// Pool cache configuration
const POOL_CACHE_SIZE = 100;
const POOL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Cache instance
const poolCache = new LRUCache<string, DLMMPool>(POOL_CACHE_SIZE);
let _poolCacheInterval: NodeJS.Timeout | null = null;

/**
 * Start the pool cache expiration interval
 * Lazy initialization - only starts when needed
 */
function startPoolCacheInterval(): void {
  if (!_poolCacheInterval) {
    _poolCacheInterval = setInterval(() => poolCache.clear(), POOL_CACHE_TTL_MS);
  }
}

/**
 * Stop the pool cache expiration interval
 */
export function stopPoolCache(): void {
  if (_poolCacheInterval) {
    clearInterval(_poolCacheInterval);
    _poolCacheInterval = null;
  }
}

/**
 * Clear the pool cache immediately
 */
export function clearPoolCache(): void {
  poolCache.clear();
}

/**
 * Delete a specific pool from cache
 * @param poolAddress - Pool address to remove
 */
export function deletePoolFromCache(poolAddress: string): void {
  poolCache.delete(poolAddress);
}

/**
 * Get pool from cache or fetch from SDK
 * @param poolAddress - Pool address
 * @returns DLMMPool instance
 */
export async function getPool(poolAddress: string): Promise<DLMMPool> {
  const key = poolAddress.toString();
  
  const cached = poolCache.get(key);
  if (cached) {
    return cached;
  }

  startPoolCacheInterval();
  const { DLMM } = await loadDlmmSdk();
  
  // Create pool instance via SDK
  const pool = await (DLMM as { create: (conn: unknown, pubkey: PublicKey) => Promise<DLMMPool> }).create(
    getSharedConnection(),
    new PublicKey(poolAddress)
  );
  
  poolCache.set(key, pool);
  return pool;
}

/**
 * Get current pool cache size
 */
export function getPoolCacheSize(): number {
  return poolCache.size;
}

/**
 * Check if pool is in cache
 * @param poolAddress - Pool address
 */
export function isPoolCached(poolAddress: string): boolean {
  return poolCache.has(poolAddress);
}
