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
  (0420), `okx/` the third (0430), `bitget/` the fourth (0440); all hold the same nine files
  with the same exported shapes (OKX and Bitget add a tenth, `client-order-id.ts` — an escape
  codec on OKX, a bare length guard on Bitget), so the remaining two (0450–0460) copy that
  shape verbatim.

## Venue-quirk-as-data

A venue's differences are **data at the edge**, never branches in the core. Precision,
contract size, symbol multipliers, funding cadence, min-notional — all captured on the
validated `Instrument` at load, so the core does one thing for every venue. If you find
yourself special-casing a venue inside `src/core/`, the quirk belongs here instead.

### Venue-quirk table

One row per venue, one column per thing that actually differs. Add a row (not a branch) per
adapter; if a column cannot express a venue, that is the signal the port needs widening —
raise it in STATUS rather than special-casing the core.

| Quirk | Binance (USDⓈ-M) | Bybit (v5 linear) | OKX (v5 swap) | Bitget (v3 / UTA) |
|---|---|---|---|---|
| Credentials | key + secret | key + secret | key + secret + **passphrase** (`apiPass`; ccxt calls it `password`). The first venue to read `secrets.apiPassphrase` — absent, the factory fails loud rather than 50104-ing on the first signed call | key + secret + **passphrase** (`apiPass` native, `password` in ccxt), as on OKX |
| Testnet | separate domain + separate keys | separate domain + separate keys | **no testnet** — demo trading is a *flag* on the same account (`demoTrading: true`, ccxt `setSandboxMode(true)`); only the WS host differs (`wspap` vs `ws`) | **no testnet** — demo trading is a *header* (`PAPTRADING: 1`) on the same REST host, own demo-only keys (the live host answers them `40099`); only the WS host differs (`wspap`). The `SUSDT-FUTURES` demo *product* is v2-mix-only and rejected by v3 (`40034`) — on v3 demo serves the ordinary `USDT-FUTURES` category, 24 symbols |
| Contract size | `1` except the multiplier listings | `1` except the multiplier listings | **per-instrument `ctVal`** (`BTC-USDT-SWAP` = 0.01 BTC); ~half the live universe is ≠ 1. `sz`/`minSz`/`lotSz` are **contract counts**, which is already `computeQty`'s unit; cross-checked against ccxt `contractSize`, disagreement is fatal | `1` for **every** symbol (multipliers fold in) — sizes on the wire are base units, the mirror image of OKX |
| Symbol multipliers | `1000`, `1000000` | `1000`, `10000`, `1000000` (false-positive traps in the live listing: `1INCH`, `2Z`, `0G` — a prefix only counts when a letter follows) | none on today's listing (the face value lives in `ctVal`); the same prefix guard is kept so all three venues behave alike | `1000`, `10000`, `1000000` — the same set as Bybit, so `normalize-symbol.ts` is that file verbatim (letter-follows guard included) |
| Funding-interval source | ccxt `info.fundingIntervalHours`, plus a second REST read (`fapi/v1/fundingInfo`) for the non-8h symbols | `info.fundingInterval` **in minutes** (60/240/480; `0` marks the dated `LinearFutures` rows) → `/60`; one call, no second read | **no field at all** — the interval *is* `nextFundingTime − fundingTime` off `GET /api/v5/public/funding-rate`; one extra all-symbol read per registry load (live cadences: 4 h and 8 h) | `info.fundInterval`, **in hours** as a string (`"8"`); one call, no second read — the simplest of the four |
| Funding-fee delivery | WS `ACCOUNT_UPDATE` `updateEventType: 'FUNDING_FEE'`; amount inferred from the matching quote-asset balance change | WS `execution` frame with `execType: 'Funding'` (**unconfirmed for UTA** — see STATUS 0420); `execFee` is the charge, negated into the port's credit-positive convention | `balance_and_position` with `eventType: 'funding_fee'`; the frame carries an **absolute** `cashBal`, so the amount is a delta vs the previous frame (Binance's shape, not Bybit's). Published only when exactly one position row resolves — a two-position settlement falls back to the REST bills | **no funding channel at all**: inferred from the `account` topic's balance delta, with REST `fetchFundingHistory` as the money truth (unconfirmed live — the demo account held no position across a settlement) |
| `fundingIncome` (REST money truth) | `NotImplemented` stub (deferred past 0300) | real: ccxt `fetchLedger` → `/v5/account/transaction-log` `type=SETTLEMENT`, field `funding`, **positive = received** | real: ccxt `fetchLedger` → `/api/v5/account/bills`, bill `type=8`, field `balChg`, **positive = received**. The bill type must **not** be sent as a param — `type` is ccxt's reserved *market*-type key and arrives as `instType=8` (`51000`); the row filter is the gate | real, and the simplest: ccxt `fetchFundingHistory` has a genuine UTA branch (cursor-paginated), so rows arrive already scoped to funding — no ledger/bill-type filter |
| Margin-mode granularity | per symbol (`setMarginMode('isolated', symbol)`) | **account-wide** on the Unified Trading Account (`POST /v5/account/set-margin-mode` `ISOLATED_MARGIN`); the port's `symbol` is ignored and the call is applied once per process (0420 D1) | **per order** (`tdMode: 'isolated'` on every submit) — there is no margin-mode switch. `setMarginMode` instead enforces the precondition: the account must be on **level `2`** (spot-and-futures); `1` cannot trade derivatives (`51010`), `3`/`4` reject isolated. The switch (`POST /api/v5/account/set-account-level`) is privileged (`51070` → UI-only), so a refusal is a logged skip | **account-level switch** — UTA `accountLevel` (`basic`/`advanced`/`isolated`/`delta`) via `POST /api/v3/account/adjust-mode`; the port's `symbol` is ignored. The write **is** permitted on a demo sub-account (0440 Phase 2); a refusal is a logged skip, since every submit also states `marginMode: 'isolated'` |
| Position mode | account-wide `hedged: false` | per symbol *or* per coin (`POST /v5/position/switch-mode` `mode=0`); scoped by `coin: 'USDT'` so one call covers the universe | account-wide (`POST /api/v5/account/set-position-mode` `posMode: 'net_mode'`); rejected with `59000` while anything is open **even when it already matches**, so the mode is read first and a matching account left alone | account-wide (`POST /api/v3/account/set-hold-mode`, `holdMode: 'one_way_mode'`); refused while anything is open, so the mode is read first |
| Leverage | per symbol, one value | per symbol, `buyLeverage === sellLeverage` required in one-way mode | per symbol **and** per margin mode (`mgnMode` is required); `posSide` only exists in long/short mode, so it is omitted | per symbol **and** scoped by `marginMode`; read back off `getAccountSettings().symbolConfigList`, not a separate endpoint. `posSide` omitted (one-way mode) |
| Order transport | WS-API `submitNewFuturesOrder`/`cancelFuturesOrder`; reject code nested at `err.error.code` | WS-API `submitNewOrder`/`cancelOrder` (`category: 'linear'`, `orderLinkId` = `clientOrderId`, `positionIdx: 0`); reject arrives as the **raw reply object** carrying `retCode` | WS-API `submitNewOrder`/`cancelOrder`. A **third** reject shape: a *resolved* reply with `code: '1'` and the real reason at `data[0].sCode`/`sMsg`. The WS trade API also requires the numeric **`instIdCode`** (`instId` deprecated March 2026; without it, `50014`) | WS-API `submitNewOrder`/`cancelOrder` (`category: 'usdt-futures'`, `clientOid`, `marginMode` per order). Reject arrives as the raw error frame `{event:'error', code, msg}`. The SDK's on-connect login can fire while the socket is `CONNECTING`, so the WS-API client is built with `authPrivateConnectionsOnConnect: false` (the OKX lesson, same fix) |
| `clientOrderId` charset | `^[.A-Za-z0-9_-]{1,36}$` — engine id verbatim | `orderLinkId`, 36 chars, hyphens fine — verbatim | `clOrdId` is **alphanumeric only, 32 chars**, so the engine id is escape-coded both ways (`client-order-id.ts`: `-`→`xd`, `_`→`xu`, `x`→`xx`); an undecodable echo is dropped, never guessed | `clientOid`, `^[\.A-Z\:/a-z0-9_-]{1,32}$` — engine id verbatim, but the ceiling is **32 < the core's 36**, so `client-order-id.ts` is a bare length guard that throws (never truncates) |
| Order read by client id | ccxt `fetchOrder(id, symbol, { clientOrderId })` | ccxt `fetchOrder` hard-binds the venue `orderId`, so the client-id read goes through `fetchOpenOrders(symbol, …, { orderLinkId })` → `/v5/order/realtime` (open + recently closed = the fill-poll window) | ccxt `fetchOrder('', instId, { clOrdId })` works, but OKX **demands the instrument**, so the read depends on the submit-time `clientOrderId → instId` map; an id this process never submitted is a local typed `NotFound` | ccxt `fetchOrder('', symbol, { clientOid })` — like OKX it **demands the symbol**, so the read rides the submit-time `clientOrderId → venueSymbol` map; an unknown id is a local typed `NotFound` |
| `'stop'` order type | native `STOP` | no native stop type: conditional `Market` order with `triggerPrice` + `triggerDirection` (1 rise / 2 fall) | no standalone stop type either: a market order with the attached algo `slTriggerPx` + `slOrdPx: '-1'` (market on trigger) | no standalone stop type: a market order with an attached `stopLoss` + `slTriggerBy: 'mark'` |
| Rate-limit model | published request **weights** per endpoint (2400/min) | **no weights** — request counts: 600 req/5 s per IP, 10 orders/s per UID. Expressed as one number: `rate_limit_weight_per_minute: 6000` + 10 % order reserve = 600/min = 10/s (0420 D2); every call costs weight 1 | **no weights and no IP-wide aggregate** — per-endpoint counts (20 req/2 s per read endpoint; 60 orders/2 s per instrument). `rate_limit_weight_per_minute: 1200` at a **50 %** reserve makes both lanes true: order 600/min = 10/s, general 600/min = one read endpoint's cap | **no weights** — per-UID request counts (10 place-order/s, 20 order-info/s). `rate_limit_weight_per_minute: 1700` at a **35 %** reserve keeps both lanes under cap: order 595/min ≈ 9.9/s, general 1105/min ≈ 18.4/s |
| Public funding stream | one all-symbol `!markPrice@arr@1s` for every perp | none — one `tickers.<SYMBOL>` subscription per symbol, which carries funding **and** last price; frames after the first are **deltas**, so absent fields must never publish a zero | **two** per-symbol channels: `funding-rate` → `FundingPredicted`, `tickers` → `MarketTick`. No refcount needed (nothing shares a topic); frames are full snapshots, but `""` still must never publish a zero | one **fused** `ticker` topic per symbol (Bybit's shape) carrying last price *and* funding rate/next funding time; frames are full snapshots, but `""` must still never publish a zero |
| WS balance split | approximated from `crossWalletBalance` / `walletBalance` | exact: `availableToWithdraw` / `walletBalance` per coin | exact: `availBal` / `frozenBal` per currency | exact, per coin off the `account` topic (`available` / `locked`) |
| Non-zero error reply | the SDK throws | the native SDK **resolves** a non-zero `retCode` by default — the REST client is constructed with `throwExceptions: true`, without which a rejected order would look like success | REST throws the whole `{code, msg, data}` envelope; `code: '0'`/`'1'` are envelope values, **not** error codes — the real code is `data[0].sCode` | REST **throws a plain object** whose top-level `code` is the **HTTP status** — the venue code is nested at `body.code` (`400` + `body.code: '25204'`). Two success envelopes: REST `"00000"`, WS-API `"0"`; neither is ever an error code |
| WS-API login | SDK default | SDK default | the SDK's on-connect login races `sendWSAPIRequest`'s own; the second login gets `60031` and OKX **closes the socket**, so the WS-API client is built with `authPrivateConnectionsOnConnect: false` (it subscribes to no topics, so one login on first use is enough) | `authPrivateConnectionsOnConnect: false` on the WS-API client only (see Order transport); the private *stream* client keeps auth-on-connect, which is what gates its topic subs |

## ccxt / native split (`08` §6)

- **ccxt** backs market **metadata** (`loadMarkets`) and **REST** funding/order fallback.
- The **native** lib (Binance → `binance`, Bybit → `bybit-api`, OKX → `okx-api`, Bitget →
  `bitget-api`; all four tiagosiebler SDKs, same idioms) owns the **hot-path WS** (public/private
  streams, WS-API orders) and, on Bybit/OKX/Bitget, the account-setup writes ccxt would mis-map
  (Bybit: the classic per-symbol isolated switch; OKX: no unified analogue for the account-level
  read at all; Bitget: `setMarginMode` has **no UTA branch** and would hit the v2 mix endpoint).
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
  Binance and Bitget, **minutes** on Bybit, derived from two timestamps on OKX), else the venue's
  8h default; validated ∈ {1,2,4,8}.

