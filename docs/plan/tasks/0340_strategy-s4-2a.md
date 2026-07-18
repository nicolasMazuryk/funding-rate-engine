# 0340 — Strategy S4.2a (post-funding LONG single limit)

**Phase:** 4 — Strategies
**Depends on:** 0330
**Spec references:** `06_strategy_4_2a.md` (all sections); `00_globals.md` §G-R, §11-R5/R11; `11_execution_and_account_state.md` §6 (EXPIRED → limit_expired)

## Objective
S4.2a: the ladder collapsed to one resting BUY LIMIT at `P_ref × (1 − |F| × limitOffsetMult/100)` with `expireAt = T_settle + deadlineSeconds`, the R11-mirrored engine-side conditional SL placed with the entry (`P_SL = P_limit × (1 − |F| × slMultiplier/100)`, guaranteed below the limit by the loader constraint), TP on fill at `P_fill × (1 + takeProfitPct/100)`, and the normative `limit_expired` no-fill terminal path (R5): cancel at expiry, `NO_POSITION`, no fees.

## Context for the agent
Most of the machinery exists: `sl_tp_deadline` kind (0320), conditional-stop utility and race handling (0330), feasibility skip (0120). The deltas: single rung → single `P_entry` (no averaging); the `expireAt` mechanism drives the order FSM's `EXPIRED` state into `error_code = limit_expired`; fill-and-immediate-stop is a real path on deep drop candles (limit fills and SL triggers within the same second — `06` §3) and must be a scenario. A high `limit_expired` rate is expected behavior in shallow-drop events — a cost of zero, not a defect. Loader constraint `slMultiplier > limitOffsetMult` came in 0100; the geometric consequence (`P_SL < P_limit` always) gets an assertion here.

## Scope
- In scope:
  - `src/core/strategies/strategy-4-2a.ts`: selection + single-limit feasibility, limit/SL/TP geometry.
  - `expireAt` support end-to-end: engine-tracked expiry timer → cancel → `EXPIRED` → `limit_expired` (sim + order manager may need the expiry hook if 0160/0230 left it partial).
  - Tests: unit — geometry incl. the `P_SL < P_limit` invariant across valid config space (property test over bounds); sim scenarios — fill-then-tp; fill-then-sl; fill-and-immediate-stop (same-second trigger); no-fill → `limit_expired` with zero fees and no SL/TP side effects; pre-settlement fill → kept, actual accrual booked (§G-R); deadline with open position → market close `deadline`; e2e + golden replay for the `limit_expired` path (it is the distinctive one).
- Out of scope: fill-rate/offset trade-off analytics (0410).

## Implementation notes
Reuse aggressively — this task should be mostly geometry + scenarios; if you are writing new lifecycle machinery, check 0320/0330 first. The conditional SL is armed from placement (protection from the first possible fill instant, `06` §2 reconciliation note); on `limit_expired` the conditional must disarm without ever having touched the venue.

## Verification (definition of done)
1. `npm run verify` + `npm run test:e2e` — green with every listed scenario.
2. `limit_expired` scenario: terminal `NO_POSITION`, `error_code = limit_expired`, fees = 0, no venue orders remain (sim state flat), conditional SL disarmed.
3. Fill-and-immediate-stop scenario: SL close fills reduce-only for the filled qty within the same virtual second; `exit_reason = sl_hit`.
4. Property test: for all valid configs, `P_SL < P_limit`.
