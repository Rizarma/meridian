import { registerTool } from "./registry.js";

// Phase A+B: Import from extracted modules
import {
  stopPoolCache,
  clearPoolCache,
  deletePoolFromCache,
  invalidatePositionsCache,
  lookupPoolForPosition,
  simulateAndSend,
  simulateAndSendMany,
  deriveOpenPnlPct,
  fetchDlmmPnlForPool,
} from "./dlmm/index.js";

// Phase D: Read-only tools (extracted to dedicated modules)
import { getActiveBin } from "./dlmm/active-bin.js";
import { searchPools } from "./dlmm/search-pools.js";
import { getPositionPnl, getMyPositions, getWalletPositions } from "./dlmm/positions.js";

// Phase E: Lower-risk write tools (extracted to dedicated modules)
import { claimFees } from "./dlmm/claim-fees.js";
import { addLiquidity } from "./dlmm/add-liquidity.js";
import { withdrawLiquidity } from "./dlmm/withdraw-liquidity.js";

// Phase F: Deploy position (extracted to dedicated module)
import { deployPosition } from "./dlmm/deploy-position.js";

// Phase G: Close position (extracted to dedicated module)
import { closePosition } from "./dlmm/close-position.js";

// Re-export from modules for backward compatibility
export {
  stopPoolCache,
  clearPoolCache,
  deletePoolFromCache,
  invalidatePositionsCache,
  deriveOpenPnlPct,
  fetchDlmmPnlForPool,
  lookupPoolForPosition,
  simulateAndSend,
  simulateAndSendMany,
  // Phase D: Read-only tools
  getActiveBin,
  searchPools,
  getPositionPnl,
  getMyPositions,
  getWalletPositions,
  // Phase E: Lower-risk write tools
  claimFees,
  addLiquidity,
  withdrawLiquidity,
  // Phase F: Deploy position
  deployPosition,
  // Phase G: Close position
  closePosition,
} from "./dlmm/index.js";

// ─── Tool Registrations ────────────────────────────────────────
// closePosition is extracted to tools/dlmm/close-position.ts (Phase G)
// deployPosition is extracted to tools/dlmm/deploy-position.ts (Phase F)
// claimFees is extracted to tools/dlmm/claim-fees.ts (Phase E)

// Tool registrations
registerTool({
  name: "get_active_bin",
  handler: getActiveBin,
  roles: ["SCREENER", "MANAGER", "GENERAL"],
});

registerTool({
  name: "get_position_pnl",
  handler: getPositionPnl,
  roles: ["MANAGER", "GENERAL"],
});

registerTool({
  name: "get_my_positions",
  handler: getMyPositions,
  roles: ["SCREENER", "MANAGER", "GENERAL"],
});

registerTool({
  name: "get_wallet_positions",
  handler: getWalletPositions,
  roles: ["GENERAL"], // Research only — not for agent's own positions
});

registerTool({
  name: "search_pools",
  handler: searchPools,
  roles: ["SCREENER", "GENERAL"],
});

registerTool({
  name: "deploy_position",
  handler: deployPosition,
  roles: ["SCREENER", "GENERAL"],
  isWriteTool: true,
});

registerTool({
  name: "close_position",
  handler: closePosition,
  roles: ["MANAGER", "GENERAL"],
  isWriteTool: true,
});

registerTool({
  name: "claim_fees",
  handler: claimFees,
  roles: ["MANAGER", "GENERAL"],
  isWriteTool: true,
});

registerTool({
  name: "withdraw_liquidity",
  handler: withdrawLiquidity,
  roles: ["MANAGER", "GENERAL"],
  isWriteTool: true,
});

registerTool({
  name: "add_liquidity",
  handler: addLiquidity,
  roles: ["MANAGER", "GENERAL"],
  isWriteTool: true,
});
