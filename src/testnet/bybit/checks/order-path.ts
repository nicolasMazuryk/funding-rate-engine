/**
 * Order-path check (`17` §3 bullet 3, `11` §5–§6). WS-first place → `getOrder` OPEN →
 * cancel → CANCELLED; a resubmit with the same `clientOrderId` must not blow up the harness
 * (either the venue no-ops it or it maps to a typed `AdapterError` — never a raw throw). A
 * deliberately malformed (sub-minimum) order must surface as a typed `OrderRejected`.
 * Self-checks balance first — skips with reason on an unfunded testnet account.
 *
 * Bybit specifics:
 *  - `clientOrderId` is `orderLinkId`, and `getOrder` resolves it through
 *    `/v5/order/realtime` (`fetchOpenOrders` + `orderLinkId`) — open **and** recently-closed
 *    orders, so the post-cancel CANCELLED read lands in the same window;
 *  - the resting price is anchored to the **live last price**, not a fixed number: Bybit
 *    enforces a price-limit band around the mark, so a Binance-style hard-coded
 *    far-from-market price would be rejected as out of range (`110094`). A few percent below
 *    last is inside any band yet never fills within the check's lifetime.
 *
 * Registers a cleanup that cancels the resting order on any mid-check throw, so a failure
 * here can't leak an open order.
 */

import { AdapterError } from '../../../adapters/shared/errors.js'
import { makeClientOrderId } from '../../../core/order-id/client-order-id.js'
import type { Instrument } from '../../../core/ports/exchange-adapter.js'
import type { BybitTestnetContext } from '../../context.js'
import { retry } from '../../runner.js'
import type { Check } from '../../types.js'

/** The only symbol this suite trades; ccxt's unified name for the price anchor read. */
const SYMBOL = 'BTC'
const CCXT_SYMBOL = 'BTC/USDT:USDT'

/** Resting buy limit at 97 % of last: inside Bybit's price-limit band, never fills in-check. */
const PRICE_FACTOR = 0.97
/** Notional headroom over the venue minimum, so a tick of rounding can't drop us under it. */
const MIN_NOTIONAL_HEADROOM = 1.2
const MIN_FREE_USDT = 10

/** Round up to a multiple of `step`, then trim binary-float dust the string API would reject. */
function quantizeUp(value: number, step: number): number {
  return Number((Math.ceil(value / step) * step).toFixed(10))
}

/** Smallest qty that clears both the venue minimum quantity and the minimum notional. */
function restingQty(inst: Instrument, price: number): number {
  const byNotional = (inst.minNotional * MIN_NOTIONAL_HEADROOM) / price
  return quantizeUp(Math.max(inst.minQty, byNotional), inst.amountPrecision)
}

export const orderPathCheck: Check<BybitTestnetContext> = {
  name: 'order-path',
  specRef: '17 §3 order path',
  async run(ctx) {
    if (!ctx.hasCredentials) return { status: 'skip', reason: 'no credentials' }

    const free = await ctx.getBalanceFree()
    if (free < MIN_FREE_USDT) return { status: 'skip', reason: `unfunded testnet account (free=${free} USDT)` }

    const inst = ctx.adapter.normalize(SYMBOL)
    const ticker = await ctx.clients.ccxt.fetchTicker(CCXT_SYMBOL)
    const last = ticker.last
    if (last === undefined || !Number.isFinite(last) || last <= 0) {
      throw new Error(`no usable last price for ${CCXT_SYMBOL}: ${String(last)}`)
    }
    const price = last * PRICE_FACTOR // the order manager tick-rounds it (`11` §3)
    const qty = restingQty(inst, price)

    const clientOrderId = makeClientOrderId({ intentId: `tn-${ctx.clock.now()}`, leg: 'entry', attempt: 1 })
    let resting = true
    ctx.onCleanup(async () => {
      if (resting) {
        try {
          await ctx.adapter.cancelOrder(clientOrderId)
        } catch {
          // Best-effort: if it never rested, or is already gone, there's nothing to cancel.
        }
      }
    })

    const placed = await ctx.adapter.placeOrder({
      symbol: SYMBOL,
      side: 'long',
      type: 'limit',
      qty,
      price,
      clientOrderId,
    })
    if (!placed.accepted) throw new Error('order was not accepted')

    // Known-slow testnet op: a `getOrder` read immediately after submit can briefly lag, so
    // retry a few times before treating it as a failure.
    await retry(async () => {
      const o = await ctx.adapter.getOrder(clientOrderId)
      if (o.status !== 'OPEN') throw new Error(`expected OPEN after submit, got ${o.status}`)
    }, 3)

    // clientOrderId idempotency: a resubmit must not throw an unmapped/raw error — either
    // the venue treats it as a no-op (accepted) or maps to a typed AdapterError (Bybit answers
    // a duplicate `orderLinkId` with `110072`; `error-map.ts` classifies it, and even an
    // untabled code lands as a typed `NetworkError` rather than a raw throw).
    try {
      await ctx.adapter.placeOrder({ symbol: SYMBOL, side: 'long', type: 'limit', qty, price, clientOrderId })
    } catch (err) {
      if (!(err instanceof AdapterError)) throw new Error(`resubmit threw an unmapped error: ${String(err)}`)
    }

    await ctx.adapter.cancelOrder(clientOrderId)
    resting = false
    // Same known-slow-read lag as the post-submit check above.
    await retry(async () => {
      const cancelled = await ctx.adapter.getOrder(clientOrderId)
      if (cancelled.status !== 'CANCELLED') throw new Error(`expected CANCELLED after cancel, got ${cancelled.status}`)
    }, 3)

    // Malformed (sub-minimum) order must surface as a typed OrderRejected, not accept or
    // throw raw — the order manager rejects pre-submit (`11` §3) and publishes the verdict on
    // the bus rather than throwing, so assert against the published event.
    const badClientOrderId = makeClientOrderId({ intentId: `tn-bad-${ctx.clock.now()}`, leg: 'entry', attempt: 1 })
    const badAck = await ctx.adapter.placeOrder({
      symbol: SYMBOL,
      side: 'long',
      type: 'limit',
      qty: inst.minQty / 10,
      price: 1,
      clientOrderId: badClientOrderId,
    })
    if (badAck.accepted) throw new Error('malformed (sub-minimum) order was accepted, expected a reject')
    const rejectedEvent = ctx.events.find(
      (e) => e.type === 'OrderUpdate' && e.clientOrderId === badClientOrderId && e.status === 'REJECTED',
    )
    if (
      rejectedEvent === undefined ||
      rejectedEvent.type !== 'OrderUpdate' ||
      rejectedEvent.errorKind !== 'OrderRejected'
    ) {
      throw new Error('malformed (sub-minimum) order did not surface as typed OrderRejected')
    }

    return { status: 'pass', detail: { qty, price } }
  },
}
