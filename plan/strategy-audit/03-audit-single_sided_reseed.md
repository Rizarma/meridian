# Strategy Audit: `single_sided_reseed`

**Audit Date:** 2026-04-08  
**Auditor:** @explorer + @oracle  
**Status:** ⚠️ **PARTIALLY IMPLEMENTED (35%)**

---

## What the Strategy Promises

**From strategy-library.ts:**
- **Entry**: Token-only bid-ask deployment (amount_x only, amount_y=0), bins below active bin only
- **Range**: 100% bins below, 0 bins above (single-sided downside capture)
- **Exit Logic**: When OOR downside → close_position(skip_swap=true) → redeploy token-only bid-ask at new lower price. Do NOT swap to SOL. Full close only when token dead or after N re-seeds with declining performance.

**From screener.md (documented re-seed flow):**
1. `withdraw-liquidity --bps 10000` — withdraw all (mostly token after SOL→token conversion)
2. Check token balance
3. `add-liquidity --amount-x <token> --strategy bid_ask` — re-add token-only into SAME position
4. Position stays open — same bins, same range, just refilled with token

**From manager.md:**
- When OOR downside → close(skip_swap=true) → redeploy token-only bid-ask at new price (do NOT swap to SOL)

---

## What Code Actually Implements

| Component | Implementation Status |
|-----------|----------------------|
| **Strategy definition** | ✅ Fully defined in strategy-library.ts |
| **Position tracking** | ✅ Strategy stored in state.ts when deployed |
| **skip_swap parameter** | ✅ Exists in close_position tool |
| **withdraw-liquidity CLI** | ✅ Available (cli.ts:743-761) |
| **add-liquidity CLI** | ✅ Available (cli.ts:764-786) |
| **Automatic OOR downside detection** | ❌ NOT implemented |
| **Automatic reseed execution** | ❌ NOT implemented |
| **Reseed counter/tracking** | ❌ NOT implemented |
| **Declining performance detection** | ❌ NOT implemented |
| **Strategy-aware exit rules** | ❌ NOT implemented (exit-rules.ts is strategy-agnostic) |

**What actually happens in management cycle:**
1. Exit rules evaluate all positions the same way (no strategy-specific logic)
2. OOR downside → returns `CLOSE` action with "OOR" reason
3. LLM (MANAGER agent) receives position with `strategy: "single_sided_reseed"` in context
4. LLM must **manually decide** to use withdraw-liquidity + add-liquidity instead of close
5. No automatic execution of reseed flow

---

## What's Missing/Broken

**Critical Gaps:**

1. **No Automatic Reseed Logic**: The management cycle has no code to automatically detect `single_sided_reseed` + OOR downside and execute the reseed flow. It relies entirely on the LLM reading the strategy name and deciding to use different CLI commands.

2. **Documentation Inconsistency**: 
   - screener.md says: withdraw + add-liquidity (position stays open)
   - manager.md says: close(skip_swap=true) → redeploy (new position)
   - These are fundamentally different approaches

3. **No Reseed Counter**: The strategy promises "full close only when... after N re-seeds with declining performance" but there's no tracking of how many times a position has been reseeded.

4. **No Declining Performance Detection**: No code tracks performance across reseeds to detect declining returns.

5. **Strategy-Agnostic Exit Rules**: exit-rules.ts:87-136 evaluates all positions identically, regardless of strategy. No special handling for single_sided_reseed OOR downside.

6. **No "Token Dead" Detection**: Strategy says "full close only when token dead" but no automated detection exists for dead tokens.

---

## Implementation Completeness Score: **35%**

| Category | Score | Notes |
|----------|-------|-------|
| Strategy definition | 100% | Fully defined with all parameters |
| CLI infrastructure | 90% | Commands exist but require manual execution |
| Automatic execution | 10% | Only has position tracking; no automated reseed |
| Documentation consistency | 40% | Conflicting reseed approaches documented |
| State management | 30% | Strategy stored but no reseed counter/performance tracking |

---

## Verdict

The strategy exists as a **manual framework** — an LLM-aware human operator could execute it using the documented CLI commands, but there is **zero automatic execution** of the promised reseed behavior. The system relies entirely on the MANAGER agent reading the strategy name and making the right decision, with no code-level enforcement of the reseed logic.

---

## Recommended Fixes

| Priority | Fix | Effort |
|----------|-----|--------|
| P1 | Resolve documentation inconsistency (pick one approach) | Low |
| P2 | Add strategy-aware exit rules for OOR downside detection | Medium |
| P3 | Implement automatic reseed execution (withdraw + add-liquidity OR close + redeploy) | High |
| P4 | Add reseed counter and declining performance tracking | Medium |
| P5 | Implement "token dead" detection logic | Medium |
