# Strategy Audit: `multi_layer`

**Audit Date:** 2026-04-08  
**Auditor:** @explorer + @oracle  
**Status:** 🚨 **STUB/BROKEN (15%)**

---

## What the Strategy Promises

Per `strategy-library.ts` lines 167-201 and documentation:

- **Core Concept**: Layer multiple LP shapes into ONE position via `addLiquidityByStrategy` to sculpt a composite distribution
- **Deployment Pattern**: 
  - Step 1: Deploy with first shape (creates position)
  - Step 2+: Add liquidity to same position with different shapes (Bid-Ask → Spot → Curve)
- **Result**: All layers share the same bin range but stack different distribution curves
- **Management**: Single position to manage; fees reflect ALL layers combined

**Example patterns documented:**
- `smooth_edge`: Bid-Ask (edges) → Spot (fills middle)
- `full_composite`: Bid-Ask → Spot → Curve (3 layers)
- `edge_heavy`: Bid-Ask → Bid-Ask again (double edge weight)

---

## What Code Actually Implements

| Component | Status | Details |
|-----------|--------|---------|
| Strategy definition | ✅ EXISTS | `strategy-library.ts:167-201` with `lp_strategy: "mixed"` |
| Type definitions | ✅ EXISTS | `strategy.d.ts:5` includes "mixed" in `LPStrategyType` |
| Documentation | ✅ EXISTS | Detailed in screener.md, manager.md, manage.md |
| **Multi-layer deployment logic** | ❌ **MISSING** | No code implements the "Step 2+: add-liquidity" pattern |
| **addLiquidity function** | ❌ **BROKEN** | `cli.ts:773` imports `addLiquidity` from `dlmm.js` but **function does not exist** |
| Screening cycle integration | ❌ MISSING | `screening.ts` has no multi-layer deployment logic |
| deploy_position handler | ⚠️ PARTIAL | Only handles single strategy (spot/curve/bid_ask), no "mixed" handling |

**Critical Bug Found:**
```typescript
// cli.ts:771-785
const dlmmModule = await import("../../tools/dlmm.js");
const addLiquidity = (dlmmModule as Record<string, unknown>).addLiquidity as (...) => Promise<unknown>;
// ^^^ This function DOES NOT EXIST in dlmm.ts - only deployPosition is exported
```

---

## What's Missing/Broken

**HIGH SEVERITY:**
1. **`addLiquidity` function not implemented** - The CLI has a command that crashes because the function doesn't exist
2. **No automated multi-layer deployment** - The screening cycle cannot actually execute the documented 2-3 step deployment process
3. **No "mixed" strategy handling in deployPosition** - The deploy handler only accepts spot/curve/bid_ask, throws error for "mixed"

**MEDIUM SEVERITY:**
4. **No position tracking for layers** - State tracking doesn't record which layers are in a position
5. **No management logic for composite positions** - Manager.md says "manage each sub-position independently" but there's no code to identify sub-positions

**LOW SEVERITY:**
6. **No validation for layer compatibility** - No checks that layered shapes make sense together

---

## Implementation Completeness Score: **15%**

| Area | Score | Rationale |
|------|-------|-----------|
| Data model | 80% | Strategy defined, types exist |
| Documentation | 90% | Well documented for agents |
| Core deployment logic | 5% | Single deploy works; multi-layer doesn't |
| Add liquidity to existing | 0% | Function missing entirely |
| CLI integration | 10% | Command exists but broken |
| Screening integration | 0% | No automated multi-layer deploys |
| Management integration | 10% | Generic position management only |

---

## Verdict

The strategy is essentially a **stub**. It exists as a concept and is well-documented for manual execution by agents, but zero automated implementation exists. The CLI's `add-liquidity` command is broken (references non-existent function).

---

## Recommended Fixes

| Priority | Fix | Effort |
|----------|-----|--------|
| P1 | **Immediate**: Remove or disable the broken `add-liquidity` CLI command | Low |
| P2 | Implement `addLiquidity()` function in `dlmm.ts` for adding to existing positions | High |
| P3 | Add multi-layer deployment logic to screening cycle (detect when strategy is "mixed", execute sequential deploy+addLiquidity calls) | High |
| P4 | Add position metadata tracking to record which layers exist in composite positions | Medium |
