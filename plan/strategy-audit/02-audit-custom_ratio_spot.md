# Strategy Audit: `custom_ratio_spot`

**Audit Date:** 2026-04-08  
**Auditor:** @explorer + @oracle  
**Status:** ⚠️ **PARTIALLY IMPLEMENTED (15%)**

---

## What the Strategy Promises

| Aspect | Promise (from docs & definition) |
|--------|----------------------------------|
| **Entry** | Directional ratio-based allocation: 75% token = bullish, 75% SOL = bearish |
| **Capital Split** | `token_pct` / `sol_pct` based on momentum (price_change + net_buyers) |
| **Bin Range** | `bins_below:bins_above` proportional to token:SOL ratio (e.g., 75% token → 52 below / 17 above) |
| **Exit** | Close when OOR or TP hit; re-deploy with **updated ratio** based on new momentum |
| **Shape** | `spot` strategy type |

---

## What Code Actually Implements

| Promise | Implementation Status |
|---------|----------------------|
| Strategy data structure | ✅ Defined in `strategy-library.ts` lines 102-125 |
| Default active strategy | ✅ Set as default (line 236) |
| `lp_strategy` field usage | ✅ Passed to deploy tool (`"spot"`) |
| Display to LLM | ✅ Shown in screening prompt |
| **Ratio calculation** | ❌ **NOT IMPLEMENTED** - No code calculates token_pct/sol_pct |
| **Capital allocation split** | ❌ **NOT IMPLEMENTED** - No code splits deploy amount |
| **Ratio-proportional bins** | ❌ **NOT IMPLEMENTED** - Uses hardcoded formula `round(35 + (volatility/5)*34)` |
| **Re-deploy with updated ratio** | ❌ **NOT IMPLEMENTED** - Mentioned in docs, no code implements this |
| **Momentum-based ratio updates** | ❌ **NOT IMPLEMENTED** |

---

## What's Missing/Broken

1. **No Ratio Engine**: The core concept—calculating token/SOL ratio from momentum signals—exists only in documentation (`.claude/agents/screener.md` table). No code performs this calculation.

2. **No Capital Splitting**: The deploy tool accepts `amount_x` and `amount_y` separately, but no code computes these based on a ratio. The screening cycle uses a single `deployAmount` in SOL only.

3. **Hardcoded Bin Formula**: The actual bin calculation (`bins_below = round(35 + (volatility/5)*34)`) completely ignores the strategy's promised ratio-proportional bins.

4. **No Automated Rebalancing**: The exit criteria mentions "re-deploy with updated ratio" but this is purely manual/LLM-driven. No automatic rebalancing logic exists.

5. **Strategy is Documentation-Only**: The strategy works only if the LLM manually follows the documentation. No code enforces or automates the strategy rules.

---

## Implementation Completeness Score: **15%**

| Component | Weight | Score |
|-----------|--------|-------|
| Data structure | 10% | 100% |
| Default assignment | 10% | 100% |
| Basic deploy integration | 20% | 50% |
| Ratio calculation | 20% | 0% |
| Capital allocation | 20% | 0% |
| Rebalancing logic | 20% | 0% |

---

## Verdict

The `custom_ratio_spot` strategy is a **placeholder strategy**—it exists as metadata and documentation but its core behavioral logic is entirely unimplemented. The system relies on the LLM reading the documentation and manually applying the rules, with no programmatic enforcement of the ratio-based mechanics that define the strategy.

---

## Recommended Fixes

| Priority | Fix | Effort |
|----------|-----|--------|
| P1 | Implement ratio calculation engine based on momentum signals | Medium |
| P2 | Modify deploy to split capital according to calculated ratio | Medium |
| P3 | Override bin formula when this strategy is active | Low |
| P4 | Add automated rebalancing when momentum signals change | High |
