# CLAUDE.md — `src/adapters/` (the venue edge)

Everything the pure core is **not**: real exchange clients, sockets, venue quirks.
An adapter implements the one `ExchangeAdapter` port (`src/core/ports/exchange-adapter.ts`)
so the core trades against any venue — or the credential-free `sim` — behind the same
contract. Nested per `0000_agentic-development-environment.md` §2; the live-system
shape is `docs/specs/10`–`11`.

## Where things live

- `sim/` — in-memory venue, zero credentials (0060/0160). The reference the core is
  tested against; happy path + scriptable faults.
- `clock/` — `real-clock` (wall time) and `virtual-clock` (manual, deterministic test time).
- `exchanges/<venue>/` — real adapters. `binance/` is the first (0190); the other five
  (0420–0460) copy its shape verbatim.

## Venue-quirk-as-data

A venue's differences are **data at the edge**, never branches in the core. Precision,
contract size, symbol multipliers, funding cadence, min-notional — all captured on the
validated `Instrument` at load, so the core does one thing for every venue. If you find
yourself special-casing a venue inside `src/core/`, the quirk belongs here instead.

## ccxt / native split (`08` §6)

- **ccxt** backs market **metadata** (`loadMarkets`) and **REST** funding/order fallback.
- The **native** lib (Binance → `binance`, tiagosiebler's SDK) owns the **hot-path WS**
  (public 0210, private 0220, orders 0230). Constructed by the factory now; unused until
  then.
- The adapter is the only place that knows which; the core sees only the port. Keep
  network-touching paths **constructor-injectable** (`createBinanceAdapter({ client, … })`)
  so unit tests inject a fixture-backed fake and run fully offline.

## Symbol / denomination normalization (`10` §4)

- `normalize-symbol.ts`: strip a leading `1000` / `1000000` multiplier from the ccxt base
  → canonical name (`1000PEPE` → `PEPE`), keeping the venue symbol intact for API calls.
- **Fold the multiplier into `contractSize`** (`1000PEPE` → `contractSize 1000`), matching
  the sim row and the 0120 sizing math, so all core math is base-unit. Precisions / min-qty
  are the venue's own step sizes, taken from ccxt as-is.
- `fundingIntervalHours` is sourced from ccxt metadata where present, else Binance's 8h
  default; validated ∈ {1,2,4,8}.

## Fail-loud on anomaly (`10` §3–§4)

Building the `Instrument` registry **throws** on any anomaly (missing/zero precision or
contract size, unparsable symbol, out-of-set funding interval) — a bad instrument aborts
`init()` (and thus startup, `09` §5 step 6) before any order. A wrong `contractSize`
silently mis-sizes every future order, so there is no "warn and continue".

## Pointers (do not restate here)

- **Error mapping + rate limiter** → task 0200. 0190 uses only `NotImplemented` stubs for
  trade-side methods and builds no error infra (KISS).
- **Fixture capture tool** → task 0250. 0190 hand-captured the first ccxt payloads under
  `test/unit/adapters/exchanges/binance/fixtures/`.
- **Live integration gate**: `RUN_BINANCE_INTEGRATION=1` runs the real public-REST market
  smoke (no credentials); unset → skips. New env-flag pattern (mirrors golden's
  `UPDATE_GOLDEN`); 0420–0460 reuse it. Excluded from `verify`.
- Core-purity rule → `src/core/CLAUDE.md`; test tiers/conventions → `test/CLAUDE.md`.
