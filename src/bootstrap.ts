// src/bootstrap.ts
// Single source of truth for tool registration side-effects and dependency injection
// Import this module to ensure all tools are registered and middleware is configured

// Auto-discover tools in tools/ directory
import "../tools/discover.js";

// Import domain modules that register tools (outside tools/ directory)
import "./domain/dev-blocklist.js";
import "./domain/lessons.js";
import "./domain/pool-memory.js";
import "./domain/smart-wallets.js";
import "./domain/strategy-library.js";
import "./domain/token-blacklist.js";

// Import infrastructure modules that register tools
import "./infrastructure/state.js";

// ═══════════════════════════════════════════════════════════════════════════
// Dependency Injection Bootstrap
// ═══════════════════════════════════════════════════════════════════════════

import { getMyPositions } from "../tools/dlmm.js";
import { createMiddlewareChain, type ValidationHelpers } from "../tools/middleware.js";
import {
  type MiddlewareContext,
  setMiddlewareChain,
  setMiddlewareContext,
} from "../tools/registry.js";
import { getWalletBalances, swapToken } from "../tools/wallet.js";
import { config } from "./config/config.js";
import { recordPerformance } from "./domain/lessons.js";
import { addPoolNote } from "./domain/pool-memory.js";
import { getActiveStrategy } from "./domain/strategy-library.js";
import { type AutoSwapService, createAutoSwapService } from "./infrastructure/auto-swap.js";
import { log, logAction } from "./infrastructure/logger.js";
import {
  createNotificationService,
  type NotificationService,
} from "./infrastructure/notifications.js";
import { createPersistenceService, type PersistenceService } from "./infrastructure/persistence.js";
import {
  createSafetyCheckService,
  type SafetyCheckService,
} from "./infrastructure/safety-check.js";
import { recordClaim, recordClose, trackPosition } from "./infrastructure/state.js";
import {
  hasActiveLiveMessage,
  notifyClose,
  notifyDeploy,
  notifySwap,
} from "./infrastructure/telegram.js";
import { isWalletBalances } from "./utils/validation.js";
import {
  validateAddLiquidityParams,
  validateClosePositionArgs,
  validateDeployPositionArgs,
  validateSwapTokenArgs,
  validateWithdrawLiquidityParams,
} from "./utils/validation-args.js";

/**
 * Logger adapter for dependency injection
 */
const logger = {
  log: (category: string, message: string) =>
    log(category as import("./types/logger.js").LogCategory, message),
  logAction: logAction,
};

/**
 * Validation helpers adapter for dependency injection
 */
const validation: ValidationHelpers = {
  validateSwapTokenArgs,
  validateDeployPositionArgs,
  validateClosePositionArgs,
};

/**
 * Telegram notifier adapter for dependency injection
 */
const telegramNotifier = {
  notifySwap,
  notifyDeploy,
  notifyClose,
  hasActiveLiveMessage,
};

/**
 * State tracker adapter for dependency injection
 */
const stateTracker = {
  trackPosition,
  recordClaim,
  recordClose,
};

/**
 * Performance recorder adapter for dependency injection
 */
const performanceRecorder = {
  recordPerformance,
};

/**
 * Pool memory adapter for dependency injection
 */
const poolMemory = {
  addPoolNote: async (params: { pool_address: string; note: string }) => addPoolNote(params),
};

/**
 * Wallet service adapter for dependency injection
 */
const walletService = {
  getWalletBalances,
  swapToken,
};

/**
 * Position provider adapter for dependency injection
 */
const positionProvider = {
  getMyPositions,
};

/**
 * Wallet provider adapter for dependency injection
 */
const walletProvider = {
  getWalletBalances,
};

/**
 * Strategy provider adapter for dependency injection
 */
const strategyProvider = {
  getActiveStrategy: async () => getActiveStrategy(),
};

/**
 * Validation helpers for safety check service
 */
const safetyValidation = {
  validateDeployPositionArgs,
  validateAddLiquidityParams,
  validateWithdrawLiquidityParams,
  isWalletBalances,
};

/**
 * Bootstrap the application with dependency injection.
 * Creates all services and wires them together.
 */
export function bootstrap(): void {
  // Create services
  const notificationService: NotificationService = createNotificationService({
    telegram: telegramNotifier,
    logger,
  });

  const persistenceService: PersistenceService = createPersistenceService({
    stateTracker,
    performanceRecorder,
    logger,
  });

  const autoSwapService: AutoSwapService = createAutoSwapService({
    walletService,
    poolMemory,
    logger,
    autoSwapAfterClaim: config.management.autoSwapAfterClaim,
  });

  const safetyCheckService: SafetyCheckService = createSafetyCheckService({
    config,
    positionProvider,
    walletProvider,
    strategyProvider,
    validation: safetyValidation,
    logger,
  });

  // Create middleware context
  const middlewareContext: MiddlewareContext = {
    config,
    logger,
    notificationService,
    persistenceService,
    autoSwapService,
    safetyCheckService,
    validation,
  };

  // Create middleware chain
  const middlewareChain = createMiddlewareChain(middlewareContext);

  // Register with registry
  setMiddlewareContext(middlewareContext);
  setMiddlewareChain(middlewareChain);

  log("startup", "Dependency injection bootstrap complete");
}

// Auto-bootstrap on module load
bootstrap();
