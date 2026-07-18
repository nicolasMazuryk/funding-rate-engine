# 0420 — Bybit adapter

**Phase:** 6 — Remaining venues
**Depends on:** 0260
**Spec references:** `10_exchange_adapters_and_market_data.md` (all — one interface, venue quirks as data); `11_execution_and_account_state.md` (order path, streams); `17_testing.md` §3 (per-exchange integration); `00_globals.md` §6 (Bybit stagger 150 ms)

## Objective
The complete Bybit adapter behind the one `ExchangeAdapter` interface, following the Binance pattern (0190–0260): clients + market loading, error mapping, public and private WS streams, WS-first order path, account setup, fixtures, and the testnet tier — with every Bybit quirk expressed as profile data or adapter-local mapping, zero core changes.

## Context for the agent
"Add a venue = write one adapter; change nothing in the core" (`10` §0) — this task proves it. The shared machinery exists: order manager orchestration (0230, venue-agnostic), rate-limiter/breaker utilities (0200), reconnect state machine (0210), fixture capture (0250), testnet suite template (0260). Bybit deltas already known from specs: `submission_stagger_ms: 150` (`00_globals` §6 — already in `exchanges.yaml` from 0110). Native lib: `bybit-api` (canonical list; ROADMAP A5 if unavailable). Expect venue quirks in: symbol conventions, funding-fee event delivery (which private topic carries it), listen/auth mechanics, error-code semantics, testnet fidelity — record every discovered quirk in `src/adapters/CLAUDE.md`'s venue table and `docs/testnet-notes.md`.

## Scope
- In scope:
  - `src/adapters/exchanges/bybit/`: factory, adapter, error map, public stream, private stream, WS orders — mirroring the Binance module layout.
  - Instrument registry validation for Bybit's market payloads (fixtures via 0250: `npm run capture -- --venue bybit`).
  - `exchanges.yaml` Bybit profile completed (endpoints, fees, deltas as discovered).
  - Fixture-driven unit tests (parse/map/normalize) + the full venue integration checklist + testnet suite `npm run test:testnet -- --venue bybit` (testnet availability: Bybit has one; confirm usability and record).
  - E2E smoke: one S1 sim-profile scenario swapped to the Bybit adapter shape is **not** required (sim is venue-neutral) — instead run the testnet suite as the venue proof.
- Out of scope: core/order-manager changes (if one seems needed, stop — that's a design smell to resolve via the smallest venue-agnostic extension, documented in STATUS notes), live-money runs (0470+ pattern; live tier covers Binance in 0480 — extending live runs to other venues is an ops decision post-plan).

## Implementation notes
Copy the Binance module's file layout deliberately — future agents navigate by symmetry. The private funding-fee event is the piece most likely to differ (topic name, sign conventions, timing) — validate its `fundingTime` semantics against `fundingHistory` REST on testnet before trusting it. Keep raw-code → typed-error mapping table-driven like 0200.

## Verification (definition of done)
1. `npm run verify` — green offline (fixture-driven tests for markets, streams, orders parsing).
2. `npm run capture -- --venue bybit --set markets` produces committed fixtures; tests consume them.
3. With Bybit testnet credentials: `npm run test:testnet -- --venue bybit` — every `17` §3 checklist item pass or skip-with-reason; account flat at exit. Without credentials: clean skip.
4. `git diff` shows no changes under `src/core/` (mechanical proof of the zero-core-change claim).
