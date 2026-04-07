/**
 * Test the full agent loop in dry-run mode (no wallet needed for screening).
 * Run: DRY_RUN=true node dist/test/test-agent.js
 */

import "dotenv/config";
import { agentLoop } from "../src/agent/agent.js";
import type { AgentResult } from "../src/types/agent.js";

async function main(): Promise<void> {
  console.log("=== Testing Agent Loop (DRY RUN) ===\n");
  console.log("Goal: Discover top pools and recommend 3 LP opportunities\n");

  const result: AgentResult = await agentLoop(
    "Run get_top_candidates. Then deploy_position into the #1 candidate using 0.1 SOL. Report what was deployed.",
    5
  );

  console.log("\n=== Agent Response ===");
  console.log(result.content);
  console.log("\n=== Test complete ===");
}

main().catch(console.error);
