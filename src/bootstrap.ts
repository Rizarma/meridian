// src/bootstrap.ts
// Single source of truth for tool registration side-effects
// Import this module to ensure all tools are registered

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
