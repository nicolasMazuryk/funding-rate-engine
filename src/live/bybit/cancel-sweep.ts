/**
 * Bybit venue-native cancel sweep (task 0470 phase 3; contract in `../sweep.ts`).
 *
 * Reads resting orders off the native `RestClientV5` (`GET /v5/order/realtime`, scoped by
 * `settleCoin: 'USDT'` — the whole linear-perp universe this engine trades, and the way to ask
 * account-wide without naming a symbol) and cancels each by the venue's **`orderId`**, not the
 * `orderLinkId` the testnet `assert-flat` used: a leftover may predate this process.
 *
 * The cursor is not walked. A live sub-account under a 50 USD exposure cap cannot hold a page
 * of orders; if it somehow does, the teardown's REST verification fails and says so.
 */

import type { BybitClients } from '../../adapters/exchanges/bybit/factory.js'
import { type CancelSweep, cancelEach } from '../sweep.js'

/** The universe this engine trades — USDT-settled linear perps. */
const CATEGORY = 'linear' as const
const SETTLE_COIN = 'USDT'

export function createBybitCancelSweep(clients: Pick<BybitClients, 'native'>): CancelSweep {
  return async () => {
    const response = await clients.native.getActiveOrders({ category: CATEGORY, settleCoin: SETTLE_COIN })
    const open = response.result?.list ?? []
    return cancelEach(
      open,
      (o) => `${o.symbol}#${o.orderId}`,
      (o) => clients.native.cancelOrder({ category: CATEGORY, symbol: o.symbol, orderId: o.orderId }),
    )
  }
}