## Fail-loud on anomaly (`10` §3–§4)

Building the `Instrument` registry **throws** on any anomaly (missing/zero precision or
contract size, unparsable symbol, out-of-set funding interval) — a bad instrument aborts
`init()` (and thus startup, `09` §5 step 6) before any order. A wrong `contractSize`
silently mis-sizes every future order, so there is no "warn and continue".

## Pointers (do not restate here)

- **Error mapping + rate limiter** → task 0200. 0190 uses only `NotImplemented` stubs for
  trade-side methods and builds no error infra (KISS).
- **Fixture capture tool** → task 0250, venue-parameterized at 0420:
  `npm run capture -- --venue binance|bybit|okx|bitget --set …`.
- **Testnet verification tier** (task 0260, venue-parameterized at 0420) →
  `npm run test:testnet -- --venue binance|bybit|okx|bitget`. One `src/testnet/` harness with a
  JSON summary artifact; credential-gated (`<VENUE>_TESTNET_API_KEY`/`_SECRET`, plus
  `OKX_TESTNET_PASSPHRASE` / `BITGET_TESTNET_PASSPHRASE` on those two — where it runs against
  **demo trading**, not a testnet), skips clean without them. Excluded from `verify`; 0450–0460
  add a row to the venue map.
  Observed venue divergences → `docs/testnet-notes.md`.
- Core-purity rule → `src/core/CLAUDE.md`; test tiers/conventions → `test/CLAUDE.md`.
