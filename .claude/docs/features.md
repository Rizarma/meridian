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

## Portfolio Sync

Cross-machine learning feature that fetches your historical LP positions from Meteora API. Useful when running the bot on multiple machines or bootstrapping a fresh deployment with your existing LP history.

**Configuration** (`user-config.json`):
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

**Default**: `enabled: false` — feature is opt-in, zero impact when disabled.

## Hive Mind (src/infrastructure/hive-mind.ts)

Optional. Enabled by setting `HIVE_MIND_URL` and `HIVE_MIND_API_KEY` in `.env`. Syncs lessons and deploys to a shared server and queries consensus patterns. Not required for normal operation.
