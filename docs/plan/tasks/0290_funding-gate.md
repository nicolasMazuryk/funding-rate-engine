# 0290 — Funding gate: WS event + REST poll safety net

**Phase:** 4 — Strategies
**Depends on:** 0270
**Spec references:** `00_globals.md` §6 (REST funding-fee poll, matching tolerance), §1.1 (T_drop); `11_execution_and_account_state.md` §7 (FundingFeeAccrued), §9; `02_strategy_1_ws.md` §2 (gate mechanics); ROADMAP assumption A1

## Objective
The shared funding-gate mechanism used by every WS-gated strategy (S1-WS, S2, S6): per-intent arming that opens on a matched `FundingFeeAccrued` event (`fundingTime` within ±5 s of expected `T_settle`), with the REST funding-fee poll safety net firing at `T_settle + 3 s` with an 8 s grace period, timeout signaling at `T_settle + fundingFeeTimeoutSeconds`, and `t_drop_offset_s` observation recorded for analytics.

## Context for the agent
One event, two observables (`00_globals` §1.1): the WS `funding_fee` event marks `T_drop`. Gate semantics: opens on **either** the matched WS event or the REST poll observing the credit — whichever first; opening is once-only; a gate that never opens fires the timeout signal (each strategy decides what timeout means: S1-WS exits `funding_fee_timeout`, S6 aborts `funding_event_timeout`). Matching tolerance ±5 s per ROADMAP A1 — note the `11` §7 ±30 s discrepancy in a code comment at the constant. The known failure mode (`02` §3): a mismatched event of the wrong cycle inside tolerance opens the gate early — tolerance stays deliberately tight; add a scenario for it. Observability events: `intent.funding_gate_opened` / `intent.funding_gate_closed` in the trace.

## Scope
- In scope:
  - `src/core/runtime/funding-gate.ts`: pure gate logic (arm(intent, T_settle, timeout) → consumes `FundingFeeAccrued` + `Timer` events → emits gate-opened/timeout signals); once-only invariant.
  - REST poll scheduling: at `T_settle + 3 s`, poll the adapter's funding-fee/income source with the 8 s grace, through the rate limiter's general lane; poll result feeds the same gate.
  - `t_drop_offset_s` computed from the observed event (`null` if never observed) and recorded on the intent (`00_globals` §8.3).
  - Sim faults exercised: late funding fee (gate opens late), absent (timeout), duplicate (once-only holds), wrong-cycle `fundingTime` outside tolerance (no open) and the tight-tolerance mismatch case documented in a scenario.
  - Trace events `intent.funding_gate_opened`/`closed`.
- Out of scope: strategy-specific reactions to gate/timeout (0300/0310/0350), the private-stream event production itself (0220 done), settled-rate accounting (0390).

## Implementation notes
Keep the gate a pure event-consumer (core) with the REST poll as an injected port call scheduled via the clock — testable entirely on the sim. The gate must be re-armable from persisted state on recovery (S2 restart case, 0370) — expose serialize/restore of armed-gate state now.

## Verification (definition of done)
1. `npm run verify` — green.
2. Scenario tests: WS event at `T_settle + 4 s` → gate opens, `t_drop_offset_s = 4`; no WS event but REST poll sees the credit at `T_settle + 3 s` → gate opens with source `rest`; neither → timeout signal exactly at `T_settle + timeout` on the virtual clock; duplicate events → exactly one open; `fundingTime` off by 6 s → no match.
3. Trace contains `intent.funding_gate_opened` with source and offset fields (golden-checked in one scenario).
