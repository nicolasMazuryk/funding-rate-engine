# 0330 — Strategy S4.1a (post-funding LONG ladder)

**Phase:** 4 — Strategies
**Depends on:** 0320
**Spec references:** `05_strategy_4_1a.md` (all sections — R11 lifecycle is normative); `00_globals.md` §G-R, §11-R7/R11; `11_execution_and_account_state.md` §3 (ladder feasibility)

## Objective
S4.1a: a pre-placed ladder of buy limits below `P_ref` scaled by `|F|`, filled by the drop, exited on a TP above the fill-weighted average — implementing the R11 lifecycle exactly: SL placed **with the ladder** as an engine-side conditional anchored to `P_avg_full` (precomputed from rung prices/qtys), TP placed on first fill and re-placed on each deeper fill, unfilled rungs cancelled **only at exit/deadline**, and `ladder_no_fills` termination when nothing fills.

## Context for the agent
R11 supersedes the source lifecycle — the task-critical consequences are spelled out in `05` §2 and must hold in tests: (a) the SL anchored to `P_avg_full` is looser early / tighter as the ladder fills — deterministic; (b) rungs stay open until exit, so a late dip can add exposure after the TP rests — the per-fill TP re-place keeps exit qty correct; (c) a rung filling while the exit is in flight is closed by a protective reduce-only market close (cancel/fill race). The engine-side conditional SL is **engine-tracked, not a venue resting order, until a position exists**; on trigger it market-closes whatever qty is currently filled. Funding: usually 0, but a pre-settlement rung fill accrues real exchange-sourced funding (R7) — logged `ladder.pre_funding_fill` + ops event, position kept, amount read from the venue (0240 funding tracker), never derived from `|F|`. Ladder construction math (rung prices, largest-remainder split, sub-min-notional drops, top-rung feasibility skip) exists in 0120 — consume it.

## Scope
- In scope:
  - `src/core/strategies/strategy-4-1a.ts`: selection (§G-R family via shared helper) + feasibility gate (top rung vs `minCost` → skip symbol), ladder geometry (`ladder_top/bottom = P_ref × (1 − |F| × mult/100)`, linear interpolation across `ladderCount`).
  - Engine-side conditional stop utility (trigger watch on `MarketTick`, reduce-only market close of filled qty) — reusable by 0340.
  - `sl_tp_deadline` kind extension for ladders: `P_avg` recompute per fill, TP cancel/re-place per fill (qty = filled qty), SL price static at `P_avg_full`, unfilled-rung cancellation only at exit, `ladder_no_fills` on deadline with zero fills.
  - Submission stagger honored across rung placement (0230).
  - Tests: unit — geometry + `P_avg_full` precompute vs `05` §2 formulas; sim scenarios — all-rungs-fill then tp_hit; partial fills (2 of 5) then sl trigger closes exactly filled qty; zero fills → `ladder_no_fills` (no position, no exit_reason); pre-settlement rung fill → kept + `ladder.pre_funding_fill` logged + actual accrual booked from sim venue; late-dip fill after TP resting → TP re-placed with new qty; cancel/fill race → protective close; e2e + golden replay for the partial-fill path.
- Out of scope: single-limit variant (0340), fill-count analytics (0410).

## Implementation notes
The conditional-stop utility is the subtle piece: it must arm immediately (protection exists from placement time — R11's point), watch ticks, and on trigger act on *current* filled qty. Test the trigger-before-any-fill case: nothing to close, ladder must still cancel per lifecycle. Rung order state: N concurrent order FSMs under one intent — the intent stays `SUBMITTING_ENTRY`/`MONITORING` per `12` §5 (ladders manage N rung orders); pick the transition point (first fill → `MONITORING`) and assert it.

## Verification (definition of done)
1. `npm run verify` + `npm run test:e2e` — green with every listed scenario.
2. R11 invariants asserted in scenarios: SL exists from placement instant (trace-ordered before first possible fill); unfilled rungs are open until the exit fires and cancelled after; TP qty always equals filled qty at rest.
3. `ladder_no_fills` scenario: terminal `NO_POSITION`, all rungs `CANCELLED`/`EXPIRED`, zero fees recorded.
4. Largest-remainder + drop behavior: a config where one rung falls below min-notional goes out with `ladderCount − 1` rungs (trace-checked).
