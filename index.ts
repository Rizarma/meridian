import "dotenv/config";

// ═══════════════════════════════════════════
//  SIDE-EFFECT IMPORTS: Tool self-registration
//  discover.ts scans tools/ directory and auto-imports all tool modules
// ═══════════════════════════════════════════
import "./tools/discover.js";

// Import other modules that register tools (outside tools/ directory)
import "./dev-blocklist.js";
import "./lessons.js";
import "./pool-memory.js";
import "./smart-wallets.js";
import "./state.js";
import "./strategy-library.js";
import "./token-blacklist.js";

// ═══════════════════════════════════════════
//  MAIN ENTRY POINT
// ═══════════════════════════════════════════
import { start } from "./src/orchestrator.js";

start();
