# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

Meridian runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. It learns from every position it closes.

---

## Features

### Autonomous trading
- **Pool screening** — scans Meteora DLMM pools against configurable thresholds (fee/TVL ratio, organic score, holder count, mcap, bin step, token age) and surfaces the best candidates
- **Position management** — monitors PnL, claims fees, and closes positions autonomously; decides STAY / CLOSE / REDEPLOY from live data every cycle
- **Trailing take profit** — arms a trailing stop when PnL crosses a trigger, then closes the position if it drops from its peak
- **Out-of-range handling** — grace periods, bin distance thresholds, and per-pool cooldowns after repeated OOR events
- **Stop loss & emergency exits** — hard exits on PnL drawdown or sudden token price collapse
- **Auto-swap on close** — base tokens are swapped back to SOL via Jupiter after closing

### Intelligence & learning
- **ReAct agent loop** — LLM reasons over live data, calls tools, iterates. Powered by OpenRouter (any compatible model works)
- **Lessons engine** — records performance of every closed position, derives structured lessons, and injects them into future agent cycles
- **Threshold evolution** — analyzes winners vs losers and auto-tunes screening thresholds in `user-config.json`
- **Darwinian signal weighting** — tracks which screening signals actually predict winners and reweights them over time
- **Top-LPer study** — analyzes on-chain behavior of the best performers in any pool (hold duration, entry/exit timing, win rate)
- **Pool memory** — per-pool deploy history, snapshots, and outcomes

### Risk & safety
- **Multi-source risk screening** — Jupiter token audit, bundle/sniper/suspicious-tx detection via OKX OnchainOS, bot-holder detection
- **Token blacklist + deployer blocklist** — permanently ban specific mints or ban every token from a bad deployer wallet
- **Launchpad filtering** — skip pools launched from blocked platforms
- **Safety guards on deploy** — duplicate pool/base-token detection, position cap enforcement, SOL reserve for gas, bin-step bounds
- **Dry-run mode** — exercise the full pipeline with zero on-chain transactions

### Interfaces
- **Interactive REPL** — live cycle countdown, slash commands for status/candidates/learn/evolve, free-form chat
- **Telegram bot** — full agent chat, cycle reports, deploy/close/OOR notifications, `/positions` `/close` `/set` commands
- **Claude Code integration** — `/screen`, `/manage`, `/candidates`, `/study-pool`, `/pool-compare` and more directly in your terminal, plus `screener` and `manager` sub-agents
- **Direct CLI** — the `meridian` binary exposes every tool as a subcommand with JSON output, ideal for scripting and debugging
- **Daily briefing** — optional HTML summary delivered via Telegram

### Operations
- **Auto-compounding position sizing** — deploy size scales with wallet balance (`positionSizePct` of deployable)
- **SOL mode** — display all values in SOL instead of USD
- **Daily-rotating logs** — with a separate action audit trail
- **Local LLMs** — point `LLM_BASE_URL` at LM Studio or any OpenAI-compatible endpoint
- **Hive Mind (optional)** — share lessons and pool outcomes with other Meridian agents, receive consensus signals

---

## How it works

Meridian runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Screening Agent** | Every 30 min | Pool screening — finds and deploys into the best candidate |
| **Management Agent** | Every 10 min | Position management — evaluates each open position and acts |

**Data sources:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM PnL API — position yield, fee accrual, PnL
- OKX OnchainOS — smart money signals, token risk scoring
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts
- Jupiter API — token audit, mcap, launchpad, price stats

