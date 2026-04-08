# P2A Implementation Plan: Core Functions

**Phase:** P2A (Core Infrastructure)  
**Scope:** Implement `addLiquidity()` and `withdrawLiquidity()` in `tools/dlmm.ts`  
**Estimated Effort:** 3-5 days  
**Dependencies:** None (can be done in parallel with P2B)  
**Blocked Strategies:** `multi_layer`, `partial_harvest`, `fee_compounding`, `single_sided_reseed`

---

## Executive Summary

This plan implements the two missing core functions that block 4 out of 5 strategies:

1. **`addLiquidity()`** — Add liquidity to existing position (needed for `multi_layer`, `fee_compounding`)
2. **`withdrawLiquidity()`** — Remove partial liquidity from position (needed for `partial_harvest`, `single_sided_reseed`)

Once implemented, these strategies can move from "documentation-only" to "functional".

---

## 1. Function: `addLiquidity()`

### Purpose
Add liquidity to an **existing** DLMM position. Used for:
- `multi_layer` strategy: Layer additional shapes onto existing position
- `fee_compounding` strategy: Reinvest claimed fees as liquidity
- Manual position top-ups

### SDK Reference
Meteora DLMM SDK provides:
```typescript
pool.addLiquidityByStrategy({
  positionPubKey: PublicKey,
  user: PublicKey,
  totalXAmount: BN,
  totalYAmount: BN,
  strategy: { minBinId, maxBinId, strategyType },
  slippage: number,
}): Promise<Transaction>
```

### Implementation

#### File: `tools/dlmm.ts`

```typescript
/**
 * Add liquidity to an existing position.
 * Used by multi_layer and fee_compounding strategies.
 */
export async function addLiquidity({
  position_address,
  pool_address,
  amount_x,
  amount_y,
  strategy = "spot",
  single_sided_x = false,
}: AddLiquidityParams): Promise<AddLiquidityResult> {
  // Implementation details below
}
```

#### Types to Add (`src/types/dlmm.d.ts`)

```typescript
export interface AddLiquidityParams {
  position_address: string;
  pool_address: string;
  amount_x?: number;
  amount_y?: number;
  strategy?: string;
  single_sided_x?: boolean;
}

export interface AddLiquidityResult {
  success: boolean;
  position?: string;
  pool?: string;
  amount_x?: number;
  amount_y?: number;
  txs?: string[];
  error?: string;
}
```

### Implementation Steps

#### Step 1.1: Parameter Validation (30 min)
- [ ] Validate `position_address` is valid Solana address
- [ ] Validate `pool_address` is valid Solana address
- [ ] Validate at least one of `amount_x` or `amount_y` is > 0
- [ ] Check position exists (call `getMyPositions()` and filter)
- [ ] Check pool matches position's pool

#### Step 1.2: Load Position State (30 min)
- [ ] Get position from DLMM SDK using `pool.getPosition(positionPubKey)`
- [ ] Extract current bin range (`minBinId`, `maxBinId`)
- [ ] Verify position is still valid/open

#### Step 1.3: Calculate Amounts (1 hour)
- [ ] Convert `amount_x` to lamports (token X decimals)
- [ ] Convert `amount_y` to lamports (SOL = 9 decimals)
- [ ] Handle `single_sided_x` flag (amount_y = 0)
- [ ] Get token mints from pool to determine decimals

#### Step 1.4: Execute Add Liquidity (2 hours)
- [ ] Load DLMM SDK pool object
- [ ] Map strategy string to `StrategyType` enum
- [ ] Call `pool.addLiquidityByStrategy()` with:
  - `positionPubKey`: existing position
  - `totalXAmount`: lamports for token X
  - `totalYAmount`: lamports for SOL
  - `strategy`: existing position's bin range + strategy type
  - `slippage`: 10% (1000 bps)
- [ ] Handle transaction signing and confirmation
- [ ] Return transaction hashes

#### Step 1.5: Error Handling (1 hour)
- [ ] Handle "position not found" errors
- [ ] Handle insufficient balance errors
- [ ] Handle slippage exceeded errors
- [ ] Handle position out of range errors (cannot add liquidity OOR)

#### Step 1.6: Tool Registration (30 min)
- [ ] Register tool in `tools/dlmm.ts`
- [ ] Add to `MANAGER_TOOLS` set in `src/agent/tool-sets.ts`
- [ ] Add tool definition in `tools/definitions/management.ts`

