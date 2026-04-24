---
name: Meridian
description: Autonomous DLMM liquidity provider agent for Meteora pools on Solana
---

# Meridian

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

## Quick Start

```bash
# Install and setup
pnpm install && pnpm run setup

# Build
pnpm build

# Run (dry-run mode for testing)
pnpm dev

# Run (live trading)
pnpm start
```

## Essential Commands

| Command | Description |
|---------|-------------|
| `pnpm build` | Compile TypeScript to dist/ |
| `pnpm start` | Run the agent (live trading) |
| `pnpm dev` | Run in dry-run mode (simulated) |
| `pnpm typecheck` | Run TypeScript type checker |
| `pnpm check` | Run Biome lint/format check on changed files |
| `pnpm test:phase0:all` | Run phase-0 safety tests |

## Configuration

**Precedence:** `.env` > `user-config.json` > hardcoded defaults

- **`.env`** — Secrets: wallet key, API keys (never committed)
- **`user-config.json`** — Preferences: models, thresholds, strategy

## Detailed Documentation

- [Architecture & Project Structure](.claude/docs/architecture.md)
- [Config Reference](.claude/docs/config-reference.md)
- [Code Style & Naming Conventions](.claude/docs/code-style.md)
- [Features](.claude/docs/features.md)
- [Screening Logic](.claude/docs/screening-logic.md)
- [Agents & Tools](.claude/docs/agents-and-tools.md)
- [Known Issues](.claude/docs/known-issues.md)
