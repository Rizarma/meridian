# Strategy Audit: `partial_harvest`

**Audit Date:** 2026-04-08  
**Auditor:** @explorer + @oracle  
**Status:** 🚨 **STUB (5%)**

---

## What the Strategy Promises

Per `strategy-library.ts` lines 213-217 and documentation:
- **Trigger**: When total return >= 10% of deployed capital
- **Action**: `withdraw_liquidity(bps=5000)` → remove 50% of liquidity
- **Behavior**: Keep remaining 50% running, repeat at next threshold
- **Post-withdrawal**: Swap base tokens to SOL to lock profits (per `manager.md:67`)

---

## What Code Actually Implements

| Component | Status | Details |
|-----------|--------|---------|
| Strategy definition | ✅ Exists | Data structure in `strategy-library.ts:202-219` |
| CLI command handler | ⚠️ Stub | `cli.ts:743-762` calls `withdrawLiquidity` from dlmm module |
| `withdrawLiquidity` function | ❌ **MISSING** | Referenced but **not implemented** in `tools/dlmm.ts` |
| Strategy-aware management | ❌ Missing | `management.ts`, `exit-rules.ts` don't check strategy IDs |
| Auto-trigger at 10% return | ❌ Missing | No code monitors for partial harvest thresholds |
| Repeat threshold logic | ❌ Missing | No tracking of "harvest count" or progressive withdrawals |
| Post-withdrawal swap | ❌ Missing | No automation to swap base tokens to SOL |

---

## What's Missing/Broken

1. **Critical**: `withdrawLiquidity()` function doesn't exist - CLI will crash if called
2. **Architecture gap**: Management cycle evaluates generic exit rules but never checks `position.strategy` for strategy-specific behavior
3. **No trigger mechanism**: The 10% take_profit_pct is defined but not wired to partial withdrawal logic
4. **No state tracking**: No field tracks "how much already harvested" for repeat threshold logic
5. **Missing tool**: No `withdraw_liquidity` tool definition in `tools/definitions/management.ts`

---

## Implementation Completeness Score: **5%**

Only the **documentation and data structure** exist. Zero functional implementation of the core partial withdrawal behavior.

---

## Verdict

This is the most incomplete strategy. It exists as a concept but has essentially zero working implementation.

---

## Recommended Fixes

| Priority | Fix | Effort |
|----------|-----|--------|
| P1 | Implement `withdrawLiquidity()` in `tools/dlmm.ts` using Meteora SDK's `removeLiquidity()` with `bps` parameter | High |
| P2 | Add strategy-aware exit evaluation in `management.ts` or `exit-rules.ts` | Medium |
| P3 | Track harvest state per position | Medium |
| P4 | Add post-withdrawal swap automation | Medium |
