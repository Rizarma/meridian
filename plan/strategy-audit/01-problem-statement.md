# Strategy System Audit — Problem Statement

**Branch:** `fix/strategy-system-audit`  
**Created:** 2026-04-08  
**Scope:** Meridian LP Strategy Library & Execution Gap Analysis

---

## Executive Summary

The strategy library appears sophisticated with 5 built-in strategies, but there is a significant **implementation gap** between strategy definitions and actual execution. Strategies are primarily "documentation-only" — they describe intent but are not enforced during deploy or management cycles.

---

## Core Problems

### Problem 1: Strategy is Prompt-Only (No Code Enforcement)

**What:** The active strategy is injected into the screening prompt as descriptive text. The LLM may ignore or misinterpret it. There is no code validation that the deployed position actually follows the strategy's constraints.

**Impact:**
- A `single_sided_reseed` strategy could result in dual-sided spot deployment if LLM hallucinates
- Strategy intent is not guaranteed to be executed
- User has false confidence that "active strategy" controls behavior

**Example:**
```typescript
// screening.ts:150-152 — strategy is just text in prompt
const strategyBlock = activeStrategy
  ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy}...`
  : `No active strategy — use default bid_ask...`;

// LLM could output: deploy_position(strategy: "spot", amount_x: 100, amount_y: 100)
// Even though active strategy requires: single_side: "token", amount_y: 0
```

---

### Problem 2: Strategy Exit Criteria Are Completely Ignored

**What:** Strategies define `exit.take_profit_pct` and exit notes, but the exit-rules system uses hardcoded `config.management.takeProfitFeePct` instead.

**Impact:**
- `partial_harvest` strategy's "withdraw 50% at 10% return" is never executed
- `single_sided_reseed` strategy's "redeploy when OOR downside" is never executed
- All positions exit based on generic thresholds, not strategy intent

**Example:**
```typescript
// exit-rules.ts:98-99 — hardcoded config, ignores strategy
if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= mgmtConfig.takeProfitFeePct!) {
  return { action: "CLOSE", rule: 2, reason: "take profit" };
}

// partial_harvest strategy defines:
// exit: { take_profit_pct: 10, notes: "withdraw_liquidity(bps=5000) at 10% return" }
// But this is never read or executed
```

---

### Problem 3: Range Selection Formula Ignores Strategy Configuration

**What:** The `range.bins_below_pct` field in strategies is never read. Instead, screening.ts hardcodes a volatility-based formula.

**Impact:**
- A strategy requesting 100% bins_below (single_sided_reseed) gets ignored
- Range is determined by formula, not by strategy intent
- Custom ratio spot's proportional range cannot be enforced

**Example:**
```typescript
// screening.ts:351 — hardcoded formula
bins_below = round(35 + (volatility/5)*55) clamped to [35,90]

// single_sided_reseed strategy defines:
// range: { bins_below_pct: 100, notes: "All bins below active bin. bins_above=0." }
// This is never used — formula overrides it
```

---

### Problem 4: No Per-Strategy Position Sizing

**What:** All strategies use the same `computeDeployAmount()` based on wallet balance. No strategy can request larger or smaller sizing.

**Impact:**
- "High conviction" strategy cannot deploy more capital
- "Conservative" strategy cannot deploy less capital
- Sizing is purely wallet-driven, not strategy-driven

**Example:**
```typescript
// config.ts:250-259 — same formula for all strategies
export function computeDeployAmount(walletSol: number): number {
  const reserve = config.management.gasReserve ?? 0.2;
  const pct = config.management.positionSizePct ?? 0.35;
  const floor = config.management.deployAmountSol;
  const ceil = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic = deployable * pct;
  return Math.min(ceil, Math.max(floor, dynamic));
}

// No parameter for strategy-based sizing adjustment
```

---

### Problem 5: Management Cycle Has No Strategy Context

**What:** When managing positions, the system only stores the strategy name (string), not the strategy object. The management prompt receives no strategy guidance.

**Impact:**
- Management cannot honor per-strategy exit logic
- `single_sided_reseed`'s "reseed when OOR downside" cannot be executed
- `fee_compounding`'s auto-compounding cannot be triggered
- All positions managed with generic rules

**Example:**
```typescript
// state.ts:19 — only strategy name stored
export interface TrackedPosition {
  strategy: string;  // Just "single_sided_reseed", not the full config
  // ...
}

// management.ts:307-321 — prompt has no strategy context
// Exit rules are generic, not strategy-aware
```

---

### Problem 6: "Mixed" and "Any" Strategy Types Have No Implementation

**What:** The DLMM SDK only supports spot/bid_ask/curve, but strategies can specify "any" or "mixed". The `multi_layer` strategy describes layering shapes but has zero implementation.

**Impact:**
- `multi_layer` strategy is documentation-only — cannot actually layer shapes
- `fee_compounding` with "any" lp_strategy has no special handling
- User expects sophisticated strategies that don't actually exist

**Example:**
```typescript
// dlmm.ts:265-269 — SDK only supports 3 types
const strategyMap: Record<string, StrategyType> = {
  spot: StrategyType.Spot,
  curve: StrategyType.Curve,
  bid_ask: StrategyType.BidAsk,
};

