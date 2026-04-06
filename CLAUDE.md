# Meridian

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

## Quick reference

- **Package manager:** pnpm
- **Entry:** `src/index.ts` → built to `dist/src/index.js`
- **Build:** `pnpm build`
- **Run (live):** `pnpm start`
- **Run (dry-run):** `pnpm dev`
- **Typecheck:** `pnpm typecheck`
- **Format / lint (changed files):** `pnpm check`

## Project layout at a glance

- `src/` — application code (agent loop, cycles, domain, infrastructure, config, CLI)
- `tools/` — tool handlers and registry (sibling of `src/`, auto-discovered at startup)
- `test/` — phase-numbered integration and safety tests
- `user-config.json` — runtime config (see `user-config.example.json`)
- `.env` — secrets only (wallet key, API keys)

## Detailed guidelines

- [Architecture](.claude/docs/architecture.md) — source layout, position lifecycle, race conditions
- [Agents & Tools](.claude/docs/agents-and-tools.md) — agent roles, registry pattern, adding a new tool, model configuration
- [Config Reference](.claude/docs/config-reference.md) — every config key, defaults, environment variables
- [Screening Logic](.claude/docs/screening-logic.md) — safety checks, bins_below formula, bundler/OKX signals, Darwinian weights
- [Features](.claude/docs/features.md) — lessons, trailing TP, SOL mode, telegram commands, hive mind
- [Known Issues](.claude/docs/known-issues.md) — intentional quirks and tech debt
