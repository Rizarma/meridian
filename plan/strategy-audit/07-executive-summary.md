# Strategy System Audit — Executive Summary

**Branch:** `fix/strategy-system-audit`  
**Audit Date:** 2026-04-08  
**Scope:** All 5 Built-in Strategies

---

## Overall System Health: 🚨 **CRITICAL**

| Strategy | Completeness | Status | Primary Issue |
|----------|--------------|--------|---------------|
| `custom_ratio_spot` | 15% | ⚠️ Placeholder | Core ratio logic unimplemented |
| `single_sided_reseed` | 35% | ⚠️ Manual Only | No automatic reseed execution |
| `fee_compounding` | 15% | ⚠️ Broken Promise | Compounding logic missing |
| `multi_layer` | 15% | 🚨 Stub | addLiquidity function doesn't exist |
| `partial_harvest` | 5% | 🚨 Stub | withdrawLiquidity function doesn't exist |

**System Average: 17%** — The strategy library is essentially a documentation system with minimal working implementation.

---

## Critical Findings

### 1. **Two Broken CLI Commands**
- `add-liquidity` (cli.ts:764-786) references non-existent `addLiquidity()` function
- `withdraw-liquidity` (cli.ts:743-762) references non-existent `withdrawLiquidity()` function
- **Impact:** These commands will crash if used

### 2. **Strategy is "Prompt-Only"**
- Active strategy is injected as text into screening prompt
- No code validates that deploy actually follows strategy constraints
- LLM can (and will) ignore strategy requirements

### 3. **Exit Rules Are Strategy-Agnostic**
- All 5 strategies define exit criteria
- Zero strategies have their exit logic implemented
- Management cycle uses generic rules for all positions

### 4. **Missing Core Functions**
| Function | Needed By | Status |
|----------|-----------|--------|
| `addLiquidity()` | multi_layer, fee_compounding | ❌ Missing |
| `withdrawLiquidity()` | partial_harvest, single_sided_reseed | ❌ Missing |
| `calculateRatio()` | custom_ratio_spot | ❌ Missing |
| `executeReseed()` | single_sided_reseed | ❌ Missing |

---

## Strategy-by-Strategy Verdicts

### `custom_ratio_spot` — Placeholder Strategy
**Promise:** Ratio-based directional allocation (75% token = bullish)  
**Reality:** Only the data structure exists. No ratio calculation, no capital splitting, no proportional bins.  
**Verdict:** Strategy works only if LLM manually follows documentation.

### `single_sided_reseed` — Manual Framework
**Promise:** Automatic reseed when OOR downside (DCA out via LP)  
**Reality:** Position tracking exists, but reseed requires manual CLI commands. No automatic execution.  
**Verdict:** An LLM-aware human could execute it; the bot cannot.

### `fee_compounding` — Broken Promise
**Promise:** Auto-compound claimed fees back into position  
**Reality:** Can claim fees, but never compounds them. Auto-swap to SOL exists, but that's the opposite of compounding.  
**Verdict:** The defining behavior is entirely missing.

### `multi_layer` — Broken Stub
**Promise:** Layer multiple shapes into one position  
**Reality:** Documentation exists, but `addLiquidity` function doesn't exist. CLI command is broken.  
**Verdict:** Cannot be executed even manually.

### `partial_harvest` — Empty Stub
**Promise:** Withdraw 50% at 10% return threshold  
**Reality:** Only data structure exists. `withdrawLiquidity` function missing. No trigger logic.  
**Verdict:** Most incomplete strategy. Zero working implementation.

---

## Root Cause Analysis

### Architectural Gap
The strategy system was designed as:
1. **Library** (data structures + documentation) ✅
2. **Execution** (code that implements strategies) ❌

The execution layer was never built. Strategies exist to guide LLM decisions, not to automate behavior.

### Design Philosophy Mismatch
Current design: "LLM reads strategy and decides what to do"  
Required design: "Strategy defines constraints that code enforces"

---

## Recommended Action Plan

### Phase 1: Stop the Bleeding (Immediate)
- [ ] Disable broken CLI commands (`add-liquidity`, `withdraw-liquidity`)
- [ ] Add warning when user activates non-functional strategies
- [ ] Document which strategies actually work

### Phase 2: Core Infrastructure (1-2 weeks)
- [ ] Implement `addLiquidity()` in `tools/dlmm.ts`
- [ ] Implement `withdrawLiquidity()` in `tools/dlmm.ts`
- [ ] Add strategy validation middleware (enforce constraints at deploy)
- [ ] Store full strategy config in position state (not just name)

### Phase 3: Strategy Implementation (2-4 weeks)
- [ ] Implement `custom_ratio_spot` ratio engine
- [ ] Implement `single_sided_reseed` automatic reseed flow
- [ ] Implement `fee_compounding` auto-compound logic
- [ ] Implement `multi_layer` multi-step deployment
- [ ] Implement `partial_harvest` partial withdrawal

### Phase 4: Strategy-Aware Management (2-3 weeks)
- [ ] Refactor exit-rules.ts to check position strategy
- [ ] Add strategy-specific exit handlers
- [ ] Implement per-strategy management prompts

---

## Files Requiring Changes

| File | Changes Needed |
|------|----------------|
| `tools/dlmm.ts` | Add `addLiquidity()`, `withdrawLiquidity()` |
| `tools/middleware.ts` | Add strategy validation at deploy |
| `src/domain/exit-rules.ts` | Add strategy-aware exit logic |
| `src/cycles/management.ts` | Load position strategy config |
| `src/infrastructure/state.ts` | Store full strategy object |
| `src/cli/cli.ts` | Fix or remove broken commands |
| `src/cycles/screening.ts` | Add strategy enforcement |

---

## Success Criteria

The strategy system will be considered "working" when:

1. ✅ All 5 strategies can be deployed automatically
2. ✅ Deploy validates against strategy constraints (rejects violations)
3. ✅ Management cycle applies strategy-specific exit logic
4. ✅ CLI commands for add-liquidity and withdraw-liquidity work
5. ✅ Each strategy's unique behavior is actually executed

---

## Audit Artifacts

- `01-problem-statement.md` — 10 core problems with impact & examples
- `02-audit-custom_ratio_spot.md` — Detailed audit of first strategy
- `03-audit-single_sided_reseed.md` — Detailed audit of second strategy
- `04-audit-fee_compounding.md` — Detailed audit of third strategy
- `05-audit-multi_layer.md` — Detailed audit of fourth strategy
- `06-audit-partial_harvest.md` — Detailed audit of fifth strategy
- `07-executive-summary.md` — This file

---

## Next Steps

1. Review this audit with stakeholders
2. Prioritize Phase 1 fixes (disable broken commands)
3. Create implementation tickets for Phase 2-4
4. Consider simplifying strategy library to only working strategies until execution layer is built
