# 0310 — Strategy S2 + trailing-retracement tracker

**Phase:** 4 — Strategies
**Depends on:** 0300
**Spec references:** `03_strategy_2.md` (all sections); `00_globals.md` §G-L, §2 (drop model, causality), §11-R8; `14_persistence_and_recovery.md` §1 (tracker state survives crash)

## Objective
S2: funding collection with a refusal to realize the drop immediately — WS-mandatory market entry recording `anchorPrice` at decision time, an SL stop-market placed on entry fill at `P_entry × (1 − |F| × slMultiplier/100)`, a funding-gate-armed **trailing retracement tracker** that chases the running low with a re-derived TP limit (`P_target = P_low + (anchorPrice − P_low) × retracementPct`, ≤ 1 re-place/s), and the three-way exit `sl_hit` / `tp_hit` / `deadline` — with tracker state persisted so a restart mid-position resumes trailing.

## Context for the agent
Causality is the binding design rule (R8): the tracker uses only lows observed so far — never the final minimum. Sequence (`03` §2): entry → SL active immediately (deliberate window with SL-only until the gate opens) → gate open arms the tracker → each new low cancels + re-places the TP (throttled) → first of SL/TP/deadline wins, siblings cancelled, post-exit sweep (S2 always produces ≥ 1 post-exit cancel — expected). Price feed: 1 s poll / `MarketTick` events. `retracementPct` is the system's only fraction-unit key; 1.0 (proposed) = TP at anchor → deadline exits will be frequent — the deadline path is a first-class outcome, not an edge case. Tracker state must survive restart (`14` §1): persist armed/anchor/`P_low`/current TP `clientOrderId`; the full recovery-respawn integration is 0370, but serialize/restore + a same-session restore test land here.

## Scope
- In scope:
  - `src/core/strategies/strategy-2.ts` (§G-L selection via shared helper; params incl. `retracementPct`, `slMultiplier`, `deadlineSeconds`, `fundingFeeTimeoutSeconds` as tracker-arming fallback — not an exit).
  - `src/core/intent/exit-policies/retracement.ts` (`sl_tp_deadline_retracement_funding_event` kind): SL placement on fill, gate-armed tracker, throttled TP re-place loop, deadline timer, OCO semantics (first fill cancels siblings).
  - Tracker persistence: state serialized on every material change (via `Repo`/WAL), restorable; deadline-exit-frequency counter surfaced in the trade record path for later analytics.
  - Tests: unit — tracker causality (feed a price path, assert `P_target` never uses a future low; new-low sequence produces monotonically descending TP prices; throttle enforces 1/s on virtual clock); sim scenarios — tp_hit after V-retrace, sl_hit on continued decline (SL fills before gate opens — funding still booked per §3.1 iff entry filled pre-settle), sl fill **before** `T_settle` (drop-a-candle-early case → funding lost, `funding_received=false`), deadline exit on no-recovery path, restart mid-MONITORING restores the tracker and TP; e2e + golden replay for tp path.
- Out of scope: recovery-at-boot wiring (0370), path-mix analytics (0410).

## Implementation notes
TP re-place is cancel-then-place through the order manager — handle the cancel/fill race: a TP that fills while being cancelled resolves by venue truth (`getOrder`), not assumption. Keep the tracker a pure reducer `(state, event) → (state, commands[])` so the causality property tests are trivial and persistence is a state snapshot.

## Verification (definition of done)
1. `npm run verify` + `npm run test:e2e` — green with all listed scenarios.
2. Causality property test passes: for random scripted price paths, every emitted `P_target` is computable from the path prefix (implemented as prefix-replay equality).
3. Restart scenario: kill/restore mid-trailing → next new low re-places TP from the restored `P_low` (not from scratch), asserted via trace.
4. Throttle: a burst of new lows within one virtual second yields exactly one re-place.
