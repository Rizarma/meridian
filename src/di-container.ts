// Dependency Injection Container
// Provides domain layer with infrastructure implementations

import type {
  DatabaseOperations,
  JsonOperations,
  Logger,
  NotificationService,
} from "./domain/interfaces/database.js";
import * as dbModule from "./infrastructure/db.js";
import { log } from "./infrastructure/logger.js";

export interface Infrastructure {
  db: DatabaseOperations & JsonOperations;
  logger: Logger;
  notifications: NotificationService;
}

// Default infrastructure implementation
function createDefaultInfrastructure(): Infrastructure {
  return {
    db: {
      query: dbModule.query,
      get: dbModule.get,
      run: dbModule.run,
      transaction: dbModule.transaction,
      stringifyJson: dbModule.stringifyJson,
      parseJson: dbModule.parseJson,
    },
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

// Container instance (set at bootstrap)
let container: Infrastructure | null = null;

export function setInfrastructure(infra?: Infrastructure): void {
  container = infra ?? createDefaultInfrastructure();
}

export function getInfrastructure(): Infrastructure {
  if (!container) {
    // Auto-initialize with defaults for backward compatibility
    setInfrastructure();
  }
  return container!;
}
