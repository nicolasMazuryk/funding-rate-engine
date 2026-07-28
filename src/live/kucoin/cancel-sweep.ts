/**
 * KuCoin venue-native cancel sweep (task 0470 phase 3; contract in `../sweep.ts`).
 *
 * The one venue with no testnet sweep to lift: its read-only tier (task 0460) deliberately
 * *asserts* flat and never cancels, because that tier runs against a live account it does not
 * own. This tier does own its sub-account, so it cancels — but by the venue's own `orderId`
 * (`POST /api/v1/orders/{orderId}` via `cancelOrderById`), never by `clientOid`, whose cancel
 * endpoint additionally requires the symbol.
 *
 * The open-order read goes through ccxt (`fetchOpenOrders()`, account-wide) rather than the
 * native client, matching the adapter's own `getOpenOrders` path on this venue.
 */

import type { KucoinClients } from '../../adapters/exchanges/kucoin/factory.js'
import { type CancelSweep, cancelEach } from '../sweep.js'

export function createKucoinCancelSweep(clients: Pick<KucoinClients, 'ccxt' | 'native'>): CancelSweep {
  return async () => {
    const open = (await clients.ccxt.fetchOpenOrders()).filter((o) => o.id !== undefined)
    return cancelEach(
      open,
      (o) => `${o.symbol ?? '?'}#${o.id}`,
      (o) => clients.native.cancelOrderById({ orderId: o.id as string }),
    )
  }
}
