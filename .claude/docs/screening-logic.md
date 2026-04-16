# Screening Logic

## Safety checks on deploy

Enforced by `tools/middleware.ts` (safetyCheckMiddleware) before `deploy_position` runs:

- `bin_step` must be within `[minBinStep, maxBinStep]`
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same `pool_address`)
- No duplicate base token allowed (same `base_mint` in another open pool)
- If `amount_x > 0`: strip `amount_y` and `amount_sol` (tokenX-only deploy — no SOL needed)
- SOL balance must cover `amount_y + gasReserve` (skipped for tokenX-only)
- `blockedLaunchpads` enforced in `getTopCandidates()` before the LLM ever sees the candidate list

## bins_below calculation

Linear formula based on pool volatility. Set in the SCREENER prompt (`src/agent/prompt.ts`):

```
bins_below = round(35 + (volatility / 5) * 34), clamped to [35, 69]
```

- Low volatility (0) → 35 bins
- High volatility (5+) → 69 bins
- Continuous — any value in between is valid

## Bundler detection (tools/token.ts)

Two signals in `getTokenHolders()`:

- `common_funder` — multiple wallets funded by the same source
- `funded_same_window` — multiple wallets funded in the same time window

**Thresholds:** `maxBundlePct` (default 30%), `maxTop10Pct` (default 60%).
**Jupiter audit API:** `botHoldersPercentage` (5–25% is normal for legitimate tokens).

## OKX OnchainOS integration (tools/okx.ts)

Optional screening data source. Enabled automatically when OKX credentials are set; falls back to Jupiter-only data otherwise.

Advanced risk metrics per token:

- `risk_level` — Overall risk (1–5 scale)
- `bundle_pct` — Percentage of supply bundled at launch
- `sniper_pct` — Sniper bot activity
- `suspicious_pct` — Suspicious transaction %
- `new_wallet_pct` — New wallets among holders
- `is_rugpull` / `is_wash` — Boolean pattern flags

## Signal weights (src/domain/signal-weights.ts)

Darwinian system that evolves which screening signals predict profitability:

- Tracks performance of signals like `high_volume`, `strong_tvl`, `good_distribution`, etc.
- Adjusts weights based on win rate (winners boost, losers decay)
- Configured via `darwin*` keys (see [config reference](config-reference.md))
- Persisted to SQLite (`signal_weights` table)
- Used by `getTopCandidates()` to score and rank pools
