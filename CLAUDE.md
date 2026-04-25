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
- [Features](.claude/docs/features.md) — lessons, trailing TP, SOL mode, telegram commands, hive mind, portfolio sync
- [Known Issues](.claude/docs/known-issues.md) — intentional quirks and tech debt

## Darwinian Signal Weighting Algorithm

### Confidence-Aware Proportional Update (v2)

When `darwin.useProportional: true` (default):

```
newWeight = oldWeight × exp(learningRate × lift × confidence)

where:
  lift = predictive strength (winMean - lossMean for numeric signals)
  confidence = sampleCount / (sampleCount + minSamples)  // 0.5 at minSamples
```

**Key properties:**
- Updates scale with both predictive strength AND statistical confidence
- Low-sample signals get dampened updates (reduces noise)
- Configurable deadband ignores tiny lifts
- Safety caps prevent extreme single-cycle changes
- All 10 signals can update simultaneously (not just top/bottom quartile)

### Legacy Quartile Update (v1)

When `darwin.useProportional: false`:

```
if signal in top quartile:   weight *= boostFactor  // default 1.5
if signal in bottom quartile: weight *= decayFactor // default 0.95
otherwise:                    no change
```

**Limitations:**
- Treats weak and strong signals equally within quartiles
- Ignores sample size / confidence
- No updates for middle 50% of signals
- Arbitrary boundaries at quartile edges

### Migration Path

Existing users automatically get proportional updates with sensible defaults. To revert to legacy behavior if issues arise:

```json
{
  "darwin": {
    "useProportional": false
  }
}
```

## Claude Code resources

- [`.claude/agents/`](.claude/agents/) — Screener and Manager agent definitions for Claude Code
- [`.claude/commands/`](.claude/commands/) — Terminal command definitions (`/screen`, `/manage`, `/balance`, etc.)

<!-- Last reviewed: 2025-04-09 -->
<!-- Updated: 2025-04-09 - Added MERIDIAN_ROOT env var documentation -->
