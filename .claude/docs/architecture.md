# Architecture

Autonomous DLMM liquidity provider agent for Meteora pools on Solana. Runs two cron-driven agent cycles (screener, manager) over a ReAct loop, with a shared tool registry and middleware pipeline.

## Project Structure

```
src/
  agent/         # ReAct agent loop, prompts, intent parsing
  cycles/        # Screening and management cycles
  domain/        # Business logic (pools, signals, exit rules)
  infrastructure/# External services (DB, Telegram, RPC)
  config/        # Configuration and constants
  utils/         # Shared utilities
  types/         # TypeScript type definitions
tools/           # Tool handlers (auto-discovered)
test/            # Phase-numbered integration tests
```

## Key Files

- `src/index.ts` - Entry point
- `src/agent/agent.ts` - ReAct agent loop
- `src/cycles/screening.ts` - Pool screening logic
- `src/cycles/management.ts` - Position management
- `user-config.json` - User preferences (models, thresholds, strategy)
- `.env` - Secrets (wallet key, API keys)

## Data Storage

All data is stored in a SQLite database (`meridian.db`) by default. Override location with `MERIDIAN_ROOT` env var.

**Main tables:**
- `positions` - Open position tracking with bin ranges, OOR status, notes
- `position_snapshots` - Historical position state snapshots
- `position_events` - Deploy, close, claim events
- `pools` - Pool metadata and deploy history
- `lessons` - Learned rules from closed positions
- `performance` - Closed position performance records
- `signal_weights` - Darwinian signal weighting data
- `threshold_suggestions` - Pending threshold evolution suggestions (V2)
- `threshold_history` - Applied threshold changes history

Legacy JSON files (`state.json`, `lessons.json`, `pool-memory.json`, `signal-weights.json`) are kept as backups but no longer actively used.

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
    signal-weights.ts      Darwinian signal weighting (SQLite table)
    signal-tracker.ts      Records signal outcomes per position
    pool-memory.ts         Per-pool deploy history + snapshots (SQLite table)
    strategy-library.ts    Saved LP strategies (SQLite table)
    smart-wallets.ts       KOL / alpha wallet tracker (SQLite table)
    token-blacklist.ts     Permanent token blacklist (SQLite table)
    dev-blocklist.ts       Deployer wallet blocklist (SQLite table)
  infrastructure/
    state.ts               Position registry (SQLite table): bin ranges, OOR timestamps, notes
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
