/**
 * Persistence Service
 *
 * Cross-cutting concern for persisting position data.
 * Decoupled from middleware - can be injected wherever needed.
 */

import type { PositionPerformance } from "../types/lessons.js";
import type { TrackPositionParams } from "./state.js";

// Logger interface for dependency injection
export interface Logger {
  log(category: string, message: string): void;
}

// State tracker interface
export interface StateTracker {
  trackPosition(params: TrackPositionParams): void;
  recordClaim(position: string, feesUsd: number): void;
  recordClose(position: string, reason: string): void;
}

// Performance recorder interface
export interface PerformanceRecorder {
  recordPerformance(perf: PositionPerformance): Promise<void>;
}

/**
 * Persistence service interface
 */
export interface PersistenceService {
  trackPosition(deployResult: DeployResult): Promise<void>;
  recordClaim(position: string): Promise<void>;
  recordClose(position: string, reason: string): Promise<void>;
  recordPerformance(perf: PositionPerformance): Promise<void>;
}

/**
 * Deploy result shape for persistence
 */
export interface DeployResult {
  position: string;
  pool: string;
  pool_name?: string;
  strategy?: string;
  strategy_config?: unknown;
  bin_range?: { min: number; max: number; active?: number };
  bin_step?: number;
  volatility?: number;
  fee_tvl_ratio?: number;
  organic_score?: number;
  amount_sol?: number;
  amount_x?: number;
  amount_y?: number;
  active_bin?: number;
  initial_value_usd?: number;
  signal_snapshot?: unknown;
}

/**
 * Dependencies for creating persistence service
 */
export interface PersistenceServiceDeps {
  stateTracker: StateTracker;
  performanceRecorder: PerformanceRecorder;
  logger: Logger;
}

/**
 * Create persistence service instance
 */
export function createPersistenceService(deps: PersistenceServiceDeps): PersistenceService {
  const { stateTracker, performanceRecorder, logger } = deps;

  return {
    async trackPosition(deployResult: DeployResult): Promise<void> {
      const params: TrackPositionParams = {
        position: deployResult.position,
        pool: deployResult.pool,
        pool_name: deployResult.pool_name || "unknown",
        strategy: deployResult.strategy || "spot",
        strategy_config: deployResult.strategy_config as
          | import("../types/strategy.js").Strategy
          | undefined,
        bin_range: deployResult.bin_range || {},
        bin_step: deployResult.bin_step || 80,
        volatility: deployResult.volatility || 0,
        fee_tvl_ratio: deployResult.fee_tvl_ratio || 0,
        organic_score: deployResult.organic_score || 0,
        amount_sol: deployResult.amount_sol || deployResult.amount_y || 0,
        amount_x: deployResult.amount_x,
        active_bin: deployResult.active_bin || 0,
        initial_value_usd: deployResult.initial_value_usd || 0,
        signal_snapshot: deployResult.signal_snapshot as Record<string, unknown> | null | undefined,
      };

      stateTracker.trackPosition(params);
      logger.log("middleware", `Tracked position ${deployResult.position.slice(0, 8)}...`);
    },

    async recordClaim(position: string): Promise<void> {
      stateTracker.recordClaim(position, 0); // Fees tracked separately via API
      logger.log("middleware", `Recorded claim for ${position.slice(0, 8)}...`);
    },

    async recordClose(position: string, reason: string): Promise<void> {
      stateTracker.recordClose(position, reason);
      logger.log("middleware", `Recorded close for ${position.slice(0, 8)}...`);
    },

    async recordPerformance(perf: PositionPerformance): Promise<void> {
      await performanceRecorder.recordPerformance(perf);
      logger.log("middleware", `Recorded performance for ${perf.position.slice(0, 8)}...`);
    },
  };
}
