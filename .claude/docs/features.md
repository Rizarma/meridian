# Features

## Lessons system (src/domain/lessons.ts)

Records closed-position performance and auto-derives lessons.

- `getLessonsForPrompt({ agentType })` — injects relevant lessons into the system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers (see `src/domain/threshold-evolution.ts`)
- `recordPerformance()` is called from `tools/middleware.ts` (persistenceMiddleware) after every `close_position`

## Trailing take profit

Optional feature that protects upside while allowing runners.

- Activates when PnL reaches `trailingTriggerPct`
- Tracks peak PnL after activation
- Closes if PnL drops `trailingDropPct` from peak
- Enabled via `trailingTakeProfit: true`
- Uses lightweight ~30-second PnL polling between management cycles

Logic lives in `src/domain/exit-rules.ts`.

## SOL mode

Display mode that reports all values in SOL instead of USD.

- Positions, PnL, and balances shown in SOL terms
- Useful for SOL-denominated performance tracking
- Enabled via `solMode: true`
- Does **not** affect trading logic — screening thresholds still use USD internally

## Base fee calculation (tools/dlmm.ts)

Read from the pool object at deploy time:

```ts
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

## Telegram commands

Handled directly in the telegram bot poller (`src/infrastructure/telegram.ts`), bypassing the LLM:

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

## Hive Mind (src/infrastructure/hive-mind.ts)

Optional. Enabled by setting `HIVE_MIND_URL` and `HIVE_MIND_API_KEY` in `.env`. Syncs lessons and deploys to a shared server and queries consensus patterns. Not required for normal operation.
