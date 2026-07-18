# 0190 — Binance clients, market loading, instrument registry

**Phase:** 3 — Binance adapter
**Depends on:** 0110, 0120
**Spec references:** `10_exchange_adapters_and_market_data.md` §2 (ClientFactory, ccxt/native split), §3 (market loading & filtering), §4 (instrument registry); `08_system_overview.md` §6 (ccxt vs native binding rule); `09_configuration.md` §5 step 6 (instrument validation at startup); `0000_agentic-development-environment.md` §2 (nested CLAUDE.md — adapters)

## Objective
The first real venue adapter begins: a `BinanceAdapter` shell with `ClientFactory` building the ccxt client and the native `binance` lib from profile + secrets, `init()` that loads markets, filters to active linear USDT perps, builds the validated `Instrument` registry (fail-loud on any normalization/precision anomaly), hourly market reload, and per-event funding-schedule reads. This adapter is the pattern the other five venues copy.

## Context for the agent
Binding split (`08` §6): ccxt owns metadata/precision/limits and REST fallback; the native lib owns hot-path WS (later tasks). The core never sees which. Filter rule (`10` §3): `type == 'swap' && linear && quote == 'USDT' && active`. Instrument fields per `10` §4 including `fundingIntervalHours` — but the funding *schedule* is re-read per event, never cached per symbol (`00_globals` §8.1). A wrong `contractSize` mis-sizes every order → startup abort on anomalies (missing precision, zero contractSize, unparsable venue symbol). Denomination helpers come from 0120. If the exact npm package name differs from the canonical list, apply ROADMAP assumption A5 and record the substitution in STATUS.md.

## Scope
- In scope:
  - Deps: `ccxt`, native `binance` lib.
  - `src/adapters/exchanges/binance/factory.ts`, `adapter.ts`: `init`/`close`, `markets()`, `normalize()`, `predictedFunding()` (REST), `fundingHistory()`, funding-schedule read (`T_settle` + interval per symbol); other interface methods may throw `NotImplemented` for now (orders/streams land 0210–0230) — but the type must fully implement `ExchangeAdapter`.
  - Instrument construction: ccxt market → `Instrument` (normalized symbol incl. `1000X` handling via 0120, tick/lot, minNotional/minQty, contractSize, fundingIntervalHours), validation with abort-on-anomaly, `symbols.deny` filter from config.
  - Hourly reload wiring through the scheduler (0050) — reload updates the registry atomically.
  - Instrument-validation hook from 0110 step 6 implemented here.
  - `src/adapters/CLAUDE.md` (JIT, spec 0000 §2): venue-quirk conventions, ccxt/native split rule, error-mapping conventions, fixture conventions (pointer; fixtures land 0250).
  - Tests: unit tests against **recorded ccxt market payloads** committed as fixtures (hand-captured now; the capture tool comes in 0250) — filtering, normalization, denomination, anomaly abort.
- Out of scope: WS streams (0210/0220), orders (0230), rate limiter & error mapping (0200), testnet config (0260), other venues (0420–0460).

## Implementation notes
Keep everything venue-shaped as data or adapter-local mapping — no venue name reaches core. Network-touching paths must be constructor-injectable so unit tests run offline from fixture JSON. Live-network smoke (public endpoints, no keys) belongs in `test/integration/` gated behind an env flag.

## Verification (definition of done)
1. `npm run verify` — green offline (fixture-driven unit tests: spot/inverse/expiry/delisted symbols filtered out; `1000PEPE`-style normalization; anomaly payload aborts).
2. `BinanceAdapter` type-checks as `ExchangeAdapter` with no casts.
3. Integration (env-gated, no credentials): `npm run test:integration` with the flag set loads real Binance markets, builds ≥ 100 instruments, zero validation aborts; without the flag, suite skips cleanly.
4. `src/adapters/CLAUDE.md` exists.
