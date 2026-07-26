# Testnet notes

Observed divergences between a venue's testnet and its production behavior — recorded
here so later venue tasks (0420–0460) don't rediscover them. Each maps to a documented
`skip-with-reason` in the corresponding `src/testnet/<venue>/checks/*.ts`.

## Binance (USD-M futures testnet)

What the testnet tier (`npm run test:testnet -- --venue binance`, task 0260) **can't**
fully verify, and why:

- **Funding-fee settlement in-window.** Testnet funding events are sparse and don't
  reliably settle inside a bounded test-run window. `streams` asserts `FundingPredicted`
  + `MarketTick` land, but does not wait for an actual funding-fee settlement event.
- **Real 429 induction.** Forcing a genuine rate-limit response is unsafe against a
  shared testnet (other suites/CI runs could get rate-limited too). `error-taxonomy`
  documents this as a skip and instead exercises typed `NotFoundError` via an unknown
  `clientOrderId` (`getOrder`, not `cancelOrder` — see the code comment on why cancel
  can't probe this).
- **REST read lag right after a mutation.** A `getOrder` read immediately following a
  `placeOrder`/`cancelOrder` occasionally 404s (`-2013 "Order does not exist"`) for a
  beat before the testnet's order-history read path catches up, even though the order
  genuinely exists/was just cancelled. Observed live while building this task.
  `order-path` wraps both post-mutation `getOrder` reads in `retry()` (bounded, a few
  hundred ms apart) rather than treating the first 404 as a real failure.
- **Real reconnect timing.** The private-stream reconnect FSM's backoff/reprime timing
  is unit-tested on a virtual clock (`private-stream.test.ts`); the testnet tier invokes
  the REST reprime path (`getBalance`/`getPositions`) directly rather than yanking the
  live socket, since a real disconnect's timing isn't controllable from here.
- **Account-wide leverage ceilings.** `account-setup`'s hard-reject check forces an
  out-of-range leverage (999x) to assert `setLeverage` hard-rejects a bad value; if a
  given testnet account's own limits happen to accept it, that half of the check skips
  with reason rather than failing on venue behavior outside our control.

These are testnet quirks, not adapter bugs — the folded 0220/0230/0240 smokes already
verified the underlying behaviors live before this task consolidated them.

## Bybit (USDT perpetual testnet)

`npm run test:testnet -- --venue bybit` (task 0420). Credentials:
`BYBIT_TESTNET_API_KEY` / `_SECRET`, keys from <https://testnet.bybit.com/>. Absent them the
whole suite skips and exits 0, exactly like Binance.

**NOT YET RUN AGAINST A LIVE TESTNET ACCOUNT.** The task's DoD step 3 needs credentials that
are not present in this workspace's `.env`, so the entries below are the *designed*
skip-with-reason paths, not observed ones. The credential-free all-skip path and every
fixture-driven unit test are verified. Re-run this suite with keys and replace this paragraph
with what actually fired.

- **Account-wide `ISOLATED_MARGIN` is privileged (decision D1).** On the Unified Trading
  Account, margin mode is set for the *whole account* (`POST /v5/account/set-margin-mode`),
  not per symbol. Bybit refuses the switch while positions/orders are open, and the endpoint
  does not exist on a classic (non-UTA) account. Both are properties of the account, not of
  our code, so `account-setup` **skips with the venue's reason** rather than failing. It then
  reads the mode back natively, so a silently-ignored write cannot pass.
- **Funding-fee delivery on the private WS is the one genuine unknown.** The docs list
  `execType: 'Funding'` on the `execution` topic, but whether UTA actually pushes it is not
  settled. The adapter maps it as the primary path and the REST transaction log is the
  fallback; `streams` asserts only the public signals it can force. Which one fires in a real
  run is what the first credentialed run should record here.
- **One `tickers.<SYMBOL>` topic carries both public signals.** There is no all-symbol
  mark-price array stream (Binance's `!markPrice@arr@1s`), so `streams` asserts that a single
  subscription yields both a `FundingPredicted` and a `MarketTick`. Frames after the first are
  **deltas**, so an absent field is normal and must never publish a zero.
- **`fundingIncome` is read over a historical 24 h window.** Unlike Binance's stub, this venue
  implements it for real (transaction log, `type=SETTLEMENT`, `info.funding`, positive =
  received). `deltas` reads the last completed day rather than waiting for an in-window
  settlement, which would stall the run for up to a funding interval. An empty result is not a
  failure (an account that held no position across a settlement legitimately has no rows); a
  malformed row is.
- **Real 429 induction is unsafe** — same reasoning as Binance (a shared testnet). The
  `error-taxonomy` check asserts the `retCode` mapping table plus a live typed `NotFound`, and
  documents the rate-limit half as a skip.
- **`order-path` skips on an unfunded account** (`free < min USDT`), since a far-from-market
  limit order still needs margin.

## OKX (demo trading)

`npm run test:testnet -- --venue okx` (task 0430). Credentials: `OKX_TESTNET_API_KEY` /
`_API_SECRET` / **`OKX_TESTNET_PASSPHRASE`** — all three, because OKX signs with a passphrase.
Absent any of them the whole suite skips and exits 0, exactly like the other two venues.

**RUN LIVE against a real demo account: 8/8 passed, 0 failed, 0 skipped, flat at exit.**
What follows is what actually fired, not a designed path.

- **There is no OKX testnet.** Demo trading is a *flag* on the production account
  (`demoTrading: true` natively, `setSandboxMode(true)` in ccxt) — same keys, same REST host,
  only the WS host differs (`wspap` vs `ws`). The `testnet:` block in `config/exchanges.yaml`
  records that rather than a separate domain.
- **The demo account initially sat on account level `1` (spot mode), which cannot be upgraded
  via the API.** Isolated-margin *swap* orders need level `2` (spot-and-futures); level `1`
  rejects every derivative order with `51010 "You can't complete this request under your
  current account mode"`, and both `POST /api/v5/account/set-account-level` and the
  `/account-level-switch-preset` variant answer `51070 "You do not meet the requirements for
  switching to this account mode. Please upgrade your account mode on the OKX website or
  app."` — `account-setup` and `order-path` skipped with the level named on that first run.
  Flipping the demo account to *Spot and futures* mode in the OKX UI (a manual, human-only
  step — confirmed unfixable from the API) turned both green on the next run: `account-setup`
  applied one-way/isolated/5x leverage and read `acctLv: '2'`, `posMode: 'net_mode'` back;
  `order-path` placed a real `0.01`-contract (`ctVal 0.01` BTC-USDT-SWAP, ~$626 notional) limit
  order, observed `OPEN`, resubmitted the same `clientOrderId` idempotently, cancelled,
  observed `CANCELLED`, and got a typed `OrderRejected` on a sub-minimum order. This is an
  account property, not an adapter bug — the same code path is exercised offline by
  `test/unit/adapters/exchanges/okx/{account-setup,ws-orders}.test.ts`.
- **The WS trade API now requires the numeric `instIdCode`.** OKX deprecated the string
  `instId` there in March 2026; a submit carrying only `instId` comes back
  `50014 "Parameter instIdCode can not be empty"`. The adapter indexes `instId → instIdCode`
  off the same `loadMarkets()` call (`adapter.ts`) and the transport sends both. REST still
  takes `instId` alone, so the REST fallback was unaffected.
- **The SDK's WS-API client logs in twice and OKX kills the socket for it.** `okx-api@3.2.1`
  sends a login from its on-connect hook *and* from `sendWSAPIRequest`'s
  `assertIsAuthenticated`; the second one gets
  `60031 "The WebSocket endpoint does not allow multiple or repeated logins"`, the venue closes
  the connection, and the client enters a reconnect loop in which **every order times out**
  (`WsTimeout`, then the venue never sees it). Fixed by constructing that client with
  `authPrivateConnectionsOnConnect: false` (`factory.ts`) — it subscribes to no topics, so the
  single login `sendWSAPIRequest` awaits is the correct one. The private *stream* client keeps
  the default (it needs auth before its topic subscriptions) and authenticated cleanly.
- **`type` is ccxt's reserved market-type key.** Passing OKX's bill type as
  `fetchLedger(…, { type: '8' })` reaches the venue as `instType=8` →
  `51000 "Parameter instType error"`. `fundingIncome` therefore filters bill type on the rows,
  not in the request. Read over a historical 24 h window (as on Bybit), never waiting for an
  in-window settlement; an empty result is not a failure.
- **Funding-fee delivery on the private WS is still the one genuine unknown.** OKX has no
  funding channel: the adapter maps `balance_and_position` + `eventType: 'funding_fee'` and
  infers the amount from the `cashBal` delta. The demo account held no position across a
  settlement during the run, so nothing fired; the REST bills read (`fundingIncome`) is the
  documented fallback and is the money truth on this venue.
- **Both public channels fire.** Unlike Bybit's single fused `tickers` topic, `funding-rate`
  and `tickers` are independent per-symbol subscriptions, and `streams` observed a
  `FundingPredicted` **and** a `MarketTick` for BTC within a few seconds.
- **Real 429 induction is unsafe** — same reasoning as the other two venues, and more so here:
  demo trading rides the production rate limiter. `error-taxonomy` asserts the code table
  across all three arrival shapes plus a live typed `NotFound` (cancel of a never-placed
  `clOrdId` → `51400`), and documents the rate-limit half as a skip.

## Bitget (UTA demo trading)

`npm run test:testnet -- --venue bitget` (task 0440). Credentials: `BITGET_TESTNET_API_KEY` /
`_API_SECRET` / **`BITGET_TESTNET_PASSPHRASE`** — all three, as on OKX. Absent any of them the
whole suite skips and exits 0.

**RUN LIVE against a real demo account: 8/8 passed, 0 failed, 0 skipped, flat at exit**
(three consecutive green runs). What follows is what actually fired, not a designed path.

- **There is no Bitget testnet, and demo is not the `SUSDT-FUTURES` product either.** Demo
  trading is a header (`PAPTRADING: 1`, ccxt `setSandboxMode(true)` / `demoTrading: true`) on
  the *production* REST host; only the WS host differs (`wspap`). The `SUSDT-FUTURES` product
  type (3 symbols settled in `SUSDT`) belongs to the **v2 mix** API and is rejected outright by
  v3 (`40034`). On v3/UTA the demo account trades the ordinary `USDT-FUTURES` category — 24
  symbols, `BTCUSDT` among them — so nothing downstream branches on demo vs live. Demo keys are
  demo-only: the live host answers them `40099`.
- **The account-level margin switch works from the API here** — the one unknown 0440 carried in.
  The demo sub-account came up `accountLevel: 'basic'`, `holdMode: 'hedge_mode'`;
  `POST /api/v3/account/adjust-mode {mode:'isolated'}` and
  `POST /api/v3/account/set-hold-mode {holdMode:'one_way_mode'}` both answered `00000` and the
  read-back showed `isolated` / `one_way_mode`. So Bitget is unlike Bybit (account-wide but
  fine) *and* unlike OKX (privileged, UI-only): a plain write. `account-setup` still treats a
  refusal as a skip-with-reason plus read-back, because isolation ultimately rests on the
  per-order `marginMode: 'isolated'` every submit states.
- **Applied leverage has no dedicated read endpoint.** It comes back on
  `getAccountSettings().symbolConfigList` — one row per symbol carrying `marginMode` and
  `leverage` (and `longLeverage`/`shortLeverage`). The row only appears **after** the first
  `set-leverage`, so its absence is itself the "the write did not land" signal.
- **The native REST throw nests the venue code.** `RestClientV3` rejects with a plain object
  (not an `Error`) shaped `{code: 400, message: 'Bad Request', body: {code: '25204', msg: …}}` —
  the top-level `code` is the **HTTP status**. The first `error-map.ts` read it and classified
  every REST rejection as one retryable `NetworkError`; `body.code` now wins, and `String(err)`
  is never used for the message (it would be `[object Object]`). The thrown object also carries
  `requestOptions.apiKey` — never log a raw Bitget error.
- **The WS trade API answers in a different code space than REST.** Same venue, same operation:
  a tick-grid violation is `43028` on the WS-API and `25244` on REST; a never-placed cancel is
  `25204` on both; a duplicate `clientOid` is `50060`; below-minimum quantity `45111`; below
  minimum order value `43027`; position-tier breach `40763`. All are tabled now; anything
  untabled stays a logged retryable `NetworkError`.
- **The core's tick rounding needs adapter-side serialization.** `roundPrice` produces
  `62785.700000000004` for a 0.1 tick (binary float), and `String()`-ing that got the order
  rejected `43028 "Please enter an integer multiple of 0.1 for price"`. `ws-orders.ts`
  serializes price/qty through `Number(v.toPrecision(12))`. Nothing in `src/core/` changed.
- **The SDK's on-connect login races the socket.** `bitget-api@3.2.1` fires its private login
  from `onWsOpen` and it can hit `readyState 0 (CONNECTING)` ("WebSocket is not open"), after
  which the socket closes and reconnects; during one run that churn burned a submit's entire
  retry budget (`WsTimeout` ×3, and `ws_order_rest_fallback` is off for this venue). Fixed the
  OKX way: the WS-API order client is constructed with `authPrivateConnectionsOnConnect: false`
  (it subscribes to no topics, so the login `sendWSAPIRequest` performs on first use is the
  right one). The private *stream* client keeps auth-on-connect — that is what gates its topic
  subscriptions. No churn observed since.
- **The published rate-limit sizing was wrong by a hair, and the check caught it.** 1800/min at
  a 33 % reserve puts the general lane at 20.1/s, *over* the venue's 20/s read cap. Now
  1700/min at 35 %: order 595/min ≈ 9.9/s, general 1105/min ≈ 18.4/s.
- **One fused public channel.** `ticker` carries last price *and* funding rate + next funding
  time (Bybit's shape, not OKX's two channels), and `streams` saw both a `FundingPredicted` and
  a `MarketTick` for BTC within seconds.
- **The UTA private topics push nothing on a quiet account.** A passive 20 s subscription to
  `order`/`fill`/`position`/`account` captured **zero** frames, so `capture-bitget.ts`'s
  `private-ws` set now places and cancels one far-from-market limit inside the window; the
  fixture holds the `position`/`account` snapshots plus the `order` new/cancelled rows.
- **Funding-fee delivery is still unconfirmed live** — the same gap as OKX. Bitget has no
  funding channel at all; the adapter infers the credit from the `account` balance delta, and
  REST `fetchFundingHistory` (a real ccxt UTA branch, no bill-type filter needed) is the money
  truth. The demo account held no position across a settlement during the runs, so `deltas`
  exercised the REST read over a historical 24 h window and got zero rows — not a failure.
- **Real 429 induction is unsafe** (demo rides the production limiter), so `error-taxonomy`
  asserts the table across all three arrival shapes plus a live typed `NotFound`
  (cancel of a never-placed `clientOid` → `25204`) and documents the rate-limit half as a skip.

## KuCoin (futures — **no testnet exists**)

The one venue with no non-production environment at all, which is why its tier
(`npm run test:testnet -- --venue kucoin`, task 0460) is **read-only against the live host**
rather than a testnet run at all. What that costs, and the traps found on the way:

- **The sandbox is gone, and the SDK lets you believe it isn't.** `ccxt.kucoinfutures` carries
  no `urls.test`, and `setSandboxMode(true)` does **not** throw — it silently sets
  `urls.api = {}`, so the failure surfaces much later as an unrelated URL error. So
  `kucoin/factory.ts` exposes **no** `network` option at all: not a no-op branch, not an option
  that logs — nothing to select. `factory.test.ts` is the regression guard.
- **The tier is read-only by construction, not by convention.** Six checks (`markets`,
  `rateLimiter`, `deltas`, `streams`, `errorTaxonomy`, `assertFlat`); no `orderPath` and no
  `accountSetup`, and no stub files returning `skip` — an absent slot is clearer than a lying
  one. Three checks are rewrites, not copies: `assert-flat` **asserts** and throws for the
  operator instead of flattening (Bitget's version places a reduce-only market order, which
  here would be real money); `error-taxonomy`'s live probe is a `getOrder` **read** rather than
  Bitget's `cancelOrder` write; `rate-limiter`'s arithmetic is against weights, not req/s.
  `git grep 'placeOrder\|cancelOrder\|submitFutures' src/testnet/kucoin/` returning nothing is
  part of the definition of done.
- **The summary type had to widen.** It hard-coded `network: 'testnet'`, so a KuCoin run would
  have claimed a testnet execution while hitting live production with live keys. It is now
  `'testnet' | 'live-readonly'`.
- **The env naming deliberately breaks the convention.** The other four venues read
  `<VENUE>_TESTNET_API_KEY`/`_SECRET`; there is no KuCoin testnet, so that prefix would be a lie
  in a `.env`. The tier reads `KUCOIN_API_KEY` / `_API_SECRET` / `_API_PASSPHRASE` plus an
  explicit `KUCOIN_LIVE_READONLY=1` opt-in, because these are live-money credentials.
- **`private-ws` and `orders` fixtures are hand-authored.** Every sibling driver records them by
  placing one far-from-market limit on a demo account and cancelling it; with no demo account
  that same code is a real order. `capture-kucoin.ts`'s two private set functions therefore
  **throw** with a pointer to the manifests rather than silently no-op.
- **The order path has never been exercised against the venue** — not on a sandbox, not live.
  `ws-orders.ts` and `account-setup.ts` are typechecked against the SDK and unit-tested against
  fixtures, and that is all. Tasks 0470/0480 must not assume otherwise.
- **Ran credentialed: 6/6 against the live host.** What that proves: the universe loads and
  filters (657 linear USDT swaps; `XBTUSDTM` contract size 0.001 BTC; funding cadences 1 h/4 h/8 h
  all present); the weight-budget arithmetic holds; `fundingIncome` reads over a historical window;
  **both** public topics deliver a `FundingPredicted` and a `MarketTick`; the **private** WS
  completes its bullet-private handshake, authenticates and subscribes all three account topics
  before the REST reprime reads; the error taxonomy resolves live; and the account is asserted
  flat. No order was placed and nothing was cancelled.
- **`error-taxonomy` earned its keep on the first credentialed run — it caught a real
  mis-mapping.** KuCoin has **no dedicated order-not-found code**: reading an order the account
  never placed (by `clientOid` *or* by `orderId`) answers HTTP **200** with
  `{ code: '100001', msg: 'error.getOrder.orderNotExist' }`, and `100001` is the venue's generic
  "there are invalid parameters", which the map had tabled — correctly, for its other uses — as
  `OrderRejected`. Two consequences, both now encoded:
  - the discriminator is the **message key**, so `error-map.ts` consults `/orderNotExist/i` ahead
    of the code table, for that one key only. Tabling `100001` as `NotFound` instead would have
    been worse than the bug it fixed: `11` §6 treats a not-found cancel as "already gone,
    reconcile to truth", so every genuine parameter rejection would then be silently swallowed. A
    live `100003` off the venue's dry-run order endpoint confirmed the code really is reused.
  - **the HTTP status is not a signal of failure on this venue.** KuCoin nests the venue code at
    `body.code` with the HTTP status on top, exactly like Bitget — but it answers **200** for
    business rejections, so `body.code`-first ordering is not an optimisation here, it is the only
    thing that classifies these at all.
- **`limits.cost.min` is empty**, as on OKX: KuCoin publishes no per-instrument minimum notional
  through ccxt, so `minNotional` is 0 and the min-order gate rests on `minQty` (1 contract) alone.
- **The keys were IP-allowlisted mid-task**, which yielded the one observation the read-only tier
  cannot produce: an unallowlisted request answers HTTP 403 + `body.code '400006'`, and
  `EXCHANGE=kucoin npm start` surfaced it as a typed `AuthError` — proving the composition root
  reaches KuCoin rather than falling through to Binance.
