# 0400 — Reconciliation (system ↔ exchange)

**Phase:** 5 — Sidecars full
**Depends on:** 0240, 0390
**Spec references:** `15_accounting_and_reconciliation.md` §2 (reconciliation), §6 (scope); `13_risk_and_failure_modes.md` §5 (desync); `14_persistence_and_recovery.md` §3 (`reconciliation` table)

## Objective
The drift-catcher: on intent close and on a periodic sweep, compare the engine's persisted record against venue ground truth across the four dimensions (fills via `getOrder`/trade history; positions via `getPositions`; funding via `fundingHistory`; balances via `getBalance`), write diffs to the `reconciliation` table, correct booked values with **venue wins for money**, re-run the affected trade-record assembly, and alert when a diff exceeds tolerance.

## Context for the agent
The system assumes the venue is lying until reconciled (spec 0000) — but for money, venue truth is final (`15` §2): the engine's values are corrected to match and the diff is recorded for audit; beyond-tolerance diffs mean a bug or missed event → alert. Position mismatches route to the orphan/desync machinery (0380), not to silent correction. This closes the two-sided uncertainties the strategy specs flag: S1-WS ±5 s matching, S6 funding attribution (full audit in 0500). Reconciliation is read-and-record — no order placement (`15` §6); corrections either self-resolve as booking adjustments or escalate to risk.

## Scope
- In scope:
  - `src/accounting/reconcile.ts`: per-dimension comparators with tolerances (config: `risk`/accounting section — define keys, conservative defaults), diff records `{dimension, engineValue, venueValue, resolution, ts}` into `reconciliation` (0360), booking corrections + trade-record re-assembly via 0390's pure assemblers, alert emission (ops event in the trace/log).
  - Scheduling: on-close hook + periodic sweep timer (clock-driven, config interval).
  - Rate-limit citizenship: all venue reads through the 0200 general lane.
  - The 0090-era reconciliation stub replaced/deleted.
  - Tests: sim scenarios — scripted fill-fee divergence (sim venue reports a different fee than the engine booked) → corrected record + diff row + no alert (inside tolerance); scripted large price divergence → alert; missed funding event (engine has none, `fundingHistory` shows one) → funding booked, record re-assembled; position mismatch → routes to orphan/desync path (0380 event), no direct correction.
- Out of scope: analytics over reconciliation data (0410), S6 canary attribution audit (0500), live-venue reconciliation drills (0480 exercises this against real Binance).

## Implementation notes
Comparator inputs must be venue-normalized first (symbols, base units via 0120) — comparing venue-denominated to internal values is the classic false-diff generator. Idempotency: re-running reconciliation over an already-corrected intent produces no new diff rows (the engine value now matches venue) — test it.

## Verification (definition of done)
1. `npm run verify` + `npm run test:e2e` — green with the four dimension scenarios.
2. Fee-divergence scenario: `pnl` row reflects venue fee; `reconciliation` row records the diff and resolution; second reconcile run adds zero rows.
3. Missed-funding scenario: `funding_pnl` corrected from `fundingHistory`; `funding_received` flag re-derived.
4. Beyond-tolerance scenario emits the alert event (trace-asserted); position-mismatch scenario emits the desync event and writes no correction.