Agents are powered via **OpenRouter** and can be swapped for any compatible model.

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key
- Solana wallet (base58 private key)
- Solana RPC endpoint ([Helius](https://helius.xyz) recommended)
- Telegram bot token (optional)
- [Claude Code](https://claude.ai/code) CLI (optional, for terminal slash commands)

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/Rizarma/meridian
cd meridian
pnpm install
```

### 2. Run the setup wizard

```bash
pnpm run setup
```

The wizard walks you through creating `.env` (API keys, wallet, RPC, Telegram) and `user-config.json` (risk preset, deploy size, thresholds, models). Takes about 2 minutes.

**Or set up manually:**

Create `.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
HELIUS_API_KEY=your_helius_key          # for wallet balance lookups
TELEGRAM_BOT_TOKEN=123456:ABC...        # optional — for notifications + chat
TELEGRAM_CHAT_ID=                       # auto-filled on first message
DRY_RUN=true                            # set false for live trading
```

> Never put your private key or API keys in `user-config.json` — use `.env` only. Both files are gitignored.

Copy config and edit as needed:

```bash
cp user-config.example.json user-config.json
```

**Configuration precedence:** `.env` > `user-config.json` > hardcoded defaults. Use `.env` for secrets and environment-specific overrides (CI/CD, Docker); use `user-config.json` for day-to-day tuning (models, thresholds, strategy). Keys that appear in both files are resolved in that order.

See [Config reference](#config-reference) below.

### 3. Run

```bash
pnpm run dev    # dry run — no on-chain transactions
pnpm start      # live mode
```

On startup Meridian fetches your wallet balance, open positions, and top pool candidates, then begins autonomous cycles immediately.

---

## Running modes

### Autonomous agent

```bash
pnpm start
```

Starts the full autonomous agent with cron-based screening + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[manage: 8m 12s | screen: 24m 3s]
>
```

REPL commands:

| Command | Description |
|---|---|
| `/status` | Wallet balance and open positions |
| `/candidates` | Re-screen and display top pool candidates |
| `/learn` | Study top LPers across all current candidate pools |
| `/learn <pool_address>` | Study top LPers for a specific pool |
| `/thresholds` | Current screening thresholds and performance stats |
| `/evolve` | Trigger threshold evolution from performance data (needs 5+ closed positions) |
| `/stop` | Graceful shutdown |
| `<anything>` | Free-form chat — ask the agent anything, request actions, analyze pools |

---

### Claude Code terminal (recommended)

Install [Claude Code](https://claude.ai/code) and use it from inside the meridian directory. Claude Code has built-in agents and slash commands that use the `meridian` CLI under the hood.

```bash
cd meridian
claude
```

#### Slash commands

| Command | What it does |
|---|---|
| `/screen` | Full AI screening cycle — checks Discord queue, reads config, fetches candidates, runs deep research, and deploys if a winner is found |
| `/manage` | Full AI management cycle — checks all positions, evaluates PnL, claims fees, closes OOR/losing positions |
| `/balance` | Check wallet SOL and token balances |
| `/positions` | List all open DLMM positions with range status |
| `/candidates` | Fetch and enrich top pool candidates (pool metrics + token audit + smart money) |
| `/study-pool` | Study top LPers on a specific pool |
| `/pool-ohlcv` | Fetch price/volume history for a pool |
| `/pool-compare` | Compare all Meteora DLMM pools for a token pair by APR, fee/TVL ratio, and volume |

#### Claude Code agents

Two specialized sub-agents run inside Claude Code:

**`screener`** — pool screening specialist. Invoke when you want to evaluate candidates, analyse token risk, or deploy a position. Has access to OKX smart money signals, full token audit pipeline, and all strategy logic.

**`manager`** — position management specialist. Invoke when reviewing open positions, assessing PnL, claiming fees, or closing positions.

To trigger an agent directly, just describe what you want:
```
> screen for new pools and deploy if you find something good
> review all my positions and close anything out of range
> what do you think of the SOL/BONK pool?
```

#### Loop mode

Run screening or management on a timer inside Claude Code:

```
/loop 30m /screen     # screen every 30 minutes
/loop 10m /manage     # manage every 10 minutes
```

---

### CLI (direct tool invocation)

The `meridian` CLI gives you direct access to every tool with JSON output — useful for scripting, debugging, or piping into other tools.

```bash
pnpm install -g .   # install globally (once)
meridian <command> [flags]
```

Or run without installing:

```bash
pnpm build
node dist/src/cli/cli.js <command> [flags]
```

**Positions & PnL**

```bash
meridian positions
meridian pnl <position_address>
meridian wallet-positions --wallet <addr>
```

**Screening**

```bash
meridian candidates --limit 5
meridian pool-detail --pool <addr> [--timeframe 5m]
meridian active-bin --pool <addr>
meridian search-pools --query <name_or_symbol>
meridian study --pool <addr> [--limit 4]
```

**Token research**

```bash
meridian token-info --query <mint_or_symbol>
meridian token-holders --mint <addr> [--limit 20]
meridian token-narrative --mint <addr>
```

**Deploy & manage**

```bash
meridian deploy --pool <addr> --amount <sol> [--bins-below 69] [--bins-above 0] [--strategy bid_ask|spot|curve] [--dry-run]
meridian claim --position <addr>
meridian close --position <addr> [--skip-swap] [--dry-run]
meridian swap --from <mint> --to <mint> --amount <n> [--dry-run]
meridian add-liquidity --position <addr> --pool <addr> [--amount-x <n>] [--amount-y <n>] [--strategy spot]
meridian withdraw-liquidity --position <addr> --pool <addr> [--bps 10000]
```

**Agent cycles**

```bash
meridian screen [--dry-run] [--silent]   # one AI screening cycle
meridian manage [--dry-run] [--silent]   # one AI management cycle
meridian start [--dry-run]               # start autonomous agent with cron jobs
```

**Config**

```bash
meridian config get
meridian config set <key> <value>
```

**Learning & memory**

```bash
meridian lessons
meridian lessons add "your lesson text"
meridian performance [--limit 200]
meridian evolve
meridian pool-memory --pool <addr>
```

**Blacklist**

```bash
meridian blacklist list
meridian blacklist add --mint <addr> --reason "reason"
```

**Balance**

```bash
meridian balance
```

**Flags**

| Flag | Effect |
|---|---|
| `--dry-run` | Skip all on-chain transactions |
| `--silent` | Suppress Telegram notifications for this run |

---

## Telegram

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add `TELEGRAM_BOT_TOKEN=<token>` to your `.env`
3. Start the agent, then send any message to your bot — it auto-registers your chat ID

### Notifications

Meridian sends notifications automatically for:
- Management cycle reports (reasoning + decisions)
- Screening cycle reports (what it found, whether it deployed)
- OOR alerts when a position leaves range past `outOfRangeWaitMinutes`
- Deploy: pair, amount, position address, tx hash
- Close: pair and PnL

### Telegram commands

| Command | Action |
|---|---|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set a note on a position |

You can also chat freely via Telegram using the same interface as the REPL.

---

## Config reference

All fields are optional — defaults shown. Edit `user-config.json`.

### Screening

| Field | Default | Description |
|---|---|---|
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio |
| `minTvl` | `10000` | Minimum pool TVL (USD) |
| `maxTvl` | `150000` | Maximum pool TVL (USD) |
| `minVolume` | `500` | Minimum pool volume |
| `minOrganic` | `60` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` | `150000` | Minimum market cap (USD) |
| `maxMcap` | `10000000` | Maximum market cap (USD) |
| `minBinStep` | `80` | Minimum bin step |
| `maxBinStep` | `125` | Maximum bin step |
| `strategy` | `bid_ask` | Deploy shape — `bid_ask`, `spot`, or `curve` |
| `binsBelow` | `69` | Number of bins below active to deploy liquidity into |
| `preset` | `custom` | Named preset label (informational) |
| `timeframe` | `5m` | Candle timeframe for screening |
| `category` | `trending` | Pool category filter |
| `minTokenFeesSol` | `30` | Minimum all-time fees in SOL |
| `maxBundlePct` | `30` | Maximum bundler % in top 100 holders |
| `maxBotHoldersPct` | `30` | Maximum bot-holder % (Jupiter audit) |
| `maxTop10Pct` | `60` | Maximum top-10 holder concentration |
| `minFeePerTvl24h` | `7` | Minimum 24h fee/TVL ratio |
| `minTokenAgeHours` | `null` | Minimum token age in hours (null = disabled) |
| `maxTokenAgeHours` | `null` | Maximum token age in hours (null = disabled) |
| `athFilterPct` | `null` | Skip pools whose price is within this % of ATH |
| `blockedLaunchpads` | `[]` | Launchpad names to never deploy into |

### Management

| Field | Default | Description |
|---|---|---|
| `deployAmountSol` | `0.5` | Base SOL per new position |
| `positionSizePct` | `0.35` | Fraction of deployable balance to use |
| `maxDeployAmount` | `50` | Maximum SOL cap per position |
| `maxPositions` | `3` | Maximum concurrent open positions |
| `gasReserve` | `0.2` | Minimum SOL to keep for gas |
| `minSolToOpen` | `0.55` | Minimum wallet SOL before opening |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR before acting |
| `outOfRangeBinsToClose` | `10` | Distance (bins) past range before close is considered |
| `oorCooldownTriggerCount` | `3` | OOR closes on a pool before cooldown kicks in |
| `oorCooldownHours` | `12` | Hours to skip a pool after the cooldown trigger |
| `minVolumeToRebalance` | `1000` | Minimum 24h volume required to rebalance |
| `minAgeBeforeYieldCheck` | `60` | Minutes after open before yield checks apply |
| `stopLossPct` | `-50` | Close position if PnL drops by this % |
| `emergencyPriceDropPct` | `-50` | Emergency exit if token price drops this % |
| `takeProfitFeePct` | `5` | Take profit when accrued fees hit this % of position |
| `minClaimAmount` | `5` | Minimum USD value of fees before claiming |
| `autoSwapAfterClaim` | `false` | Swap claimed base token to SOL automatically |
| `trailingTakeProfit` | `true` | Enable trailing take-profit |
| `trailingTriggerPct` | `3` | PnL % at which trailing TP arms |
| `trailingDropPct` | `1.5` | Drop from peak that triggers a trailing close |
| `pnlSanityMaxDiffPct` | `5` | Max allowed divergence between PnL sources |
| `solMode` | `false` | Display values in SOL instead of USD |

### Schedule

| Field | Default | Description |
|---|---|---|
| `managementIntervalMin` | `10` | Management cycle frequency (minutes) |
| `screeningIntervalMin` | `30` | Screening cycle frequency (minutes) |
| `healthCheckIntervalMin` | `60` | Health check frequency (minutes) |

### Models

| Field | Default | Description |
|---|---|---|
| `managementModel` | `minimax/minimax-m2.5` | LLM for management cycles |
| `screeningModel` | `minimax/minimax-m2.5` | LLM for screening cycles |
| `generalModel` | `minimax/minimax-m2.7` | LLM for REPL / chat |
| `temperature` | `0.373` | Sampling temperature for agent calls |
| `maxTokens` | `4096` | Max tokens per LLM response |
| `maxSteps` | `20` | Max tool-call iterations per ReAct loop |

> Override model at runtime: `meridian config set screeningModel anthropic/claude-opus-4-6`

### Darwinian signal weights

| Field | Default | Description |
|---|---|---|
| `darwinEnabled` | `true` | Enable signal-weight evolution |
| `darwinWindowDays` | `60` | Lookback window for performance data |
| `darwinMinSamples` | `10` | Minimum samples before a signal influences scoring |
| `darwinRecalcEvery` | `5` | Recalculate weights every N closed positions |
| `darwinBoost` | `1.05` | Multiplier applied to winning signals |
| `darwinDecay` | `0.95` | Multiplier applied to losing signals |
| `darwinFloor` | `0.3` | Minimum allowed weight |
| `darwinCeiling` | `2.5` | Maximum allowed weight |

---

## How it learns

### Lessons

After every closed position the agent runs `studyTopLPers` on candidate pools, analyzes on-chain behavior of top performers (hold duration, entry/exit timing, win rates), and saves concrete lessons. Lessons are injected into subsequent agent cycles as part of the system context.

Add a lesson manually:
```bash
meridian lessons add "Never deploy into pump.fun tokens under 2h old"
```

### Threshold evolution

After 5+ positions have been closed, run:
```bash
meridian evolve
```

This analyzes closed position performance (win rate, avg PnL, fee yields) and automatically adjusts screening thresholds in `user-config.json`. Changes take effect immediately.

### Darwinian signal weights

Beyond raw thresholds, Meridian tracks individual screening signals (`high_volume`, `strong_tvl`, `good_distribution`, etc.) and learns which ones actually predict winners. Each closed position updates the weights — winning signals get boosted, losing signals decay. Weights are persisted to `signal-weights.json` and used by `getTopCandidates()` to rank pools. Configure under the `darwin*` keys.

---

## Other features

### Trailing take profit

When PnL reaches `trailingTriggerPct` the position arms a trailing stop. The agent then tracks peak PnL and closes if it drops by `trailingDropPct` from that peak. Polled every 30 seconds between management cycles. Toggle with `trailingTakeProfit`.

### SOL mode

Set `solMode: true` to display positions, balances, and PnL in SOL terms instead of USD. Trading thresholds still use USD internally — this is display-only.

### OKX OnchainOS integration

If OKX API credentials are present, screening pulls advanced risk metrics per token: overall risk level, bundle %, sniper %, suspicious tx %, new-wallet %, and rugpull/wash flags. Falls back to Jupiter-only data if unavailable.

### Deployer blocklist

Separate from the token blacklist — bans specific deployer wallets across all of their tokens. Stored in `deployer-blacklist.json`.

---

## Hive Mind (optional)

Opt-in collective intelligence — share lessons and pool outcomes, receive crowd wisdom from other Meridian agents.

**What you get:** Pool consensus ("8 agents deployed here, 72% win rate"), strategy rankings, threshold medians.

**What you share:** Lessons, deploy outcomes, screening thresholds. No wallet addresses, private keys, or balances are ever sent.

### Setup

```bash
npx tsx -e "import('./hive-mind.ts').then(m => m.register('https://meridian-hive-api-production.up.railway.app', 'YOUR_TOKEN'))"
```

Get `YOUR_TOKEN` from the private Telegram discussion. This saves your credentials to `user-config.json` automatically.

### Disable

```json
{
  "hiveMindUrl": "",
  "hiveMindApiKey": ""
}
```

### Self-hosting

See [meridian-hive](https://github.com/fciaf420/meridian-hive) for the server source.

---

## Using a local model (LM Studio)

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works.

---

## Architecture

```
src/
  index.ts              Process entry — wires bootstrap, orchestrator, REPL
  bootstrap.ts          Loads config, env, state, telegram, logger
  orchestrator.ts       Cron scheduler for screening/management/health cycles
  repl.ts               Interactive REPL with live cycle countdown
  agent/
    agent.ts            ReAct loop: LLM → tool call → repeat
    prompt.ts           System prompt builder (SCREENER / MANAGER / GENERAL)
    tool-sets.ts        Per-role tool whitelists
    intent.ts           Intent classification for free-form chat
  cycles/
    screening.ts        Screening cycle: candidates → research → deploy
    management.ts       Management cycle: PnL, OOR, claim, close
  domain/
    lessons.ts          Performance recording + lesson derivation
    threshold-evolution.ts  Auto-tunes screening thresholds
    exit-rules.ts       Stop-loss / trailing TP / OOR exit logic
    signal-weights.ts   Darwinian signal weighting
    signal-tracker.ts   Records signal outcomes per position
    pool-memory.ts      Per-pool deploy history + snapshots
    strategy-library.ts Saved LP strategies
    smart-wallets.ts    KOL / alpha wallet tracker
    token-blacklist.ts  Permanent token blacklist
    dev-blocklist.ts    Deployer wallet blocklist
  infrastructure/
    telegram.ts             Bot polling + notifications
    briefing.ts             Daily HTML briefing
    logger.ts               Daily-rotating logs + audit trail
    state.ts                Position registry (state.json)
    confirmation-timers.ts  Peak / trailing-TP confirmation timer registry
    hive-mind.ts            Optional collective intelligence sync
  config/
    config.ts           Runtime config from user-config.json + .env
    constants.ts        Shared constants
    paths.ts            File path resolution
  cli/
    cli.ts              Direct CLI — every tool as a JSON subcommand
    setup.ts            Interactive setup wizard
  utils/
    cache.ts            TTL cache with periodic cleanup
  types/                TypeScript type definitions

tools/                   (sibling of src/, loaded by the executor)
  registry.ts           Tool registry
  definitions/          Tool schemas (OpenAI format)
  executor.ts           Tool dispatch + safety checks
  middleware.ts         Pre/post hooks (validation, audit)
  admin.ts              Admin tools (config, lessons, blocklists)
  discover.ts           Tool discovery helpers
  dlmm.ts               Meteora DLMM SDK wrapper
  screening.ts          Pool discovery
  wallet.ts             SOL/token balances + Jupiter swap
  token.ts              Token info, holders, narrative
  study.ts              Top LPer study via LPAgent API
  okx.ts                OKX OnchainOS integration

.claude/
  agents/
    screener.md         Claude Code screener sub-agent
    manager.md          Claude Code manager sub-agent
  commands/             /screen, /manage, /balance, /positions, /candidates,
                        /study-pool, /pool-ohlcv, /pool-compare
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
