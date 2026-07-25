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
