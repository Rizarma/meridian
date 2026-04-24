import "dotenv/config";

// ═══════════════════════════════════════════
//  SIDE-EFFECT IMPORTS: Tool self-registration
//  bootstrap.ts consolidates all tool registration imports
// ═══════════════════════════════════════════
import "./bootstrap.js";

// ═══════════════════════════════════════════
//  MAIN ENTRY POINT
// ═══════════════════════════════════════════
import { initializeInfrastructure } from "./di-container.js";
import { initializeApp } from "./orchestrator.js";

async function main(): Promise<void> {
  await initializeInfrastructure();
  await initializeApp();
}

void main().catch(console.error);