// multi_layer strategy describes:
// "Deploy Bid-Ask → add-liquidity Spot → add-iquidity Curve"
// But no code exists to execute this sequence
```

---

### Problem 7: Fee Compounding Strategy Is Documentation-Only

**What:** The `fee_compounding` strategy describes auto-compounding unclaimed fees, but no code implements this.

**Impact:**
- Strategy promises compounding behavior that never happens
- Management cycle uses generic $5 threshold, not strategy intent
- User expects automated yield optimization that doesn't exist

**Example:**
```typescript
// strategy-library.ts:150-166 — fee_compounding description
exit: {
  notes: "When unclaimed fees > $5 AND in range: claim_fees → add_liquidity back into same position"
}

// exit-rules.ts:131-133 — generic threshold, not strategy-aware
if (unclaimedFeesUsd >= (mgmtConfig.minClaimAmount ?? 5)) {
  return { action: "CLAIM", rule: 4, reason: `claim fees ($${unclaimedFeesUsd.toFixed(2)})` };
}
```

---

### Problem 8: No Strategy Validation on Deploy

**What:** The `deploy_position` tool accepts a `strategy` parameter but only uses it to map to SDK StrategyType. It doesn't validate against the active strategy's criteria.

**Impact:**
- Deploy can violate active strategy constraints
- No check if token meets strategy's `token_criteria`
- No check if entry matches strategy's `entry` rules

**Example:**
```typescript
// middleware.ts:331-407 — safety checks
// Validates: bin_step range, duplicate pools, min/max amounts, SOL balance
// Does NOT validate: single_side requirement, token criteria, strategy match

// User has active strategy: single_sided_reseed (requires single_side: "token")
// LLM calls: deploy_position(strategy: "bid_ask", amount_x: 50, amount_y: 50)
// This passes all safety checks but violates strategy intent
```

---

### Problem 9: Strategy Changes Don't Affect Existing Positions

**What:** If a user switches from `custom_ratio_spot` to `single_sided_reseed`, existing positions continue using generic management rules.

**Impact:**
- No concept of "strategy-bound positions"
- Position opened with strategy X is not managed according to strategy X
- Strategy switch only affects future deploys (and even then, weakly)

**Example:**
```typescript
// Position opened yesterday with custom_ratio_spot
// User switches active strategy to single_sided_reseed today
// Today's management cycle has no memory that yesterday's position was custom_ratio_spot
// It applies generic rules, not custom_ratio_spot exit logic
```

---

### Problem 10: No Strategy-Aware Rebalancing

**What:** The `single_sided_reseed` strategy describes redeploying "token-only bid-ask at new lower price" when OOR downside, but management treats all OOR positions the same.

**Impact:**
- Strategy-specific rebalancing logic cannot be executed
- `single_sided_reseed`'s DCA-out-via-LP mechanism is broken
- All OOR positions get generic close or wait behavior

**Example:**
```typescript
// exit-rules.ts:112-119 — generic OOR handling
if (binsFromActive >= mgmtConfig.outOfRangeBinsToClose!) {
  if (oorMinutes >= mgmtConfig.outOfRangeWaitMinutes!) {
    return { action: "CLOSE", rule: 3, reason: `out of range ${binsFromActive} bins for ${oorMinutes}m` };
  }
}

// single_sided_reseed strategy expects:
// "When OOR downside: close_position(skip_swap=true) → redeploy token-only bid-ask at new lower price"
// This logic does not exist in the codebase
```

---

## Classification Summary

| Category | Count | Problems |
|----------|-------|----------|
| **Architectural** | 3 | #1 (prompt-only enforcement), #5 (no strategy context in mgmt), #9 (strategy changes don't affect existing) |
| **Risk** | 2 | #4 (no per-strategy sizing), #8 (no validation on deploy) |
| **Execution** | 5 | #2 (exit criteria ignored), #3 (range selection ignores config), #6 (mixed/any unimplemented), #7 (fee compounding unimplemented), #10 (no strategy-aware rebalancing) |

---

## Highest-Priority Fixes

| Priority | Fix | Rationale |
|----------|-----|-----------|
| **P1** | **Enforce strategy at deploy time** | Add validation in `deploy_position` that rejects deployments violating the active strategy's hard constraints (e.g., `single_side: "token"` must have `amount_y=0`). This closes the "LLM can ignore strategy" hole. |
| **P2** | **Implement strategy-specific exit handlers** | Extend `evaluateManagementExitRules` to check the position's stored strategy and apply strategy-specific exit logic. Start with `partial_harvest` (50% withdrawal at TP threshold) and `single_sided_reseed` (redeploy instead of close when OOR downside). |
| **P3** | **Bind strategy config to position state** | Store the full strategy object (not just name) in state.json when deploying. Update management cycle to load this config and use strategy-specific thresholds (e.g., `exit.take_profit_pct` overrides `config.management.takeProfitFeePct`). |

---

## Next Steps

1. Audit each built-in strategy for implementation completeness
2. Create implementation plan for P1, P2, P3
3. Define strategy validation schema
4. Implement strategy enforcement middleware
5. Add strategy-aware exit handlers
6. Update state schema to store full strategy config

---

## Files to Audit

- `src/domain/strategy-library.ts` — Strategy definitions
- `src/cycles/screening.ts` — Strategy injection in screening
- `src/cycles/management.ts` — Strategy context in management
- `src/domain/exit-rules.ts` — Exit logic (needs strategy awareness)
- `tools/dlmm.ts` — Deploy execution (needs strategy validation)
- `tools/middleware.ts` — Safety checks (needs strategy constraints)
- `src/infrastructure/state.ts` — Position tracking (needs full strategy storage)
