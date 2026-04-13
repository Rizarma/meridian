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

## Data Files

Stored in project root by default (override with `MERIDIAN_ROOT` env var):
- `state.json` - Position tracking
- `lessons.json` - Learned rules from past positions
- `pool-memory.json` - Pool deployment history
- `meridian.db` - SQLite database (migrated state)

## Development Guidelines

1. **Always run typecheck before committing:** `pnpm typecheck`
2. **Pre-commit hooks run automatically** - Biome will lint/format staged files
3. **Use dry-run mode for testing:** `pnpm dev`
4. **Check health status:** `node cli.js health`

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
