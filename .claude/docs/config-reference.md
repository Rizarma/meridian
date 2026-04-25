# Config Reference

Configuration follows 12-Factor App best practices with clear separation of concerns:

- **`.env`** — Secrets and environment-specific overrides (never committed)
- **`user-config.json`** — User preferences and tuning (portable, can be shared)
- **Hardcoded defaults** — Sensible fallbacks for all settings

**Precedence:** `.env` > `user-config.json` > hardcoded defaults

Runtime mutations go through the `update_config` tool, which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if schedule intervals changed

## What goes where

| Setting Type | File | Examples |
|-------------|------|----------|
| Secrets | `.env` | `WALLET_PRIVATE_KEY`, `OPENROUTER_API_KEY`, `HELIUS_API_KEY` |
| Environment overrides | `.env` | `RPC_URL` (for staging/prod), `DRY_RUN` |
| LLM Endpoint | `.env` | `LLM_BASE_URL`, `LLM_MODEL` (endpoint URL and global model override) |
| Per-role Models | `user-config.json` | `managementModel`, `screeningModel`, `generalModel` (tuning) |
| Thresholds | `user-config.json` | `minTvl`, `maxTvl`, `stopLossPct`, `minOrganic` |
| Strategy | `user-config.json` | `strategy`, `binsBelow`, `deployAmountSol` |
| Intervals | `user-config.json` | `managementIntervalMin`, `screeningIntervalMin` |

## Environment variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON-array private key |
| `RPC_URL` | Yes* | Solana RPC endpoint (*can be set in user-config.json) |
| `OPENROUTER_API_KEY` | Yes* | LLM API key (*or set `LLM_BASE_URL` + `LLM_API_KEY` in .env for local LLM) |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |
| `LPAGENT_API_KEY` | No | LP Agent API access |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target (auto-filled on first message) |
| `TELEGRAM_ALLOWED_USER_IDS` | No | Comma-separated list of user IDs allowed to send commands |
| `LLM_BASE_URL` | No | Override LLM endpoint URL (e.g. LM Studio, local providers) |
| `LLM_API_KEY` | No | Override LLM auth (local endpoints) |
| `LLM_MODEL` | No | Override ALL models globally (takes precedence over role-specific models in user-config.json) |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HIVE_MIND_AGENT_ID` | No | Hive mind agent ID (from registration) |
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` / `OKX_PROJECT_ID` | No | OKX OnchainOS risk data |
| `ALLOW_SELF_UPDATE` | No | Enable dangerous admin actions (default: false) |
| `LOG_LEVEL` | No | Log verbosity: `debug`, `info`, `warn`, `error` (default: info) |

## Screening

