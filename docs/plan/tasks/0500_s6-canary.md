# 0500 — S6 canary-phase tooling + acceptance gates

**Phase:** 7 — Live tier
**Depends on:** 0470, 0490
**Spec references:** `07_strategy_6.md` §6.2 (canary phase, acceptance metrics a–e), §2 (attribution table to fill), §6.3 (calibration set); `17_testing.md` §5

## Objective
The canary machinery: S6 running live at minimum sizing through the 0470 capped harness, one symbol cohort per venue, with the five pre-registered acceptance metrics from `07` §6.2 encoded as machine-checkable gates over the accumulated trade data: (a) `funding_event_timeout` rate ≤ 2× the shadow-phase miss estimate; (b) MAIN slippage p90 within expected range; (c) realized PRE overhead in bp of net notional; (d) per-venue funding-attribution audit against income statements (filling the `07` §2 table); (e) zero `close_pre_funding_failed` — else halt.

## Context for the agent
Thresholds are **pre-registered before scale-up** — the gate config file states each threshold with its shadow-baseline input (0490's report) and is committed before live canary runs begin; the checker refuses to evaluate against thresholds modified after data collection started (store a hash). Metric (d) fills the `07` §2 attribution table: for each venue, compare the engine's conservative `FUNDING_PRE` booking against the venue's income/ledger records (via `fundingHistory`/income endpoints through reconciliation data, 0400) and record the confirmed labeling; the audit's output updates the booking rule only via a recorded decision. Metric (e) is a halt condition: the checker's verdict escalates to the kill switch (`paused`) recommendation. Per ROADMAP A9: tooling + gates + a bounded live smoke here; the ≥ 4-week accumulation is operational. Every S6 trade already logs the full event timeline (`07` §6.3 — built in 0350/0490); the canary dataset is the future calibration set.

## Scope
- In scope:
  - Canary run configuration: S6 live-profile at min `mainAmountUsd`, one-symbol cohort selection per venue, through the 0470 harness (caps apply; harness extended if needed for a long-running mode with per-settlement teardown checks rather than end-of-run flatten — positions are short-lived by strategy design).
  - `scripts/canary-check.ts` (`npm run canary:check`): evaluates gates (a)–(e) over accumulated `pnl`/trace/reconciliation data (queries via 0410's metric functions), against the pre-registered threshold file; JSON verdict per gate + overall; halt recommendation wiring for (e).
  - Attribution-audit tooling for (d): per-venue comparison report + a documented place to record the confirmed labeling (updating the `07` §2 table in a repo doc, e.g. `docs/s6-attribution.md`).
  - Sim-mode tests: seeded datasets engineered to pass/fail each gate flip the verdicts; threshold-tamper detection test.
  - Env-gated live smoke: one canary settlement on Binance at min size through the harness — machinery proof, not statistics.
- Out of scope: the multi-week canary operation and the scale-up decision (ops, informed by these verdicts), booking-rule changes from the audit (recorded decision, future config change).

## Implementation notes
Gate (b)'s "expected range" needs a defensible definition: derive from shadow-phase would-be timestamps + contemporaneous tick data where available, else pre-register an absolute bp bound with rationale in the threshold file. Keep every gate a pure function `(dataset, thresholds) → verdict` — trivially testable, auditable.

## Verification (definition of done)
1. `npm run verify` — green; seeded-dataset tests flip every gate both ways; tamper test: modified thresholds post-registration → checker refuses.
2. `npm run canary:check --json` over seed data emits verdicts for all five gates with evidence fields.
3. Env-gated live smoke: one real S6 canary intent on Binance completes through the harness (any terminal outcome), appears in the dataset, and `canary:check` ingests it; account flat; without keys, clean skip.
4. `docs/s6-attribution.md` exists with the six-venue table scaffold and audit instructions.
