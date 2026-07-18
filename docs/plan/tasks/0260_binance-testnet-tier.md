# 0260 — Binance testnet verification tier

**Phase:** 3 — Binance adapter
**Depends on:** 0240, 0250
**Spec references:** `17_testing.md` §3 (integration per exchange); `0000_agentic-development-environment.md` §3 (layered verification, per-tier commands); `10`/`11` (behaviors under test)

## Objective
The consolidated, one-command testnet tier for Binance: `npm run test:testnet` runs the full `17` §3 checklist against the Binance futures testnet with structured, machine-readable pass/fail output — the third verification layer (after unit and fixture/sim integration), and the template every other venue's testnet tier copies.

## Context for the agent
Scattered env-gated testnet tests already exist (0220, 0230, 0240). This task consolidates them into one suite + adds the missing checklist items so the tier is complete per `17` §3: market load/filter matches ccxt metadata; account setup incl. hard-reject behavior; order path WS-first with `clientOrderId` idempotency and typed rejection surfacing (deliberately malformed orders → `OrderRejected`, not raw errors); private + public streams produce expected events with REST re-prime on reconnect; error taxonomy under induced errors; rate limiter reserves the order lane; per-exchange deltas honored. Testnets behave unlike production (spec 0000 expertise notes) — flakiness must be engineered out: bounded waits on events with generous timeouts, retries where the testnet is known-slow, and skip-with-reason markers for testnet-impossible checks (documented per check).

## Scope
- In scope:
  - `test/testnet/binance/` suite covering the `17` §3 list; `npm run test:testnet` (venue-parameterized: `-- --venue binance`).
  - Structured output: per-check pass/fail/skip + reason, JSON summary artifact (spec 0000 §3 machine-readable requirement).
  - Testnet credential wiring documented in `.env.example` (`BINANCE_TESTNET_API_KEY`…), profile flag for testnet endpoints in `exchanges.yaml` (base URLs swap — data-driven, no code branch).
  - `/testnet` skill: run + interpret the JSON summary.
  - A short `docs/testnet-notes.md` section for Binance: what the testnet can't test (record observed divergences — feeds venue tasks later).
- Out of scope: real-money live tier (0470), other venues' testnet suites (0420–0460 copy this), CI wiring (0530).

## Implementation notes
Serialize tests that share account state (position-mode changes affect the whole account). Clean up after every test: cancel open orders, flatten any test position — leave the testnet account flat (assert flat at suite end; this pattern previews the live tier's auto-flatten). Fund-dependent checks should self-check testnet balance first and skip-with-reason if unfunded.

## Verification (definition of done)
1. `npm run verify` — still green (testnet suite excluded from default verify).
2. With testnet credentials: `npm run test:testnet -- --venue binance` completes; JSON summary shows every `17` §3 checklist item pass or skip-with-documented-reason, zero fails; account is flat and orderless at exit (final check asserts it).
3. Without credentials: command exits with a clear "skipped: no credentials" status, exit code 0 in skip mode.
