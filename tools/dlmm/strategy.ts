// tools/dlmm/strategy.ts
// Strategy mapping and validation for DLMM operations

import { config } from "../../src/config/config.js";
import {
  getActiveStrategy,
  getStrategyByLpStrategy,
  isLegacyLpStrategy,
} from "../../src/domain/strategy-library.js";
import { getStrategyType, loadDlmmSdk } from "./sdk-loader.js";

/** Valid strategy names */
export type StrategyName = "spot" | "curve" | "bid_ask";

/** Strategy configuration from database */
export interface StrategyConfig {
  id: string;
  lp_strategy: string;
  bins_below?: number;
  bins_above?: number;
  [key: string]: unknown | undefined;
}

/** Strategy resolution result */
export interface ResolvedStrategy {
  strategyId: string;
  strategyConfig: unknown;
  strategyType: string;
  binsBelow: number;
  binsAbove: number;
}

/**
 * Validate and normalize strategy name
 * @param strategy - Strategy name to validate
 * @returns Valid strategy name or null if invalid
 */
export function validateStrategyName(strategy: string): StrategyName | null {
  const validStrategies: StrategyName[] = ["spot", "curve", "bid_ask"];
  return validStrategies.includes(strategy as StrategyName) ? (strategy as StrategyName) : null;
}

/**
 * Map strategy name to SDK StrategyType value
 * Must call loadDlmmSdk() before using this
 * @param strategyName - Strategy name (spot, curve, bid_ask)
 * @returns SDK StrategyType string
 * @throws Error if strategy invalid or SDK not loaded
 */
export function mapStrategyToSdkType(strategyName: string): string {
  const validName = validateStrategyName(strategyName);
  if (!validName) {
    throw new Error(`Invalid strategy: ${strategyName}. Use spot, curve, or bid_ask.`);
  }

  const StrategyType = getStrategyType();
  const strategyMap: Record<StrategyName, string> = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  return strategyMap[validName];
}

/**
 * Resolve strategy configuration from database
 * Handles legacy strategy names and falls back to config defaults
 * @param requestedStrategy - Strategy name from parameters
 * @returns Resolved strategy with config and bin ranges
 */
export async function resolveStrategy(requestedStrategy?: string): Promise<ResolvedStrategy> {
  // Ensure SDK is loaded (needed for strategy type mapping)
  await loadDlmmSdk();

  const activeStrategy = requestedStrategy || config.strategy.strategy;

  // Get strategy definition from database
  const activeStrategyDefinition = await getActiveStrategy();

  // Handle legacy strategy names
  const resolvedStrategy =
    isLegacyLpStrategy(activeStrategy) && activeStrategyDefinition?.lp_strategy !== activeStrategy
      ? await getStrategyByLpStrategy(activeStrategy)
      : activeStrategyDefinition;

  const strategyId = resolvedStrategy?.id ?? activeStrategy;
  const strategyConfig = resolvedStrategy ?? null;

  // Get bin ranges from config (strategy library doesn't store these)
  const binsBelow = config.strategy.binsBelow;
  const binsAbove = config.strategy.binsAbove;

  // Map to SDK type
  const strategyType = mapStrategyToSdkType(activeStrategy);

  return {
    strategyId,
    strategyConfig,
    strategyType,
    binsBelow,
    binsAbove,
  };
}

/**
 * Calculate bin range from active bin and strategy config
 * @param activeBinId - Current active bin ID
 * @param binsBelow - Number of bins below active
 * @param binsAbove - Number of bins above active
 * @returns Min and max bin IDs
 */
export function calculateBinRange(
  activeBinId: number,
  binsBelow: number,
  binsAbove: number
): { minBinId: number; maxBinId: number } {
  return {
    minBinId: activeBinId - binsBelow,
    maxBinId: activeBinId + binsAbove,
  };
}

/**
 * Check if bin range is considered "wide" (>69 bins)
 * Wide ranges require multi-transaction handling
 * @param binsBelow - Number of bins below
 * @param binsAbove - Number of bins above
 * @returns True if wide range
 */
export function isWideRange(binsBelow: number, binsAbove: number): boolean {
  return binsBelow + binsAbove > 69;
}
