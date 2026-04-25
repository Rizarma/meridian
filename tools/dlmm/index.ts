// tools/dlmm/index.ts
// DLMM module exports - Phase 2 God Module Refactoring

// Phase A: Foundation Helpers
export { LRUCache } from "./lru-cache.js";
export {
  loadDlmmSdk,
  getStrategyType,
  resetSdkCache,
  isSdkLoaded,
  type DLMMPool,
  type StrategyTypeMap,
  type DLMMModule,
} from "./sdk-loader.js";
export {
  toLamports,
  fromLamports,
  fetchTokenDecimals,
  fetchPoolTokenDecimals,
  safeParseNumber,
  calculateTotalValue,
} from "./token-amounts.js";
export {
  validateStrategyName,
  mapStrategyToSdkType,
  resolveStrategy,
  calculateBinRange,
  isWideRange,
  type StrategyName,
  type StrategyConfig,
  type ResolvedStrategy,
} from "./strategy.js";

// Phase B: Cache/API Infrastructure
export {
  getPool,
  stopPoolCache,
  clearPoolCache,
  deletePoolFromCache,
  getPoolCacheSize,
  isPoolCached,
} from "./pool-cache.js";
export {
  withPositionsCacheLock,
  getCachedPositions,
  setPositionsCache,
  invalidatePositionsCache,
  getPositionsInflight,
  setPositionsInflight,
  findPositionInCache,
  getPoolFromCache,
  getPositionsCacheAge,
  isPositionsCacheValid,
} from "./positions-cache.js";
export {
  deriveOpenPnlPct,
  fetchDlmmPnlForPool,
  getPositionPnlFromApi,
  fetchClosedPnlForPool,
} from "./pnl-api.js";
export {
  lookupPoolForPosition,
  getAllPositionsForWallet,
  positionExists,
} from "./position-sdk.js";

// Phase C: Transaction Safety Primitives
export {
  simulateAndSend,
  simulateAndSendMany,
  simulateTransaction,
  getTransactionAuditLog,
  type TransactionResult,
  type SimulationResult,
} from "./transactions.js";
