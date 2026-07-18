# 0410 — Trade analytics + fleet rollup

**Phase:** 5 — Sidecars full
**Depends on:** 0400
**Spec references:** `15_accounting_and_reconciliation.md` §4 (trade analytics), §5 (fleet-level rollup); `00_globals.md` §8.3, §2.3 (recovery regimes); strategy files' §4/§6 monitoring requirements

## Objective
The report layer the strategy specs demand: queries/aggregations over reconciled trades producing every metric in the `15` §4 table — path mix, `NET_PNL` by `t_drop_offset_s` bucket, realized `|DELTA_PNL|/|F|` distribution (S1-WS kill-criterion), S2 deadline-exit frequency, S4.x fill-count histograms and `limit_expired`/`ladder_no_fills` rates, drop-depth ÷ `|F|` distribution, S6 PRE-overhead/timeout/slippage metrics — plus the fleet rollup as read-only SQL over the shared DB grouped by instance.

## Context for the agent
Each strategy file binds live-monitoring requirements to its economics (e.g. `02` §4: a median `|DELTA_PNL|/|F|` ≥ `(|F| − fees)/|F|` kills the strategy at that threshold; `03` §3: deadline-exit frequency must be monitored; `07` §6: canary acceptance metrics). This task builds the *computation and output*, not dashboards: a CLI (`npm run analytics -- --strategy s2 --from …`) emitting structured JSON + readable tables, over the canonical `pnl`/`fills`/`funding_events`/`reconciliation` schema. The S6 metrics here are the same ones 0500's canary checks consume — build them as reusable query functions.

## Scope
- In scope:
  - `src/accounting/analytics.ts`: metric functions per the `15` §4 table (each returning typed results), bucketing helpers (`t_drop_offset_s` buckets, recovery-regime classification per `00_globals` §2.3 where derivable from price data captured in the trade record).
  - Kill-criterion evaluators where a spec states one (S1-WS median ratio; S2 path-mix break-even weighting from `03` §4) — output `{metric, threshold, verdict}`.
  - Fleet rollup queries (`15` §5): fleet P&L, per-strategy/per-exchange breakdowns, funding-attribution audit view — read-only, `GROUP BY` over `instance_id` fields.
  - CLI with `--json` output; seeded-fixture tests (insert known `pnl`/`fills` rows → assert every metric numerically).
- Out of scope: dashboards/UI (out of spec), S6 canary gate wiring (0500), live data collection (runs produce it).

## Implementation notes
Analytics reads the DB only — no engine imports beyond shared types. Seed fixtures deliberately include multi-instance rows to prove rollup grouping and isolation. Keep each metric a small tested SQL/TS function; 0500 imports them.

## Verification (definition of done)
1. `npm run verify` + `npm run test:integration` — green; every metric in the `15` §4 table has a test with hand-computed expected output (grep test names against the table).
2. `npm run analytics -- --json` over seeded data emits parseable JSON containing all metric keys.
3. Kill-criterion evaluator test: seeded S1-WS data engineered above/below the threshold flips the verdict.
4. Rollup: seeded two-instance data groups correctly; single-instance query never sees the other instance.
