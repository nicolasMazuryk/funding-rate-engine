/**
 * `cap-rejection` — the safety net proving itself against a real venue (task 0470 phase 4).
 *
 * Submits an order deliberately sized ~3× over the per-order cap through the same path every
 * other order takes, and asserts three things: the wrapper refused it in the `failSubmit`
 * dialect (`accepted:false` + a published `OrderUpdate{REJECTED}`), the refusal was recorded,
 * and — the load-bearing one — **the venue never saw it**, verified against the venue's own
 * open-order read rather than against the wrapper's own bookkeeping.
 *
 * This is the check that would catch a future refactor routing around the wrapper: unit tests
 * assert the wrapper rejects, only a live run can assert nothing arrived at the exchange.
 */

import { makeClientOrderId } from '../../core/order-id/client-order-id.js'
import { computeQty } from '../../core/sizing/sizing.js'
import type { LiveContext } from '../context.js'
import { orderNotionalUsd } from '../notional.js'
import type { LiveCheck } from '../registry.js'
import { requirePreflight } from './preflight.js'

/** How far over the per-order cap the deliberately-oversized order aims. */
const OVER_CAP_MULTIPLE = 3

export const capRejectionCheck: LiveCheck = {
  name: 'cap-rejection',
  specRef: '0470 §2 notional cap',
  async run(ctx: LiveContext) {
    const skip = requirePreflight(ctx)
    if (skip !== undefined) return skip

    const pick = ctx.state.symbol
    if (pick === undefined) return { status: 'skip', reason: 'no symbol was picked by order-lifecycle' }

    const targetUsd = OVER_CAP_MULTIPLE * ctx.caps.maxOrderNotionalUsd
    const qty = computeQty(targetUsd, pick.price, pick.instrument)
    const clientOrderId = makeClientOrderId({ intentId: `live-cap-${ctx.clock.now()}`, leg: 'entry', attempt: 1 })
    const req = {
      symbol: pick.symbol,
      side: 'long' as const,
      type: 'limit' as const,
      qty,
      price: pick.price,
      clientOrderId,
    }

    // If the lot step were so coarse that 3× the cap still floors under it, this check would
    // silently place a *legal* order — so refuse to run rather than trade something unintended.
    const estimateUsd = orderNotionalUsd(req, pick.instrument)
    if (!(estimateUsd > ctx.caps.maxOrderNotionalUsd)) {
      throw new Error(
        `could not build an over-cap ${pick.symbol} order: ${estimateUsd.toFixed(2)} USD is still under the ` +
          `${ctx.caps.maxOrderNotionalUsd} USD cap (qty ${qty}, lot step ${pick.instrument.amountPrecision})`,
      )
    }

    const ack = await ctx.adapter.placeOrder(req)
    if (ack.accepted) {
      throw new Error(`the live cap accepted a ${estimateUsd.toFixed(2)} USD order — MANUAL INTERVENTION REQUIRED`)
    }

    const rejection = ctx.adapter.cap.rejections.find((r) => r.clientOrderId === clientOrderId)
    if (rejection === undefined || rejection.kind !== 'cap_order_notional') {
      throw new Error(`expected a cap_order_notional rejection, got ${rejection?.kind ?? 'none'}`)
    }
    const published = ctx.events.find(
      (e) => e.type === 'OrderUpdate' && e.clientOrderId === clientOrderId && e.status === 'REJECTED',
    )
    if (published === undefined) throw new Error('the cap refusal was not published as OrderUpdate{REJECTED}')

    // Ground truth: ask the venue. The wrapper's own state cannot prove nothing was sent.
    const openAtVenue = await ctx.adapter.getOpenOrders(pick.symbol)
    if (openAtVenue.some((o) => o.clientOrderId === clientOrderId)) {
      throw new Error(`the over-cap order reached ${ctx.venue} — MANUAL INTERVENTION REQUIRED`)
    }

    return { status: 'pass', detail: { symbol: pick.symbol, qty, estimateUsd, kind: rejection.kind } }
  },
}
