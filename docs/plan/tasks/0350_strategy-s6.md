# 0350 — Strategy S6 (post-funding directional, WS-gated entry)

**Phase:** 4 — Strategies
**Depends on:** 0290, 0320
**Spec references:** `07_strategy_6.md` §1–§5 (§6 shadow/canary is tasks 0490/0500); `00_globals.md` §G-D, §3.3 (FIFO attribution), §10.2 (S6 error codes); `12_strategy_runtime_and_intent_lifecycle.md` §5 (S6 sub-machine note)

## Objective
S6's full state machine: signed-any selection with the `preFundingQty < mainQty` sizing guard (re-checked at submission against a fresh price), the tiny opposite-direction PRE_FUNDING market order, the funding-gate-triggered MAIN reversal with a once-only lock, the abort ladder (3 retries, 250/1000/3000 ms backoff, REST `getPositions` ground truth), REST net-qty confirmation after MAIN fill with tracked-fills fallback, TP/SL computed at fill time from the **settled** rate, deadline, and all seven S6 error codes — every path exercisable on the sim.

## Context for the agent
Not a negative-funding strategy (§G-D): all four sign/direction combinations legal; `mainSide` and threshold sign independent. The entry is a sub-machine inside `SUBMITTING_ENTRY`/`MONITORING` (`12` §5). Critical invariants from `07`: `mainEventLock` guarantees MAIN fires exactly once (normative, not advisory — a double-fire is the worst failure); PRE_FUNDING exists only to subscribe the symbol to the private user-data stream; at `T_settle` only PRE_FUNDING is open → it accrues the funding cost on all six venues; conservative default books the full charge to `FUNDING_PRE` (per-venue ledger labeling is audited in canary, 0500). `preFundingVolume` = min feasible qty (max of lot step / min-notional qty), derived, not configurable. tpPct/slPct computed at MAIN fill from settled `|F|`, sized on `exitQty` (net). Error taxonomy (`07` §3): `pre_funding_order_failed` / `pre_funding_order_rejected` / `pre_funding_not_filled` / `funding_event_timeout` / `main_order_failed` / `main_order_rejected` / `close_pre_funding_failed` (orphan risk → ops alert; orphan auto-flatten is the backstop). This task verifies the state machine on the sim; the entry path's *live* validity is exactly what shadow/canary (0490/0500) exists for — do not claim more.

## Scope
- In scope:
  - `src/core/strategies/strategy-6.ts` + entry sub-machine (own FSM via the 0040 engine, composed into the intent machine).
  - Selection per `07` §1 incl. always-on threshold 0, most-extreme-first ordering already in 0130, sizing guard at trigger + re-check at submission.
  - PRE_FUNDING placement, gate arming (0290), MAIN via WS order adapter under `mainEventLock`, abort ladder utility (reusable — mirrors `13` §4 flatten mechanics), REST confirm with fallback warning `strategy6: position fetch failed, falling back to tracked fills`.
  - `sl_tp_deadline_post_funding_event` exit kind: TP/SL from settled rate at fill, SHORT mirroring, deadline, post-exit sweep.
  - Tests: unit — sub-machine transition table incl. every error code (one test per code); sizing-guard boundary (preFundingQty == mainQty → skip); lock property (duplicate gate-open events → exactly one MAIN, property-tested with 0160's duplicate injection). Sim scenarios — happy LONG path; happy SHORT mirror; `funding_event_timeout` (PRE closed at small loss); `pre_funding_not_filled`; MAIN reject → abort ladder flattens PRE; abort ladder exhausted → `close_pre_funding_failed` + ops alert event; REST confirm fails → tracked-fills fallback warning. E2e + golden replay for LONG happy path and timeout-abort path.
- Out of scope: shadow/canary phases (0490/0500), per-venue attribution audit (0500), orphan auto-flatten backstop implementation (0380).

## Implementation notes
This is the largest strategy task — the budget holds because every building block exists: gate (0290), conditional/protective utilities (0330), OCO kind (0320), order manager idempotency (0230). The abort ladder should be written as a generic `closeWithRetries(position, backoffs, groundTruthFetch)` — 0380's `flattenAll` reuses it. Net-position bookkeeping: after MAIN, net = `mainVolume − preFundingVolume` in `mainSide` direction — assert the sim venue agrees at every step.

## Verification (definition of done)
1. `npm run verify` + `npm run test:e2e` — green; scenario names cover all seven error codes (grep test output for each).
2. Lock test: injected duplicate `FundingFeeAccrued` matches → exactly one MAIN order in sim venue history.
3. Timeout scenario: PRE_FUNDING closed reduce-only via the abort ladder; terminal `NO_POSITION (funding_event_timeout)`; sim account flat.
4. Fill-time TP/SL: scenario where settled rate ≠ predicted rate → TP/SL prices derive from settled (asserted numerically).
