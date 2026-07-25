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
- `exchanges/<venue>/` — real adapters. `binance/` is the first (0190), `bybit/` the second
  (0420); both hold the same nine files with the same exported shapes, so the remaining four
  (0430–0460) copy that shape verbatim.

## Venue-quirk-as-data

A venue's differences are **data at the edge**, never branches in the core. Precision,
contract size, symbol multipliers, funding cadence, min-notional — all captured on the
validated `Instrument` at load, so the core does one thing for every venue. If you find
yourself special-casing a venue inside `src/core/`, the quirk belongs here instead.

### Venue-quirk table

One row per venue, one column per thing that actually differs. Add a row (not a branch) per
adapter; if a column cannot express a venue, that is the signal the port needs widening —
raise it in STATUS rather than special-casing the core.

| Quirk | Binance (USDⓈ-M) | Bybit (v5 linear) |
|---|---|---|
| Symbol multipliers | `1000`, `1000000` | `1000`, `10000`, `1000000` (false-positive traps in the live listing: `1INCH`, `2Z`, `0G` — a prefix only counts when a letter follows) |
| Funding-interval source | ccxt `info.fundingIntervalHours`, plus a second REST read (`fapi/v1/fundingInfo`) for the non-8h symbols | `info.fundingInterval` **in minutes** (60/240/480; `0` marks the dated `LinearFutures` rows) → `/60`; one call, no second read |
| Funding-fee delivery | WS `ACCOUNT_UPDATE` `updateEventType: 'FUNDING_FEE'`; amount inferred from the matching quote-asset balance change | WS `execution` frame with `execType: 'Funding'` (**unconfirmed for UTA** — see STATUS 0420); `execFee` is the charge, negated into the port's credit-positive convention |
| `fundingIncome` (REST money truth) | `NotImplemented` stub (deferred past 0300) | real: ccxt `fetchLedger` → `/v5/account/transaction-log` `type=SETTLEMENT`, field `funding`, **positive = received** |
| Margin-mode granularity | per symbol (`setMarginMode('isolated', symbol)`) | **account-wide** on the Unified Trading Account (`POST /v5/account/set-margin-mode` `ISOLATED_MARGIN`); the port's `symbol` is ignored and the call is applied once per process (0420 D1) |
| Position mode | account-wide `hedged: false` | per symbol *or* per coin (`POST /v5/position/switch-mode` `mode=0`); scoped by `coin: 'USDT'` so one call covers the universe |
| Leverage | per symbol, one value | per symbol, `buyLeverage === sellLeverage` required in one-way mode |
| Order transport | WS-API `submitNewFuturesOrder`/`cancelFuturesOrder`; reject code nested at `err.error.code` | WS-API `submitNewOrder`/`cancelOrder` (`category: 'linear'`, `orderLinkId` = `clientOrderId`, `positionIdx: 0`); reject arrives as the **raw reply object** carrying `retCode` |
| Order read by client id | ccxt `fetchOrder(id, symbol, { clientOrderId })` | ccxt `fetchOrder` hard-binds the venue `orderId`, so the client-id read goes through `fetchOpenOrders(symbol, …, { orderLinkId })` → `/v5/order/realtime` (open + recently closed = the fill-poll window) |
| `'stop'` order type | native `STOP` | no native stop type: conditional `Market` order with `triggerPrice` + `triggerDirection` (1 rise / 2 fall) |
| Rate-limit model | published request **weights** per endpoint (2400/min) | **no weights** — request counts: 600 req/5 s per IP, 10 orders/s per UID. Expressed as one number: `rate_limit_weight_per_minute: 6000` + 10 % order reserve = 600/min = 10/s (0420 D2); every call costs weight 1 |
| Public funding stream | one all-symbol `!markPrice@arr@1s` for every perp | none — one `tickers.<SYMBOL>` subscription per symbol, which carries funding **and** last price; frames after the first are **deltas**, so absent fields must never publish a zero |
| WS balance split | approximated from `crossWalletBalance` / `walletBalance` | exact: `availableToWithdraw` / `walletBalance` per coin |
| Non-zero error reply | the SDK throws | the native SDK **resolves** a non-zero `retCode` by default — the REST client is constructed with `throwExceptions: true`, without which a rejected order would look like success |

## ccxt / native split (`08` §6)

- **ccxt** backs market **metadata** (`loadMarkets`) and **REST** funding/order fallback.
- The **native** lib (Binance → `binance`, Bybit → `bybit-api`; both tiagosiebler SDKs, same
  idioms) owns the **hot-path WS** (public/private streams, WS-API orders) and, on Bybit, the
  account-setup writes ccxt would mis-map to the classic per-symbol isolated switch.
- The adapter is the only place that knows which; the core sees only the port. Keep
  network-touching paths **constructor-injectable** (`createBinanceAdapter({ client, … })`,
  `createBybitAdapter({ client, … })`) so unit tests inject a fixture-backed fake and run
  fully offline.

## Symbol / denomination normalization (`10` §4)

- `normalize-symbol.ts`: strip a leading multiplier prefix from the ccxt base → canonical name
  (`1000PEPE` → `PEPE`), keeping the venue symbol intact for API calls. The prefix **set is
  per venue** (see the quirk table) and only counts when a letter follows it, so `1INCH` stays
  `1INCH`.
- **Fold the multiplier into `contractSize`** (`1000PEPE` → `contractSize 1000`), matching
  the sim row and the 0120 sizing math, so all core math is base-unit. Precisions / min-qty
  are the venue's own step sizes, taken from ccxt as-is.
- `fundingIntervalHours` is sourced from venue metadata (per-venue field and unit — hours on
  Binance, **minutes** on Bybit), else the venue's 8h default; validated ∈ {1,2,4,8}.

## Fail-loud on anomaly (`10` §3–§4)

Building the `Instrument` registry **throws** on any anomaly (missing/zero precision or
contract size, unparsable symbol, out-of-set funding interval) — a bad instrument aborts
`init()` (and thus startup, `09` §5 step 6) before any order. A wrong `contractSize`
silently mis-sizes every future order, so there is no "warn and continue".

## Pointers (do not restate here)

- **Error mapping + rate limiter** → task 0200. 0190 uses only `NotImplemented` stubs for
  trade-side methods and builds no error infra (KISS).
- **Fixture capture tool** → task 0250, venue-parameterized at 0420:
  `npm run capture -- --venue binance|bybit --set …`.
- **Testnet verification tier** (task 0260, venue-parameterized at 0420) →
  `npm run test:testnet -- --venue binance|bybit`. One `src/testnet/` harness with a JSON
  summary artifact; credential-gated (`<VENUE>_TESTNET_API_KEY`/`_SECRET`), skips clean
  without them. Excluded from `verify`; 0430–0460 add a row to the venue map.
- Core-purity rule → `src/core/CLAUDE.md`; test tiers/conventions → `test/CLAUDE.md`.
