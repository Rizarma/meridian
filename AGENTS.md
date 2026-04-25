---
name: Meridian
description: Autonomous DLMM liquidity provider agent for Meteora pools on Solana
---

# Meridian

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

## Quick Start

```bash
# Install dependencies and run setup wizard
pnpm install && pnpm run setup

# Build the project
pnpm build

# Run type checker
pnpm typecheck

# Run linter and formatter check
pnpm check
```

## Essential Commands

| Command | Description |
|---------|-------------|
| `pnpm build` | Compile TypeScript to dist/ |
| `pnpm start` | Run the agent (live trading) |
| `pnpm dev` | Run in dry-run mode (simulated) |
| `pnpm typecheck` | Run TypeScript type checker |
| `pnpm check` | Run Biome lint/format check on changed files |
| `pnpm format:all` | Format all files with Biome |
| `pnpm lint:check` | Lint changed files |
| `pnpm test:phase0:all` | Run phase-0 safety tests |
| `meridian db migrate` | Run database migrations (SQLite or Postgres) |

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

## Configuration

**Precedence:** `.env` > `user-config.json` > hardcoded defaults

- Use `.env` for secrets and environment-specific overrides
- Use `user-config.json` for day-to-day tuning (models, screening thresholds)

### Portfolio Sync (Cross-Machine Learning)

Optional feature to sync historical LP data from Meteora API. Useful when running the bot on multiple machines or bootstrapping a fresh deployment with your existing LP history.

**Enable in `user-config.json`:**
```json
"portfolioSync": {
  "enabled": true,
  "daysBack": 90,
  "minPositionsForLesson": 3,
  "refreshIntervalMinutes": 30,
  "bootstrapThreshold": {
    "minUniquePools": 3,
    "requireRiskLessons": true,
    "maxLessonAgeDays": 7
  }
}
```

**What it does**:
- Fetches your wallet's historical LP positions from Meteora (90 days back)
- Generates lessons about pool reliability and performance
- Enables performance comparison (your results vs pool average)
- Bootstraps learning on fresh deployments when lesson coverage is insufficient
- Refreshes data automatically for active pools every `refreshIntervalMinutes`

**How bootstrap works**:
The bot checks lesson coverage on startup. It fetches portfolio history only if:
- You have fewer than 3 unique pools in lessons, OR
- You have no lessons from losing positions (risk awareness), OR
- Your newest lesson is older than 7 days

This ensures you get historical context when you need it, not just when lesson count is low.

**Default**: Disabled (`enabled: false`)

### Darwinian Signal Weighting Configuration

Controls how the system learns from closed positions to adjust screening signal importance.

```json
{
  "darwin": {
    "windowDays": 30,              // Rolling window for performance data
    "minSamples": 20,               // Minimum positions before recalculation
    "minWins": 5,                   // Minimum wins for meaningful class balance
    "minLosses": 5,                 // Minimum losses for meaningful class balance
    "weightFloor": 0.5,             // Minimum weight (prevents total suppression)
    "weightCeiling": 2.0,           // Maximum weight (prevents over-reliance)

    // Confidence-aware proportional update (default: true)
    "useProportional": true,
    "learningRate": 0.20,           // Speed of weight adjustment (0.1-0.5)
    "deadband": 0.03,               // Ignore lifts smaller than this (noise filter)
    "minConfidence": 0.5,           // Minimum confidence required to update
    "maxMultiplierPerCycle": 2.0,   // Safety cap on single-update change

    // LEGACY: Used when useProportional=false
    "boostFactor": 1.5,             // Quartile boost multiplier
    "decayFactor": 0.95             // Quartile decay multiplier
  }
}
```

**Active Signals (9 total):**
- `organic_score` - Wallet clustering quality score
- `fee_tvl_ratio` - Fee generation efficiency
- `volume` - Trading volume (log-normalized)
- `mcap` - Market cap (log-normalized, sweet spot $100K-$10M)
- `holder_count` - Number of token holders
- `smart_wallets_present` - Boolean: smart money in pool
- `narrative_quality` - Categorical: narrative strength
- `hive_consensus` - Collective intelligence win rate
- `volatility` - Price volatility (moderate is good)

**Proportional vs Quartile:**
- **Proportional (recommended)**: Weight changes scale with predictive lift magnitude and sample confidence. Stronger signals = faster learning. Safer with low data.
- **Quartile (legacy)**: Uniform 5% boost/decay based on ranking. Simpler but wastes learning opportunity and ignores confidence.

**Health Monitoring:**
The system logs warnings when signals get stuck at weight boundaries:
- Warning at 3 consecutive recalcs at floor/ceiling
- Critical alert when 3+ signals simultaneously stuck at extremes
- Check logs for `signal_weights_health` and `signal_weights_health_alert`

## Data Storage

All data is stored in a SQLite database (`meridian.db`) in the project root by default. Override location with `MERIDIAN_ROOT` env var.

**Main tables:**
- `positions` - Open position tracking with bin ranges, OOR status, notes
- `position_snapshots` - Historical position state snapshots
- `position_events` - Deploy, close, claim events
- `pools` - Pool metadata and deploy history
- `lessons` - Learned rules from closed positions
- `performance` - Closed position performance records
- `signal_weights` - Darwinian signal weighting data
- `signal_weight_history` - Historical weight changes with confidence scores
- `threshold_suggestions` - Pending threshold evolution suggestions (V2)
- `threshold_history` - Applied threshold changes history
- `portfolio_history` - Cross-machine portfolio sync data from Meteora API

Legacy JSON files (`state.json`, `lessons.json`, `pool-memory.json`, `signal-weights.json`) are kept as backups but no longer actively used.

## Development Guidelines

### Code Quality
1. **Always run typecheck before committing:** `pnpm typecheck`
2. **Pre-commit hooks run automatically** - Biome will lint/format staged files
3. **Use dry-run mode for testing:** `pnpm dev`
4. **Check health status:** `node cli.js health`

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Variables/functions | camelCase | `getPoolData`, `isValid` |
| Constants | UPPER_SNAKE_CASE | `MAX_RETRIES`, `API_URL` |
| Types/interfaces | PascalCase | `PoolData`, `ConfigOptions` |
| Files | kebab-case | `pool-screening.ts`, `health-check.ts` |
| Classes | PascalCase | `RateLimiter`, `StateManager` |
| Enums | PascalCase + enum values: UPPER_SNAKE_CASE | `enum ExitReason { STOP_LOSS, TAKE_PROFIT }` |
| Private methods | camelCase with underscore prefix | `_internalMethod()` |
| Boolean variables | Prefix with `is`, `has`, `should`, `can` | `isActive`, `hasBalance` |

## Detailed Documentation

See [CLAUDE.md](./CLAUDE.md) for comprehensive documentation including:
- Architecture diagrams and service flow
- Detailed config reference
- Screening logic and safety checks
- Agent definitions and commands
- Known issues and tech debt

## Environment Variables

Copy `.env.example` to `.env` and fill in:
- `WALLET_PRIVATE_KEY` - Solana wallet private key (base58)
- `OPENROUTER_API_KEY` - LLM provider API key
- `HELIUS_API_KEY` - Solana RPC API key
- `TELEGRAM_BOT_TOKEN` - Optional: Telegram notifications
