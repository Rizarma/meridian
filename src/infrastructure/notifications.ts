/**
 * Notification Service
 *
 * Cross-cutting concern for sending notifications via Telegram.
 * Decoupled from middleware - can be injected wherever needed.
 */

import type {
  TelegramNotifyClose,
  TelegramNotifyDeploy,
  TelegramNotifySwap,
} from "../types/telegram.js";
import { getErrorMessage } from "../utils/errors.js";

// Logger interface for dependency injection
export interface Logger {
  log(category: string, message: string): void;
}

// Telegram notification interface
export interface TelegramNotifier {
  notifySwap(params: TelegramNotifySwap): Promise<void>;
  notifyDeploy(params: TelegramNotifyDeploy): Promise<void>;
  notifyClose(params: TelegramNotifyClose): Promise<void>;
  hasActiveLiveMessage(): boolean;
}

/**
 * Notification service interface
 */
export interface NotificationService {
  notifySwap(
    inputSymbol: string,
    outputSymbol: string,
    amountIn?: number,
    amountOut?: number,
    tx?: string
  ): Promise<void>;
  notifyDeploy(
    pair: string,
    amountSol: number,
    position?: string,
    tx?: string,
    priceRange?: { min: number; max: number },
    binStep?: number,
    baseFee?: number
  ): Promise<void>;
  notifyClose(pair: string, pnlUsd: number, pnlPct: number): Promise<void>;
}

/**
 * Dependencies for creating notification service
 */
export interface NotificationServiceDeps {
  telegram: TelegramNotifier;
  logger: Logger;
}

/**
 * Create notification service instance
 */
export function createNotificationService(deps: NotificationServiceDeps): NotificationService {
  const { telegram, logger } = deps;

  return {
    async notifySwap(
      inputSymbol: string,
      outputSymbol: string,
      amountIn?: number,
      amountOut?: number,
      tx?: string
    ): Promise<void> {
      if (telegram.hasActiveLiveMessage()) return;
      try {
        await telegram.notifySwap({
          inputSymbol: inputSymbol.slice(0, 8),
          outputSymbol:
            outputSymbol === "So11111111111111111111111111111111111111112" || outputSymbol === "SOL"
              ? "SOL"
              : outputSymbol.slice(0, 8),
          amountIn,
          amountOut,
          tx,
        });
      } catch (e) {
        logger.log("notify_error", getErrorMessage(e));
      }
    },

    async notifyDeploy(
      pair: string,
      amountSol: number,
      position?: string,
      tx?: string,
      priceRange?: { min: number; max: number },
      binStep?: number,
      baseFee?: number
    ): Promise<void> {
      if (telegram.hasActiveLiveMessage()) return;
      try {
        await telegram.notifyDeploy({
          pair,
          amountSol,
          position,
          tx,
          priceRange,
          binStep,
          baseFee,
        });
      } catch (e) {
        logger.log("notify_error", getErrorMessage(e));
      }
    },

    async notifyClose(pair: string, pnlUsd: number, pnlPct: number): Promise<void> {
      try {
        await telegram.notifyClose({ pair, pnlUsd, pnlPct });
      } catch (e) {
        logger.log("notify_error", getErrorMessage(e));
      }
    },
  };
}
