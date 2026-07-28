/**
 * Binance venue-native cancel sweep (task 0470 phase 3; contract in `../sweep.ts`).
 *
 * Reads every resting USD-M order account-wide off the native `USDMClient`
 * (`GET /fapi/v1/openOrders`) and cancels each by the venue's **`orderId`** — unlike the
 * testnet `assert-flat`, which cancelled by `origClientOrderId` and was scoped to BTC. A
 * leftover here may come from an earlier process, so nothing may depend on a client id this
 * process minted, and the sweep may not be scoped to a symbol this run happens to know.
 */

import type { BinanceClients } from '../../adapters/exchanges/binance/factory.js'
import { type CancelSweep, cancelEach } from '../sweep.js'

export function createBinanceCancelSweep(clients: Pick<BinanceClients, 'native'>): CancelSweep {
  return async () => {
    const open = await clients.native.getAllOpenOrders()
    return cancelEach(
      open,
      (o) => `${o.symbol}#${o.orderId}`,
      (o) => clients.native.cancelOrder({ symbol: o.symbol, orderId: o.orderId }),
    )
  }
}