| Key | Default | Description |
|-----|---------|-------------|
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee / active-TVL ratio |
| `minTvl` / `maxTvl` | `10000` / `150000` | Pool TVL bounds (USD) |
| `minVolume` | `500` | Minimum pool volume |
| `minOrganic` | `60` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` / `maxMcap` | `150000` / `10000000` | Market cap bounds (USD) |
| `minBinStep` / `maxBinStep` | `80` / `125` | Bin step bounds |
| `timeframe` | `"5m"` | Candle timeframe for screening |
| `category` | `"trending"` | Pool category filter |
| `minTokenFeesSol` | `30` | Minimum all-time fees in SOL |
| `maxBundlePct` | `30` | Max bundler % in top 100 holders |
| `maxBotHoldersPct` | `30` | Max bot-holder % (Jupiter audit) |
| `maxTop10Pct` | `60` | Max top-10 holder concentration |
| `minFeePerTvl24h` | `7` | Minimum 24h fee/TVL ratio |
| `minTokenAgeHours` / `maxTokenAgeHours` | `null` / `null` | Token age bounds in hours (null = disabled) |
| `athFilterPct` | `null` | Skip pools within this % of ATH |
| `blockedLaunchpads` | `[]` | Launchpad names to never deploy into |

## Management

| Key | Default | Description |
|-----|---------|-------------|
| `deployAmountSol` | `0.5` | Base SOL per new position (floor) |
| `maxDeployAmount` | `50` | Max SOL cap per position (ceiling) |
| `maxPositions` | `3` | Max concurrent open positions |
| `positionSizePct` | `0.35` | Fraction of deployable balance to use |
| `minSolToOpen` | `0.55` | Minimum wallet SOL before opening a new position |
| `gasReserve` | `0.2` | Minimum SOL to keep for gas |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR before acting |
| `outOfRangeBinsToClose` | `10` | Bin distance past range before close is considered |
| `oorCooldownTriggerCount` | `3` | OOR closes on a pool before cooldown kicks in |
| `oorCooldownHours` | `12` | Hours to skip a pool after cooldown trigger |
| `minVolumeToRebalance` | `1000` | Minimum 24h volume required to rebalance |
| `minAgeBeforeYieldCheck` | `60` | Minutes after open before yield checks apply |
| `stopLossPct` | `-50` | Close position if PnL drops by this % |
| `emergencyPriceDropPct` | `-50` | Emergency exit if token price drops this % |
| `takeProfitFeePct` | `5` | Take profit when accrued fees hit this % of position |
| `minClaimAmount` | `5` | Minimum USD value of fees before claiming |
| `autoSwapAfterClaim` | `false` | Swap claimed base token to SOL automatically |
| `trailingTakeProfit` | `true` | Enable trailing take-profit |
| `trailingTriggerPct` | `3` | PnL % at which trailing TP arms |
| `trailingDropPct` | `1.5` | Drop from peak that triggers trailing close |
| `pnlSanityMaxDiffPct` | `5` | Max allowed divergence between PnL sources |
| `solMode` | `false` | Display values in SOL instead of USD |

## Schedule

| Key | Default | Description |
|-----|---------|-------------|
| `managementIntervalMin` | `10` | Management cycle frequency (minutes) |
| `screeningIntervalMin` | `30` | Screening cycle frequency (minutes) |
| `healthCheckIntervalMin` | `60` | Health check frequency (minutes) |

## Darwinian signal weights

| Key | Default | Description |
|-----|---------|-------------|
| `features.darwinEvolution` | `false` | Enable signal-weight evolution |
| `darwin.windowDays` | `30` | Lookback window for performance data (days) |
| `darwin.minSamples` | `20` | Minimum positions before recalculation |
| `darwin.minWins` | `5` | Minimum wins for meaningful class balance |
| `darwin.minLosses` | `5` | Minimum losses for meaningful class balance |
| `darwin.weightFloor` | `0.5` | Minimum allowed weight |
| `darwin.weightCeiling` | `2.0` | Maximum allowed weight |
| `darwin.useProportional` | `true` | Use confidence-aware proportional updates (v2) |
| `darwin.learningRate` | `0.20` | Speed of weight adjustment (0.1-0.5) |
| `darwin.deadband` | `0.03` | Ignore lifts smaller than this (noise filter) |
| `darwin.minConfidence` | `0.5` | Minimum confidence required to update |
| `darwin.maxMultiplierPerCycle` | `2.0` | Safety cap on single-update change |
| `darwin.boostFactor` | `1.5` | **Legacy only:** Quartile boost multiplier (useProportional=false) |
| `darwin.decayFactor` | `0.95` | **Legacy only:** Quartile decay multiplier (useProportional=false) |

**Note:** The system monitors weight health and logs warnings when signals get stuck at floor/ceiling boundaries. Check logs for `signal_weights_health` messages.

## LLM

| Key | Default | Description |
|-----|---------|-------------|
| `managementModel` | `minimax/minimax-m2.5` | LLM for management cycles (user-config tuning) |
| `screeningModel` | `minimax/minimax-m2.5` | LLM for screening cycles (user-config tuning) |
| `generalModel` | `minimax/minimax-m2.7` | LLM for REPL / chat (user-config tuning) |
| `temperature` | `0.373` | Sampling temperature |
| `maxTokens` | `4096` | Max output tokens per call (minimum 2048 for free models) |
| `maxSteps` | `20` | Max ReAct iterations per cycle |

**Model Precedence:**
1. `LLM_MODEL` env var (if set) — overrides all roles globally
2. `managementModel`/`screeningModel`/`generalModel` in `user-config.json` — per-role tuning
3. Hardcoded defaults (`xiaomi/mimo-v2-omni`)

## computeDeployAmount

Scales position size with wallet balance (compounding):

```
clamp(deployable × positionSizePct, floor = deployAmountSol, ceil = maxDeployAmount)
```

## Environment variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON-array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target (auto-filled on first message) |
| `LLM_BASE_URL` | No | Override LLM endpoint URL (e.g. LM Studio, local providers) |
| `LLM_API_KEY` | No | Override LLM auth (local endpoints) |
| `LLM_MODEL` | No | Override ALL models globally (takes precedence over role-specific models) |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HIVE_MIND_AGENT_ID` | No | Hive mind agent ID (from registration) |
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | No | OKX OnchainOS risk data |
