# Agents & Tools

## Agent roles

Three agent roles filter which tools the LLM can call. Role-based access is enforced in **two places**:

1. **Registry `roles` field** — runtime enforcement in `tools/executor.ts` (rejects the call)
2. **`src/agent/tool-sets.ts` sets** — prompt-time filtering (controls what the LLM actually *sees* in its tool list)

Both must agree. Adding a tool to only one place will either hide it from the LLM or cause runtime rejection.

| Role | Purpose | Key tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | `deploy_position`, `get_active_bin`, `get_top_candidates`, `check_smart_wallets_on_pool`, `get_token_holders`, `get_token_narrative`, `get_token_info`, `search_pools`, `get_pool_memory`, `get_my_positions`, `get_wallet_balance` |
| `MANAGER` | Manage open positions | `close_position`, `claim_fees`, `swap_token`, `get_position_pnl`, `get_my_positions`, `get_wallet_balance` |
| `GENERAL` | Chat / manual commands | All tools, plus admin tools (lesson management, strategy library, deployer blocklist, config mutation) — many of these are intent-gated via `GENERAL_INTENT_ONLY_TOOLS` |

Source of truth for the sets: `src/agent/tool-sets.ts`.

## Tool system (post-refactor)

The executor is a **thin dispatcher**. Tools self-register at module load time via `tools/registry.ts`, and all cross-cutting concerns (safety checks, logging, telegram notifications, state persistence) live in `tools/middleware.ts`. There is no central `toolMap` anymore.

**Flow when the LLM calls a tool:**
1. `executor.executeTool(name, args, role)` looks up the tool in the registry
2. Validates `role` is in the tool's `roles` array (runtime access control)
3. Runs the handler through the middleware chain: `safetyCheck → logging → notification → persistence → handler`
4. Returns `ToolExecutionResult`

**Auto-discovery:** `tools/discover.ts` scans the `tools/` directory at startup and imports every `.js` file (except the infrastructure files: `registry`, `middleware`, `executor`, `definitions`, `discover`). Importing a tool file triggers its side-effect `registerTool(...)` calls.

## Adding a new tool

1. **Write the handler** in a new or existing `tools/{area}.ts` file:
   ```ts
   import { registerTool } from "./registry.js";

   async function myNewTool(args: MyNewToolArgs): Promise<MyNewToolResult> {
     // ...
   }

   registerTool({
     name: "my_new_tool",
     handler: myNewTool,
     roles: ["SCREENER", "GENERAL"],  // who can call this
     isWriteTool: true,                // optional: triggers safety pre-checks in middleware
   });
   ```
2. **Add the OpenAI schema** to the appropriate file under `tools/definitions/` (`screening.ts`, `management.ts`, `data.ts`, or `admin.ts`). It'll be picked up automatically by `tools/definitions/index.ts`.
3. **Add the tool name to the matching set** in `src/agent/tool-sets.ts`:
   - `MANAGER_TOOLS` or `SCREENER_TOOLS` for role-scoped access
   - `GENERAL_INTENT_ONLY_TOOLS` if it's a mutation requiring intent matching (e.g. config changes, blocklist edits)
4. **Add the name to the `ToolName` union type** in `src/types/executor.d.ts` so TypeScript recognizes it.
5. If the tool is in a brand-new file in `tools/`, auto-discovery will pick it up — no other wiring needed.

## Model configuration

**Precedence:** `LLM_MODEL` (env) > per-role models (user-config) > defaults

- **Global override:** `LLM_MODEL` in `.env` — overrides all roles (screening, management, general)
- **Per-role tuning:** `managementModel`, `screeningModel`, `generalModel` in `user-config.json`
- **Endpoint:** `LLM_BASE_URL` in `.env` for local/custom providers (e.g., LM Studio)
- **Fallback on 502 / 503 / 529:** `stepfun/step-3.5-flash:free` (second attempt), then retry with the primary
- **LM Studio / local:** set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- **`maxOutputTokens` minimum:** 2048 — free models often have lower limits, causing empty responses
