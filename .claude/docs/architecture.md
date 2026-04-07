# Architecture

Autonomous DLMM liquidity provider agent for Meteora pools on Solana. Runs two cron-driven agent cycles (screener, manager) over a ReAct loop, with a shared tool registry and middleware pipeline.

## Source layout

```
src/
  index.ts                 Process entry — wires bootstrap + orchestrator + REPL
  bootstrap.ts             Loads config, env, state, telegram, logger
  orchestrator.ts          Cron scheduler for screening / management / health cycles
  repl.ts                  Interactive REPL with live countdown
  agent/
    agent.ts               ReAct loop (OpenRouter / OpenAI-compatible): LLM → tool call → repeat
    prompt.ts              Builds system prompt per role (SCREENER / MANAGER / GENERAL)
    tool-sets.ts           MANAGER_TOOLS / SCREENER_TOOLS / GENERAL_INTENT_ONLY_TOOLS sets
    intent.ts              Intent matching for GENERAL-role tool access
  cycles/
    screening.ts           Screening cycle: candidates → research → deploy
    management.ts          Management cycle: PnL, OOR, claim, close
  domain/
    lessons.ts             Records closed-position performance, derives lessons
    threshold-evolution.ts Auto-tunes screening thresholds from performance
    exit-rules.ts          Stop-loss / trailing TP / OOR exit logic
    signal-weights.ts      Darwinian signal weighting (signal-weights.json)
    signal-tracker.ts      Records signal outcomes per position
    pool-memory.ts         Per-pool deploy history + snapshots (pool-memory.json)
    strategy-library.ts    Saved LP strategies (strategy-library.json)
    smart-wallets.ts       KOL / alpha wallet tracker (smart-wallets.json)
    token-blacklist.ts     Permanent token blacklist (token-blacklist.json)
    dev-blocklist.ts       Deployer wallet blocklist (deployer-blacklist.json)
  infrastructure/
    state.ts               Position registry (state.json): bin ranges, OOR timestamps, notes
    telegram.ts            Bot polling + notifications
    briefing.ts            Daily HTML briefing
    logger.ts              Daily-rotating logs + action audit trail
    hive-mind.ts           Optional collective-intelligence server sync
  config/
    config.ts              Runtime config from user-config.json + .env
    constants.ts           Shared constants
    paths.ts               File path resolution
  cli/
    cli.ts                 Direct CLI — every tool as a JSON subcommand
    setup.ts               Interactive setup wizard
  utils/
    cache.ts               TTL cache with periodic cleanup
  types/                   TypeScript type definitions

tools/                     (sibling of src/, auto-discovered by executor)
  registry.ts              Tool registration + lookup
  executor.ts              Thin dispatcher (middleware chain)
  middleware.ts            Safety checks, logging, notifications, persistence
  discover.ts              Auto-imports all tools/*.js files at load time
  definitions/             OpenAI-format schemas grouped by role
    index.ts               Aggregates all definition groups
    screening.ts           Screener tool schemas
    management.ts          Manager tool schemas
    data.ts                Read-only data tool schemas
    admin.ts               Admin / mutation tool schemas
  dlmm.ts                  Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.ts             Pool discovery from Meteora API
  wallet.ts                SOL / token balances + Jupiter swap
  token.ts                 Token info / holders / narrative (Jupiter API)
  study.ts                 Top LPer study via LPAgent API
  okx.ts                   OKX integration for advanced pool risk data
  admin.ts                 Admin tools (config, lessons, blocklists)

build.js                   Build script (esbuild)
```

## Position lifecycle

1. **Deploy** — `deploy_position` → safety checks in middleware → `trackPosition()` in `src/infrastructure/state.ts` → Telegram notify
2. **Monitor** — management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close** — `close_position` → `recordPerformance()` in `src/domain/lessons.ts` → auto-swap base token to SOL → Telegram notify
4. **Learn** — `evolveThresholds()` runs on performance data → updates screening thresholds → persists to `user-config.json`

## Race condition: double deploy

`_screeningLastTriggered` in the orchestrator prevents concurrent screener invocations. The management cycle sets this before triggering the screener. Additionally, `deploy_position` safety checks use `force: true` on `getMyPositions()` to bypass cache and get a fresh position count.
