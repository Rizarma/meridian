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
- `user-config.json` — user preferences: models, thresholds, strategy, intervals
- `.env` — secrets only: wallet key, API keys (never committed)

**Configuration precedence:** `.env` > `user-config.json` > hardcoded defaults
- Use `.env` for secrets and environment-specific overrides (CI/CD, Docker)
- Use `user-config.json` for day-to-day tuning (models, screening thresholds, strategy)

**Data storage:** SQLite database (`meridian.db`) stores all state, lessons, pool memory, and signal weights. Override location with `MERIDIAN_ROOT` env var.

**Timezone:** Set `TZ` env var to change log timestamps from UTC (e.g., `TZ=Asia/Jakarta`). File rotation dates remain UTC.

## Detailed guidelines

- [Architecture](.claude/docs/architecture.md) — source layout, position lifecycle, race conditions
- [Agents & Tools](.claude/docs/agents-and-tools.md) — agent roles, registry pattern, adding a new tool, model configuration
- [Config Reference](.claude/docs/config-reference.md) — every config key, defaults, environment variables
- [Screening Logic](.claude/docs/screening-logic.md) — safety checks, bins_below formula, bundler/OKX signals, Darwinian weights
- [Features](.claude/docs/features.md) — lessons, trailing TP, SOL mode, telegram commands, hive mind
- [Known Issues](.claude/docs/known-issues.md) — intentional quirks and tech debt

## Claude Code resources

- [`.claude/agents/`](.claude/agents/) — Screener and Manager agent definitions for Claude Code
- [`.claude/commands/`](.claude/commands/) — Terminal command definitions (`/screen`, `/manage`, `/balance`, etc.)

<!-- Last reviewed: 2025-04-09 -->
<!-- Updated: 2025-04-09 - Added MERIDIAN_ROOT env var documentation -->