### Testing Checklist

- [ ] Test adding liquidity to existing position (happy path)
- [ ] Test adding with only X (single-sided)
- [ ] Test adding with only Y (single-sided)
- [ ] Test adding with both X and Y
- [ ] Test error: position doesn't exist
- [ ] Test error: position is closed
- [ ] Test error: insufficient balance
- [ ] Test error: position out of range

---

## 2. Function: `withdrawLiquidity()`

### Purpose
Remove partial or full liquidity from an existing position. Used for:
- `partial_harvest` strategy: Withdraw 50% at profit threshold
- `single_sided_reseed` strategy: Withdraw all, then redeploy
- Manual position size reduction

### SDK Reference
Meteora DLMM SDK provides:
```typescript
pool.removeLiquidity({
  positionPubKey: PublicKey,
  user: PublicKey,
  bps: number, // Basis points (10000 = 100%)
}): Promise<Transaction | Transaction[]>
```

### Implementation

#### File: `tools/dlmm.ts`

```typescript
/**
 * Withdraw liquidity from an existing position.
 * Used by partial_harvest and single_sided_reseed strategies.
 */
export async function withdrawLiquidity({
  position_address,
  pool_address,
  bps = 10000, // Default: withdraw 100%
  claim_fees = true,
}: WithdrawLiquidityParams): Promise<WithdrawLiquidityResult> {
  // Implementation details below
}
```

#### Types to Add (`src/types/dlmm.d.ts`)

```typescript
export interface WithdrawLiquidityParams {
  position_address: string;
  pool_address: string;
  bps?: number; // Basis points (100 = 1%, 10000 = 100%)
  claim_fees?: boolean;
}

export interface WithdrawLiquidityResult {
  success: boolean;
  position?: string;
  pool?: string;
  bps?: number;
  amount_x_withdrawn?: number;
  amount_y_withdrawn?: number;
  fees_claimed?: number;
  txs?: string[];
  error?: string;
}
```

### Implementation Steps

#### Step 2.1: Parameter Validation (30 min)
- [ ] Validate `position_address` is valid Solana address
- [ ] Validate `pool_address` is valid Solana address
- [ ] Validate `bps` is between 1 and 10000
- [ ] Check position exists and is open
- [ ] Check pool matches position's pool

#### Step 2.2: Optional Fee Claim (30 min)
- [ ] If `claim_fees = true`, call `claimFees()` first
- [ ] Track claimed fee amounts for return value

#### Step 2.3: Execute Withdrawal (2 hours)
- [ ] Load DLMM SDK pool object
- [ ] Get position to determine current liquidity amounts
- [ ] Call `pool.removeLiquidity()` with:
  - `positionPubKey`: existing position
  - `user`: wallet public key
  - `bps`: basis points to withdraw
- [ ] Handle transaction signing and confirmation
- [ ] Calculate withdrawn amounts from pre/post balances

#### Step 2.4: Calculate Withdrawn Amounts (1 hour)
- [ ] Get token balances before withdrawal
- [ ] Get token balances after withdrawal
- [ ] Calculate difference = withdrawn amount
- [ ] Convert from lamports to human-readable units
- [ ] Return in result object

#### Step 2.5: Error Handling (1 hour)
- [ ] Handle "position not found" errors
- [ ] Handle "position already closed" errors
- [ ] Handle "bps exceeds available liquidity" errors
- [ ] Handle transaction failures

#### Step 2.6: Tool Registration (30 min)
- [ ] Register tool in `tools/dlmm.ts`
- [ ] Add to `MANAGER_TOOLS` set in `src/agent/tool-sets.ts`
- [ ] Add tool definition in `tools/definitions/management.ts`

### Testing Checklist

- [ ] Test withdrawing 100% (full close without closing position)
- [ ] Test withdrawing 50% (partial_harvest scenario)
- [ ] Test withdrawing 25% (partial)
- [ ] Test with claim_fees = true
- [ ] Test with claim_fees = false
- [ ] Test error: position doesn't exist
- [ ] Test error: position already closed
- [ ] Test error: bps = 0 (should error)
- [ ] Test error: bps > 10000 (should error)

---

## 3. Integration: Re-enable CLI Commands

Once both functions are implemented, re-enable the CLI commands in `src/cli/cli.ts`:

