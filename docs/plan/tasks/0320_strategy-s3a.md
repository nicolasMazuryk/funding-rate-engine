# 0320 — Strategy S3a + `sl_tp_deadline` exit kind

**Phase:** 4 — Strategies
**Depends on:** 0280
**Spec references:** `04_strategy_3a.md` (all sections); `00_globals.md` §G-S, §9.1 (co-run guard), §3.1 (accrual with opposite sign)

## Objective
S3a: the short side of the funding event — SELL MARKET entry at `T_settle − entryOffsetSeconds`, an immediate OCO pair on fill (BUY STOP-MARKET SL at `P_entry × (1 + stopLossPercent/100)`; BUY LIMIT TP at `P_entry × (1 − |F| × tpVariantAMultiplier/100)`), deadline market close — introducing the reusable `sl_tp_deadline` exit-policy kind that S4.1a/S4.2a extend.

## Context for the agent
Design asymmetry to preserve exactly: the **SL is a fixed percent** (`stopLossPercent`), *not* funding-scaled — the mirror foot-gun of S2's `slMultiplier`; the config layer (0100) already rejects the wrong key per strategy, and this task's tests must confirm it end-to-end. Funding leg is a **cost** (`FUNDING_PNL = −|F|` iff open at `T_settle`, same accrual mechanics, opposite sign). OCO semantics: first fill cancels the sibling; deadline cancels both; gap-through on the stop is real (fills at market, worse than trigger). Not WS-mandatory (REST path acceptable). Co-run guard (loader rejects S3a beside any LONG strategy) was built in 0100/0110 — reference it, don't rebuild.

## Scope
- In scope:
  - `src/core/strategies/strategy-3a.ts` (§G-L-family selection helper reused, direction SHORT).
  - `src/core/intent/exit-policies/sl-tp-deadline.ts`: the generic kind — protective pair placement on fill, OCO cancel-on-sibling-fill, deadline market close with cancel-all, `exit_reason` mapping (`tp_hit` maker / `sl_hit` taker / `deadline` taker). Parameterized by price-computation callbacks so 0330/0340 reuse it with their own geometry.
  - Tests: unit — OCO price arithmetic for shorts (SL above, TP below); sim scenarios — tp path (drop reaches `1.5×|F|`), sl path (spike up, gap-through fill worse than trigger asserted), deadline path (chop), pre-settlement SL fill → `funding_received = false` with zero funding cost (`04` §4 edge), sibling-cancel race (TP fills while SL cancel in flight → venue truth resolves); e2e + golden replay.
  - Config e2e: enabling `strategy_3a` alongside a LONG strategy in one instance config → startup rejection (exercise the 0100 guard at composition level).
- Out of scope: ladder/limit entries (0330/0340), analytics distributions (0410).

## Implementation notes
Build `sl-tp-deadline` for three consumers from day one: S3a (fixed SL, funding-scaled TP, short), S4.1a (funding-scaled SL anchored to `P_avg_full`, re-placed TP, long), S4.2a (funding-scaled SL vs limit price, long) — the kind owns lifecycle (place pair → race → cancel siblings → deadline), the strategy owns price geometry. Stop orders on the sim must support trigger-then-market-fill with scripted slippage (extend 0160's sim if the stop semantics are incomplete).

## Verification (definition of done)
1. `npm run verify` + `npm run test:e2e` — green with all listed scenarios.
2. OCO invariant test: in every scenario, at most one of TP/SL ever fills, and the sibling's terminal order state is `CANCELLED` (or venue-truth-resolved), never both filled.
3. Deadline scenario: both protective orders cancelled, position closed reduce-only, `exit_reason = deadline`.
4. Co-run guard: composition-level test rejects the S3a+LONG config with the exact loader error.
