# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.ts            Main entry: REPL + cron orchestration + Telegram bot polling
agent.ts            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.ts           Runtime config from user-config.json + .env; exposes config object
prompt.ts           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.ts            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.ts          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.ts      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.ts Saved LP strategies (strategy-library.json)
signal-weights.ts   Darwinian signal weighting system (evolves which signals predict profitability)
dev-blocklist.ts    Deployer wallet blocklist (separate from token blacklist)
briefing.ts         Daily Telegram briefing (HTML)
telegram.ts         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hive-mind.ts        Optional collective intelligence server sync
smart-wallets.ts    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.ts  Permanent token blacklist (token-blacklist.json)
logger.ts           Daily-rotating log files + action audit trail
cli.ts              CLI interface for non-interactive commands
setup.ts            First-time setup script

build.js            Build script (esbuild)

tools/
  definitions.ts    Tool schemas in OpenAI format (what LLM sees)
  executor.ts       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.ts           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.ts      Pool discovery from Meteora API
  wallet.ts         SOL/token balances (Helius) + Jupiter swap
  token.ts          Token info/holders/narrative (Jupiter API)
  study.ts          Top LPer study via LPAgent API
  okx.ts            OKX integration for advanced pool risk data

types/              TypeScript type definitions
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_active_bin, get_top_candidates, check_smart_wallets_on_pool, get_token_holders, get_token_narrative, get_token_info, search_pools, get_pool_memory, get_my_positions, get_wallet_balance |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, get_my_positions, get_wallet_balance |
| `GENERAL` | Chat / manual commands | All tools + lesson management, strategy library, deployer blocklist |

Sets defined in `agent.ts:30-51`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.ts`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.ts`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.ts`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.ts for safety checks

---

## Config System

`config.ts` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.ts) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlePct | screening | 30 |
| maxTop10Pct | screening | 60 |
| maxBotHoldersPct | screening | 25 |
| minFeePerTvl24h | screening | 0.001 |
| minTokenAgeHours / maxTokenAgeHours | screening | 0.5 / 72 |
| athFilterPct | screening | -20 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| trailingTakeProfit | management | false |
| trailingTriggerPct | management | 50 |
| trailingDropPct | management | 20 |
| pnlSanityMaxDiffPct | management | 30 |
| solMode | management | false |
| oorCooldownTriggerCount | management | 2 |
| oorCooldownHours | management | 24 |
| minVolumeToRebalance | management | 1000 |
| minAgeBeforeYieldCheck | management | 60 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| darwin.enabled | darwin | false |
| darwin.windowDays | darwin | 7 |
| darwin.minSamples | darwin | 3 |
| darwin.boostFactor | darwin | 1.2 |
| darwin.decayFactor | darwin | 0.9 |
| darwin.weightFloor | darwin | 0.5 |
| darwin.weightCeiling | darwin | 2.0 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.ts → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.ts → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.ts)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- If `amount_x > 0`: strip `amount_y` and `amount_sol` (tokenX-only deploy — no SOL needed)
- SOL balance must cover `amount_y + gasReserve` (skipped for tokenX-only)
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below Calculation (SCREENER)

Linear formula based on pool volatility (set in screener prompt, `index.js`):

```
bins_below = round(35 + (volatility / 5) * 34), clamped to [35, 69]
```

- Low volatility (0) → 35 bins
- High volatility (5+) → 69 bins
- Any value in between is valid (continuous, not tiered)

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.ts)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.ts)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.ts` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.ts after `close_position`

---

## Hive Mind (hive-mind.ts)

Optional feature. Enabled by setting `HIVE_MIND_URL` and `HIVE_MIND_API_KEY` in `.env`.
Syncs lessons/deploys to a shared server, queries consensus patterns.
Not required for normal operation.

---

## OKX Integration (tools/okx.ts)

Optional screening data source providing advanced risk metrics:
- `risk_level` — Overall risk assessment (1-5 scale)
- `bundle_pct` — Percentage of supply bundled at launch
- `sniper_pct` — Sniper bot activity percentage
- `suspicious_pct` — Suspicious transaction percentage
- `new_wallet_pct` — Percentage of new wallets among holders
- `is_rugpull` / `is_wash` — Boolean flags for known patterns

Enabled automatically if OKX API credentials are available. Falls back to Jupiter-only screening if unavailable.

---

## Signal Weights (signal-weights.ts)

Darwinian system that evolves which screening signals predict profitability:
- Tracks performance of signals like `high_volume`, `strong_tvl`, `good_distribution`, etc.
- Adjusts weights based on win rate (winners boost signal weight, losers decay it)
- Config via `darwin.*` keys in user-config.json
- Stored in `signal-weights.json`
- Used by `getTopCandidates()` to score and rank pools

---

## Trailing Take Profit

Optional feature that protects upside while allowing runners:
- Activates when PnL reaches `trailingTriggerPct` (default 50%)
- Tracks peak PnL after activation
- Closes position if PnL drops `trailingDropPct` (default 20%) from peak
- Enabled via `trailingTakeProfit: true` in config
- Uses lightweight 30-second PnL polling between management cycles

---

## SOL Mode

Optional display mode that reports all values in SOL instead of USD:
- Positions, PnL, balances shown in SOL terms
- Useful for SOL-denominated performance tracking
- Enabled via `solMode: true` in config
- Does not affect actual trading logic (still uses USD for thresholds)

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## Known Issues / Tech Debt

- `get_wallet_positions` tool (dlmm.ts) is in definitions.ts but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role. This is intentional: the tool is for researching external wallets (copy-trading), while the agent's own positions are accessed via `get_my_positions`.
