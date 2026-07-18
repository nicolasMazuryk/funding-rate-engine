# 0430 — OKX adapter

**Phase:** 6 — Remaining venues
**Depends on:** 0260
**Spec references:** `10_exchange_adapters_and_market_data.md` (all); `11_execution_and_account_state.md`; `17_testing.md` §3; `09_configuration.md` §4 (OKX profile example with deltas)

## Objective
The complete OKX adapter behind the one interface, following the Binance pattern — clients, error mapping, public/private WS, WS-first orders, fixtures, testnet/demo tier — zero core changes.

## Context for the agent
Structure and process identical to 0420 (read it; it is the template applied to Bybit). OKX-specific facts from the specs: the `09` §4 example shows OKX carrying deltas (`funding_fee_timeout_seconds: 45`, `leverage_strategy_1: 4`, `ws_order_rest_fallback: true`) — treat these as *examples of the delta mechanism*, not confirmed venue facts; measure/decide real values during this task and set the profile accordingly (record rationale in STATUS notes). OKX quirks to expect: passphrase in auth (the `.env` schema from 0100 supports `*_API_PASSPHRASE`), instrument naming (`BTC-USDT-SWAP`), contract-size denominated in contracts (`contractSize` handling from 0120 gets real exercise — OKX is the venue where a wrong `contractSize` classically mis-sizes), demo-trading mode instead of a classic testnet.

## Scope
- In scope:
  - `src/adapters/exchanges/okx/` mirroring the Binance layout: factory, adapter, error map, public stream, private stream, WS orders.
  - Fixtures via `npm run capture -- --venue okx`; completed `exchanges.yaml` OKX profile including whichever deltas are confirmed.
  - Fixture-driven unit tests + `npm run test:testnet -- --venue okx` (OKX demo-trading mode; if unusable for a checklist item, skip-with-reason and record in `docs/testnet-notes.md`).
  - Contract-size sizing test: an OKX instrument with `contractSize ≠ 1` sizes orders correctly end-to-end (unit, from fixtures).
- Out of scope: core changes (same rule as 0420 — `git diff src/core/` must be empty), live-money runs.

## Implementation notes
The per-exchange delta path (0110) gets its first real multi-delta consumer here — verify the merged effective config in a test (e.g. S1-on-OKX effective leverage reflects the profile delta). Passphrase must flow through redaction (0110 Pino patterns) — grep logs in tests.

## Verification (definition of done)
1. `npm run verify` — green offline; contract-size sizing test passes.
2. Captured OKX fixtures committed; effective-config delta test passes.
3. With demo credentials: `npm run test:testnet -- --venue okx` — checklist pass/skip-with-reason, flat at exit; clean skip without credentials.
4. `git diff` clean under `src/core/`; no secret material in fixtures (grep).
