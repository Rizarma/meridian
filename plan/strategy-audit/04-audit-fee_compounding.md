# Strategy Audit: `fee_compounding`

**Audit Date:** 2026-04-08  
**Auditor:** @explorer + @oracle  
**Status:** ⚠️ **MINIMALLY IMPLEMENTED (15%)**

---

## What the Strategy Promises

Per `strategy-library.ts:163` and `manager.md:66`:
> "When unclaimed fees > $5 AND in range: **claim_fees → add_liquidity back into same position**. Normal close rules otherwise."

**Key promise**: Automatic compounding — claimed fees are immediately re-added as liquidity to the same position to maximize yield through reinvestment.

---

## What Code Actually Implements

| Component | Implementation Status |
|-----------|----------------------|
| **Strategy definition** | ✅ Defined in `strategy-library.ts:150-166` with ID, name, exit notes |
| **Claim threshold ($5)** | ✅ Implemented in `exit-rules.ts:131` — returns `action: "CLAIM"` when `unclaimed_fees_usd >= minClaimAmount` |
| **"In range" check** | ❌ **MISSING** — Claim rule doesn't verify `in_range` status |
| **Auto-compounding (add_liquidity)** | ❌ **COMPLETELY MISSING** — No code executes `add_liquidity` after `claim_fees` |
| **Strategy-aware management** | ❌ **MISSING** — Management cycle doesn't check position strategy to apply special handling |
| **Auto-swap after claim** | ✅ Exists in `middleware.ts:202-207` (swaps to SOL), but this is **not compounding** |

**Actual behavior**: The system can claim fees when they exceed $5, but then either:
- Auto-swaps them to SOL (if `autoSwapAfterClaim` enabled), or
- Leaves them as wallet tokens

**Never** adds them back to the position as liquidity.

---

## What's Missing/Broken

1. **Core compounding logic missing**: No code executes the `add_liquidity` step after `claim_fees`. The middleware has `handleAutoSwapAfterClaim()` but no `handleAutoCompoundAfterClaim()`.

2. **No "in range" gate**: The strategy specifies fees should only be claimed AND compounded when `in_range`, but `exit-rules.ts:131` only checks the dollar threshold.

3. **No strategy-specific execution**: The management cycle (`management.ts:207-236`) builds an action map using generic rules. It never checks `position.strategy === "fee_compounding"` to trigger the two-step claim→compound flow.

4. **No add_liquidity orchestration**: Even if the LLM were instructed to compound, there's no automatic mechanism to:
   - Calculate how much of each token was claimed
   - Call `add_liquidity` with those amounts back to the same position
   - Handle the transaction sequencing

5. **Documentation/code mismatch**: The manager agent docs describe the behavior, but the actual implementation stops at "claim" with no "compound" follow-through.

---

## Implementation Completeness Score: **15%**

| Feature | Weight | Status |
|---------|--------|--------|
| Strategy metadata | 10% | ✅ 100% |
| Claim threshold detection | 25% | ✅ 80% (missing in_range check) |
| In-range validation | 15% | ❌ 0% |
| Auto-compounding execution | 40% | ❌ 0% |
| Integration with management cycle | 10% | ❌ 0% |

---

## Verdict

The strategy exists on paper and can claim fees, but the defining "compounding" behavior (reinvesting claimed fees as liquidity) is entirely unimplemented.

---

## Recommended Fixes

| Priority | Fix | Effort |
|----------|-----|--------|
| P1 | Add `in_range` check to claim rule in `exit-rules.ts:131` | Low |
| P2 | Create `handleAutoCompoundAfterClaim()` in `middleware.ts` that calls `add_liquidity` with claimed amounts | High |
| P3 | Add strategy-aware branch in `management.ts` to detect `fee_compounding` positions and enable auto-compound flow | Medium |
| P4 | Or: Change the LLM prompt in `management.ts:307-321` to explicitly instruct the manager to call `add_liquidity` after `claim_fees` for fee_compounding positions | Low |
