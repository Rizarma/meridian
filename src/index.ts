import "dotenv/config";

// ═══════════════════════════════════════════
//  SIDE-EFFECT IMPORTS: Tool self-registration
//  bootstrap.ts consolidates all tool registration imports
// ═══════════════════════════════════════════
import "./bootstrap.js";

// ═══════════════════════════════════════════
//  MAIN ENTRY POINT
// ═══════════════════════════════════════════
import { start } from "./orchestrator.js";

start();
