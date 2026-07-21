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
