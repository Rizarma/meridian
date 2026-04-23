// Dependency Injection Container
// Provides domain layer with infrastructure implementations

import type {
  DatabaseOperations,
  JsonOperations,
  Logger,
  NotificationService,
} from "./domain/interfaces/database.js";
import { createDatabase } from "./infrastructure/db/index.js";
import { log } from "./infrastructure/logger.js";

export interface Infrastructure {
  db: DatabaseOperations & JsonOperations;
  logger: Logger;
  notifications: NotificationService;
}

// Container instance (set at bootstrap)
let container: Infrastructure | null = null;

export async function initializeInfrastructure(): Promise<void> {
  const db = await createDatabase();

  container = {
    db,
    logger: {
      info: (msg: string) => log("INFO", msg),
      error: (msg: string) => log("ERROR", msg),
      warn: (msg: string) => log("WARN", msg),
      debug: (msg: string) => log("DEBUG", msg),
    },
    notifications: {
      send: async (msg: string, _level?: "info" | "warning" | "error") => {
        log("INFO", `[NOTIFY] ${msg}`);
      },
    },
  };
}

/**
 * Get the initialized infrastructure.
 * Throws if initializeInfrastructure() hasn't been called.
 */
export function getInfrastructure(): Infrastructure {
  if (!container) {
    throw new Error(
      "Infrastructure not initialized. Call initializeInfrastructure() first."
    );
  }
  return container;
}

/**
 * Set infrastructure manually (for testing or custom setups).
 * @deprecated Use initializeInfrastructure() instead
 */
export function setInfrastructure(infra?: Infrastructure): void {
  container = infra ?? null;
}

/**
 * Close database connection gracefully.
 */
export async function closeInfrastructure(): Promise<void> {
  if (container) {
    await container.db.close();
    container = null;
  }
}