### Step 3.1: Re-enable `add-liquidity` (15 min)
Replace the disabled version with actual implementation:
```typescript
case "add-liquidity": {
  if (!typedFlags.position) die("Usage: ...");
  if (!typedFlags.pool) die("--pool is required");
  const { addLiquidity } = await import("../../tools/dlmm.js");
  out(await addLiquidity({...}));
  break;
}
```

### Step 3.2: Re-enable `withdraw-liquidity` (15 min)
Replace the disabled version with actual implementation:
```typescript
case "withdraw-liquidity": {
  if (!typedFlags.position) die("Usage: ...");
  if (!typedFlags.pool) die("--pool is required");
  const { withdrawLiquidity } = await import("../../tools/dlmm.js");
  out(await withdrawLiquidity({...}));
  break;
}
```

### Step 3.3: Remove from NON_FUNCTIONAL_STRATEGIES (15 min)
In `src/domain/strategy-library.ts`:
- Remove `"multi_layer"` from set (now functional)
- Remove `"partial_harvest"` from set (now functional)

---

## 4. Implementation Order

### Week 1: Foundation
| Day | Task | Output |
|-----|------|--------|
| 1 | Add types to `src/types/dlmm.d.ts` | Type definitions ready |
| 1 | Implement `addLiquidity()` skeleton | Function signature + validation |
| 2 | Complete `addLiquidity()` implementation | Full function working |
| 2 | Unit tests for `addLiquidity()` | Tests passing |
| 3 | Implement `withdrawLiquidity()` skeleton | Function signature + validation |
| 3 | Complete `withdrawLiquidity()` implementation | Full function working |
| 4 | Unit tests for `withdrawLiquidity()` | Tests passing |
| 4 | Tool registration for both | Tools available to agent |
| 5 | Re-enable CLI commands | CLI functional |
| 5 | Update NON_FUNCTIONAL_STRATEGIES | Warnings removed |

### Week 2: Integration & Testing
| Day | Task | Output |
|-----|------|--------|
| 6 | Integration test: `multi_layer` flow | Deploy + add-liquidity works |
| 7 | Integration test: `fee_compounding` flow | Claim + add-liquidity works |
| 8 | Integration test: `partial_harvest` flow | Withdraw 50% works |
| 9 | Integration test: `single_sided_reseed` flow | Withdraw + redeploy works |
| 10 | Documentation update | All docs reflect new capabilities |

---

## 5. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SDK behavior differs from docs | Medium | High | Test against devnet first |
| Position state sync issues | Medium | Medium | Invalidate cache after operations |
| Transaction size limits | Low | High | Use chunkable methods for large ranges |
| Decimal conversion errors | Medium | High | Add validation + test with small amounts |

---

## 6. Success Criteria

✅ **P2A Complete when:**

1. `addLiquidity()` successfully adds liquidity to existing positions
2. `withdrawLiquidity()` successfully removes partial/full liquidity
3. Both functions have comprehensive error handling
4. CLI commands `add-liquidity` and `withdraw-liquidity` work
5. `multi_layer` and `partial_harvest` strategies can be executed
6. All unit tests pass
7. Integration tests for all 4 blocked strategies pass

---

## 7. Files to Modify

| File | Changes |
|------|---------|
| `src/types/dlmm.d.ts` | Add `AddLiquidityParams`, `AddLiquidityResult`, `WithdrawLiquidityParams`, `WithdrawLiquidityResult` |
| `tools/dlmm.ts` | Implement `addLiquidity()` and `withdrawLiquidity()` functions |
| `src/agent/tool-sets.ts` | Add both tools to `MANAGER_TOOLS` |
| `tools/definitions/management.ts` | Add tool definitions for both |
| `src/cli/cli.ts` | Re-enable CLI commands |
| `src/domain/strategy-library.ts` | Remove strategies from `NON_FUNCTIONAL_STRATEGIES` |

---

## 8. Post-P2A: Strategy Status Update

After P2A completes, update strategy audit docs:

| Strategy | Old Score | New Score | Status |
|----------|-----------|-----------|--------|
| `multi_layer` | 15% | 70% | Functional (manual CLI) |
| `partial_harvest` | 5% | 60% | Functional (manual CLI) |
| `fee_compounding` | 15% | 50% | Needs auto-trigger logic |
| `single_sided_reseed` | 35% | 65% | Needs auto-reseed logic |

---

## Next Phase

After P2A, proceed to **P2B: Strategy Validation Middleware** to enforce strategy constraints at deploy time.
