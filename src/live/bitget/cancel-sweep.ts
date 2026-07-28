/**
 * Bitget venue-native cancel sweep (task 0470 phase 3; contract in `../sweep.ts`).
 *
 * Lifted from the testnet `assert-flat`, which already swept by venue id: `GET
 * /api/v3/trade/unfilled-orders` → `POST /api/v3/trade/cancel-order` by `orderId`, both scoped
 * to the `USDT-FUTURES` category — the whole universe this engine trades.
 */

import type { BitgetClients } from '../../adapters/exchanges/bitget/factory.js'
import { type CancelSweep, cancelEach } from '../sweep.js'

/** The universe this engine trades. */
const CATEGORY = 'USDT-FUTURES' as const

export function createBitgetCancelSweep(clients: Pick<BitgetClients, 'native'>): CancelSweep {
  return async () => {
    const rows = (await clients.native.getUnfilledOrders({ category: CATEGORY })).data?.list ?? []
    const open = rows.filter((o) => o.orderId !== undefined)
    return cancelEach(
      open,
      (o) => `${o.symbol ?? '?'}#${o.orderId}`,
      (o) => clients.native.cancelOrder({ category: CATEGORY, orderId: o.orderId as string }),
    )
  }
}
