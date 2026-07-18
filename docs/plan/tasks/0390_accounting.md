# 0390 — Post-trade accounting

**Phase:** 5 — Sidecars full
**Depends on:** 0310, 0340, 0350, 0360
**Spec references:** `15_accounting_and_reconciliation.md` §1 (post-trade accounting), §3 (P&L attribution); `00_globals.md` §1.1, §3.1, §8.3; strategy files `01`–`07` §4 (decompositions)

## Objective
The accounting sidecar: on every intent close, assemble the trade record from **realized fills** and the **settled** funding amount — never assumptions — producing the per-strategy P&L decomposition (`delta_pnl`, `funding_pnl`, `fee_cost`, `net_pnl` and the full `00_globals` §8.3 field set) into the `pnl` table, with the `funding_received` flag reflecting the fill-time accrual test and S6's conservative `FUNDING_PRE` attribution.

## Context for the agent
Formulas come from each strategy file's §4 — referenced, not re-derived: Group L longs `+|F|` iff accrued; S3a shorts `−|F|`; S4.x funding = actual exchange-sourced accrual (usually 0; real on pre-settlement fills — §G-R/R7: read from `funding_events`, never derived from `|F|`, never hardcoded either way); S6 = `MAIN_DELTA + PRE_FUNDING_DELTA + FUNDING_PRE − FEES` with the charge booked to `FUNDING_PRE` (conservative default, flagged for canary audit). Fees: Σ per actual fill by the fee class of the order type that filled (maker/taker from the profile) — slippage and fees are whatever actually filled. `P_avg` fill-weighted for ladders; `hold_duration_s`, `fill_count`, `t_drop_offset_s` (from 0290) complete the record. Accounting is a sidecar (`15` §6): reads persisted facts, writes records, places no orders.

## Scope
- In scope:
  - `src/accounting/trade-record.ts`: per-strategy decomposition assemblers keyed by strategy id (registry, no branching sprawl), consuming `fills`, `funding_events`, intent data from repos (0360).
  - Close-hook wiring: intent → `CLOSED`/`NO_POSITION` triggers record assembly (async, off the hot path); `NO_POSITION` intents get records with `error_code`, zero fills, zero fees (e.g. `limit_expired`).
  - `funding_received` derivation from actual entry-fill timestamp vs `T_settle` (§3.1).
  - Tests: unit per strategy family with hand-computed expected values (reuse the strategy files' §4 worked examples); sim e2e — every strategy's happy-path scenario now also asserts its `pnl` row numerically; the S2 pre-settle SL fill and S4.1a pre-settlement rung fill scenarios assert funding booked from the venue-reported amount (scripted in sim), not `|F|`.
- Out of scope: reconciliation vs venue (0400 — this task books from the engine's persisted facts; 0400 corrects them), analytics aggregation (0410).

## Implementation notes
Percent-unit discipline (`00_globals` §1.2) throughout; property test: recomputing `net_pnl` from its stored components is identity. The decomposition assemblers should be pure functions over a `TradeFacts` snapshot — reconciliation (0400) will re-run them after corrections, so purity here saves 0400 from duplicate logic.

## Verification (definition of done)
1. `npm run verify` + `npm run test:e2e` — green; every strategy happy-path e2e asserts its `pnl` row against hand-computed values from the spec's §4 examples.
2. S4.1a pre-settlement-fill scenario: `funding_pnl` equals the sim's scripted venue accrual (a value deliberately ≠ `|F|`), proving exchange-sourced booking.
3. S6 record: `FUNDING_PRE` carries the full charge; components sum to `net_pnl` (property test).
4. `limit_expired` record: `net_pnl = 0`, `fee_cost = 0`, `error_code` set.
