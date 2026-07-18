# 0480 — Live verification runs — Binance

**Phase:** 7 — Live tier
**Depends on:** 0340, 0400, 0470
**Spec references:** `0000_agentic-development-environment.md` "The stakes" (edge cases that only manifest live); `17_testing.md` (what each tier proves); strategy files `01`–`06` §2–§4; `15_accounting_and_reconciliation.md` §2

## Objective
The live proof for the non-S6 strategy set on Binance: capped real-money suites through the 0470 harness that exercise, against production, the behaviors no sim or testnet can prove — real entry/exit fills around a real funding settlement, a real `FundingFeeAccrued` credit opening the gate, real precision/min-notional rejections, real rate-limit behavior, a real WS reconnect mid-session — each with machine-checkable pass/fail and post-run reconciliation (0400) confirming engine records match venue truth.

## Context for the agent
Suites run at minimum size (`amountUsd` ≈ min-notional, hard caps from 0470). Live funding events are hourly-at-best and symbol-dependent — the suites must **select a real upcoming settlement** (any funding sign; thresholds set permissively for the test — the point is machinery, not economics; use a config override profile marked `live-test`) and schedule around it. Suites and what each proves: (a) **S1 timed round-trip** — market entry before a real `T_settle`, timed exit, `funding_received` correctness against the venue's income record; (b) **S1-WS gate** — real funding credit opens the gate (measure `t_drop_offset_s`), or REST-poll fallback proves itself; (c) **protective pair (S3a-shape)** — entry + OCO SL/TP placement/cancel mechanics live (deadline exit path to bound duration); (d) **S4.2a limit + expiry** — resting limit with `expireAt`, expect `limit_expired` on a quiet window (zero-cost path proven live); (e) **rejection catalog** — deliberately-invalid orders (sub-min-notional, bad precision) surface as typed rejections; (f) **reconnect** — forced WS drop mid-monitoring, re-prime, no state loss. Each run ends with reconciliation and a flat account.

## Scope
- In scope:
  - `test/live/suites/` for (a)–(f) on the 0470 harness, each with pre-registered machine-checkable assertions and JSON verdicts; a runner that waits for/schedules around a real settlement with a hard wall-clock timeout.
  - `live-test` config override profile (permissive thresholds, min sizing) — clearly named, refused by the normal composition root outside the harness.
  - Post-run reconciliation invocation + verdict integration (engine vs venue diffs within tolerance = pass).
  - A run report artifact (trace + verdict + reconciliation summary) committed template-wise (not the money-run outputs themselves).
- Out of scope: S6 live validation (0490/0500 — its entry path has its own protocol), other venues live (ops decision post-plan), profitability assessment (analytics 0410 reads whatever accumulates; not a pass/fail here).

## Implementation notes
Wall-clock reality: these tests wait for real settlements — build the runner to sleep-until with generous logging, and to abort cleanly (teardown) if the window is missed. Order the suites cheapest-first; (a) and (b) can share one settlement event (different symbols). Fee budget per full run should be estimated up front in the runner output. A failed live suite must leave behind its trace for `npm run replay` debugging (0470 wired this).

## Verification (definition of done)
1. `npm run verify` — green (runners + assertions unit-tested against the sim first — every suite has a sim rehearsal mode proving its assertion logic).
2. With production keys: suites (a), (b), (d), (e) executed against real settlements — JSON verdicts all-pass; reconciliation diffs within tolerance; account flat after each; cumulative spend within the pre-stated budget. Suites (c), (f) executed at least once each with all-pass verdicts.
3. `funding_received` cross-check: the venue income record for suite (a) matches the engine's flag and amount (reconciliation evidence in the verdict).
4. Without keys: clean skip; sim-rehearsal mode still passes for every suite.
