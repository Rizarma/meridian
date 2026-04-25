// Phase D: Read-only tools (extracted to dedicated modules)
import { getActiveBin } from "./dlmm/active-bin.js";
import { addLiquidity } from "./dlmm/add-liquidity.js";
// Phase E: Lower-risk write tools (extracted to dedicated modules)
import { claimFees } from "./dlmm/claim-fees.js";
// Phase G: Close position (extracted to dedicated module)
import { closePosition } from "./dlmm/close-position.js";
// Phase F: Deploy position (extracted to dedicated module)
import { deployPosition } from "./dlmm/deploy-position.js";
import { getMyPositions, getPositionPnl, getWalletPositions } from "./dlmm/positions.js";
import { searchPools } from "./dlmm/search-pools.js";
import { withdrawLiquidity } from "./dlmm/withdraw-liquidity.js";
import { registerTool } from "./registry.js";

// Re-export from modules for backward compatibility
export {
  addLiquidity,
  // Phase E: Lower-risk write tools
  claimFees,
  clearPoolCache,
  // Phase G: Close position
  closePosition,
  deletePoolFromCache,
  // Phase F: Deploy position
  deployPosition,
  deriveOpenPnlPct,
  fetchDlmmPnlForPool,
  // Phase D: Read-only tools
  getActiveBin,
  getMyPositions,
  getPositionPnl,
  getWalletPositions,
  invalidatePositionsCache,
  lookupPoolForPosition,
  searchPools,
  simulateAndSend,
  simulateAndSendMany,
  stopPoolCache,
  withdrawLiquidity,
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
