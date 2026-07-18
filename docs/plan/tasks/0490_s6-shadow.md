# 0490 — S6 shadow-phase tooling

**Phase:** 7 — Live tier
**Depends on:** 0260, 0350
**Spec references:** `07_strategy_6.md` §6.1 (shadow phase), §6.3 (event-timeline logging); `17_testing.md` §5 (S6 shadow → canary verification)

## Objective
The shadow mode that runs S6's full state machine live with **order submission stubbed at the adapter (log-only)**: real venue streams, real selection at the configured threshold, real would-be decision timestamps — measuring per-venue event arrival rate, `T_event − T_settle` latency distribution, and selection frequency. Plus the report script that turns accumulated shadow logs into the metrics the canary acceptance gates (0500) need as their baseline.

## Context for the agent
S6's entry cannot be validated by replay: MAIN is causally gated on a private, account-level WS event that only fires because the PRE_FUNDING position exists (`07` §6). Shadow phase is the first live rung: no orders at all — but note the structural subtlety: with **no** PRE_FUNDING position, some venues may not emit the funding-fee event on the private stream at all. The shadow harness must therefore record *both* the private-stream behavior as-is *and* the REST funding-fee/income observations (0290's poll path) as the event-arrival proxy, and report them separately — this measurement-design caveat is exactly the kind of venue truth the shadow phase exists to surface; document findings per venue. The protocol prescribes ≥ 2 weeks across venues; per ROADMAP assumption A9 this task delivers the tooling, a bounded smoke run, and the report — the multi-week accumulation is operational.

## Scope
- In scope:
  - Shadow mode flag in composition: order-submission stub at the adapter boundary (logs the exact would-be request + timestamp; touches no venue write endpoint), everything else real; refuses to run without the flag being explicit (`SHADOW=1` style) and refuses live submission code paths while set (assert at the cap-wrapper level, reusing 0470's machinery if landed — else a local guard).
  - Event-timeline logging per `07` §6.3: `T_settle`, event receive time(s) (WS and REST-poll), would-be MAIN send time, per intent — into the standard trace + a `shadow_runs` structured log/DB usage of existing tables (keep it simple: trace + analytics query, no new schema unless forced).
  - `scripts/shadow-report.ts` (`npm run shadow:report`): event arrival rate, latency distribution (p50/p90/p99 of `T_event − T_settle`), selection frequency at threshold, per venue — JSON + table output; this is the canary baseline input (0500).
  - Sim-mode test of the whole shadow pipeline (scripted events → report numbers hand-checked); env-gated live smoke: one settlement window on Binance in shadow mode produces a well-formed report.
- Out of scope: canary phase + acceptance gates (0500), multi-week operation (ops), other-venue shadow runs (same tooling, ops-scheduled).

## Implementation notes
The stub must sit at the last adapter boundary so the entire engine path (locks, sub-machine, timings) is exercised for real — stubbing higher up would invalidate the measurement. Keep run outputs append-only and dated; the report accepts a date range.

## Verification (definition of done)
1. `npm run verify` — green; sim-mode pipeline test: scripted latencies reproduce hand-computed p50/p90 in the report.
2. Shadow-mode safety test (sim): with the flag set, zero venue-write calls occur across a full S6 scenario (spy assert), while the trace contains the complete would-be timeline.
3. Env-gated live smoke on Binance: one settlement window in shadow mode → report emits arrival/latency/selection sections, and the WS-vs-REST observation split is present; without keys, clean skip.
4. Report JSON schema documented (consumed by 0500).
