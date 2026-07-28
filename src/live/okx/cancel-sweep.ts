/**
 * OKX venue-native cancel sweep (task 0470 phase 3; contract in `../sweep.ts`).
 *
 * Lifted from the testnet `assert-flat`, which already swept by venue id for the same reason
 * this tier needs: `GET /api/v5/trade/orders-pending` scoped to `instType: 'SWAP'` (the whole
 * universe this engine trades) → `POST /api/v5/trade/cancel-order` by `ordId`, so a leftover
 * from an earlier process whose `clOrdId → instId` map is gone still gets cancelled.
 */

import type { OkxClients } from '../../adapters/exchanges/okx/factory.js'
import { type CancelSweep, cancelEach } from '../sweep.js'

/** The universe this engine trades. */
const INST_TYPE = 'SWAP'

export function createOkxCancelSweep(clients: Pick<OkxClients, 'native'>): CancelSweep {
  return async () => {
    const open = (await clients.native.getOrderList({ instType: INST_TYPE })).filter(
      (o) => o.instId !== undefined && o.ordId !== undefined,
    )
    return cancelEach(
      open,
      (o) => `${o.instId}#${o.ordId}`,
      (o) => clients.native.cancelOrder({ instId: o.instId, ordId: o.ordId }),
    )
  }
}
