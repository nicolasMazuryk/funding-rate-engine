# 0470 — Live-tier harness (capped real money)

**Phase:** 7 — Live tier
**Depends on:** 0260, 0380
**Spec references:** `0000_agentic-development-environment.md` "The stakes" (real production verification, safe by construction), §3 (layered verification); `13_risk_and_failure_modes.md` (kill switch, flatten); `09_configuration.md` §2 (sub-account secrets)

## Objective
The fourth verification layer: a harness for running **real tests against production Binance with small amounts of real money**, safe by construction — hard-capped notional enforced in code (not just config), isolated sub-account verification, automatic flatten/teardown on exit or failure, and machine-checkable structured pass/fail so an agent can run it and interpret the result autonomously.

## Context for the agent
Spec 0000 is explicit: sims and testnets are necessary but not sufficient — real fills, real funding settlement, real precision rejections, real rate limits, real reconnects only manifest live. Safety-by-construction requirements (all from spec 0000 "stakes"): (1) **hard notional cap** — the harness wraps the order path and rejects any order that would exceed a compiled-in ceiling (e.g. 25 USD notional per order, 50 USD total exposure — pick, document, and enforce; config may lower, never raise); (2) **sub-account isolation check** — at startup, assert the API key sees only the expected sub-account (balance below a ceiling, no unexpected positions) and refuse to run otherwise; (3) **auto-flatten teardown** — `flattenAll` (0380) + full order-cancel sweep runs on completion, on failure, and on signal (SIGINT/SIGTERM trap), then verifies flat via REST; (4) **machine-checkable output** — JSON verdict per check `{name, pass, evidence}`. Keys exist per planning decision; live runs happen in 0480 — this task builds and proves the harness itself with a minimal self-test.

## Scope
- In scope:
  - `test/live/harness.ts` + `npm run test:live -- --venue binance --suite <name>`: boots a real instance (composition root, real adapter, real Postgres, real WAL) inside the capped wrapper.
  - The cap-wrapper around `placeOrder` (notional per order + running exposure), the sub-account preflight, the teardown/flatten trap, the JSON verdict writer.
  - A minimal **harness self-test suite** (the only live suite in this task): place one min-notional limit order far from market, verify `OrderRejected`-free placement, cancel it, verify flat — plus a deliberate cap-violation attempt that must be rejected by the wrapper (proving the cap works without risking it).
  - `/live-tier` skill (extends 0180's set): how to run, how to read the verdict, safety rules (never raise caps, never bypass the wrapper).
  - `docs/testing-strategy.md` updated: the live tier's place, cost, and rules.
- Out of scope: the real per-strategy live verification suites (0480), S6 shadow/canary (0490/0500), any venue beyond Binance.

## Implementation notes
The cap must sit at the last mile (order-manager boundary), not in strategy code, so nothing can route around it. Teardown must be idempotent and re-entrant (a crash during teardown → rerunning teardown completes it). The verdict file should embed the WAL/trace location so a failed live run is immediately replayable (0170) — this is how live failures become regression tests.

## Verification (definition of done)
1. `npm run verify` — green (unit tests for the cap wrapper: order over cap rejected; exposure accumulation; teardown idempotency against the sim).
2. With production keys on the isolated sub-account: `npm run test:live -- --venue binance --suite self-test` — JSON verdict all-pass; the cap-violation check shows `pass: true` (rejection happened); REST-verified flat at exit; total fees spent ≤ a stated cents-level bound (report it in the verdict).
3. Kill the harness mid-run (manual or scripted SIGINT during the resting order) — teardown flattens and cancels; re-run confirms flat.
4. Without keys: clean, loud skip.
