/**
 * Assert-flat check (`17` §3 cleanup). Runs **last** in the registry: cancels any open order
 * and flattens any open position left over from an earlier check's failure, then asserts the
 * account is flat and orderless at exit. Previews the live tier's auto-flatten (0470).
 *
 * Bitget specifics: the sweep goes through the native `RestClientV3`
 * (`GET /api/v3/trade/unfilled-orders` → `POST /api/v3/trade/cancel-order`) by **`orderId`**,
 * not by client id — a leftover order may have been placed by an earlier process, and the
 * venue's own order id needs no map. Both calls are scoped to the `USDT-FUTURES` category,
 * the whole universe this engine trades (demo trading serves the same category, just fewer
 * symbols).
 */

import { makeClientOrderId } from '../../../core/order-id/client-order-id.js'
import type { BitgetTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** The universe this engine trades — the scope of both the order sweep and the flat assertion. */
const CATEGORY = 'USDT-FUTURES' as const

export const assertFlatCheck: Check<BitgetTestnetContext> = {
  name: 'assert-flat',
  specRef: '17 §3 cleanup',
  async run(ctx) {
    if (!ctx.hasCredentials) return { status: 'skip', reason: 'no credentials' }

    const openOrders = (await ctx.clients.native.getUnfilledOrders({ category: CATEGORY })).data?.list ?? []
    for (const o of openOrders) {
      if (o.orderId === undefined) continue
      await ctx.clients.native.cancelOrder({ category: CATEGORY, orderId: o.orderId })
    }

    const positions = await ctx.adapter.getPositions()
    for (const p of positions) {
      if (p.qty > 0) {
        await ctx.adapter.placeOrder({
          symbol: p.symbol,
          side: p.side === 'long' ? 'short' : 'long',
          type: 'market',
          qty: p.qty,
          reduceOnly: true,
          clientOrderId: makeClientOrderId({ intentId: `tn-flat-${ctx.clock.now()}`, leg: 'exit', attempt: 1 }),
        })
      }
    }

    const stillOpen = await ctx.adapter.getPositions()
    if (stillOpen.some((p) => p.qty > 0)) {
      throw new Error(`account not flat at suite end: ${JSON.stringify(stillOpen)}`)
    }
    const stillResting = (await ctx.clients.native.getUnfilledOrders({ category: CATEGORY })).data?.list ?? []
    if (stillResting.length > 0) {
      throw new Error(`account not orderless at suite end: ${JSON.stringify(stillResting)}`)
    }

    return { status: 'pass', detail: { flat: true, orderless: true } }
  },
}
