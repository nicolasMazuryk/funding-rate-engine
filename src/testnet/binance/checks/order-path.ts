/**
 * Order-path check (`17` §3 bullet 3, `11` §5–§6; folds `binance-order.integration.test.ts`).
 * WS-first place → `getOrder` OPEN → cancel → CANCELLED; a resubmit with the same
 * `clientOrderId` must not blow up the harness (idempotency surface — venue-level
 * duplicate handling is exercised, but rides success and typed-rejection cases alike,
 * since Binance itself decides whether a resubmit is a no-op or a duplicate reject).
 * A deliberately malformed (sub-min-notional) order must surface as a typed
 * `OrderRejected`, never a raw/unmapped throw. Self-checks balance first — skips with
 * reason on an unfunded testnet account rather than failing.
 *
 * Registers a cleanup that cancels the resting order on any mid-check throw, so a
 * failure here can't leak an open order (task 0260's fix for the old tests' missing
 * `try/finally`).
 */

import { AdapterError } from '../../../adapters/shared/errors.js'
import { makeClientOrderId } from '../../../core/order-id/client-order-id.js'
import type { BinanceTestnetContext } from '../../context.js'
import { retry } from '../../runner.js'
import type { Check } from '../../types.js'

/** A BTC long limit far below market never fills on testnet; qty × price ≥ 50 (min notional). */
const FAR_FROM_MARKET_PRICE = 20_000
const ORDER_QTY = 0.003
const MIN_FREE_USDT = 10

export const orderPathCheck: Check<BinanceTestnetContext> = {
  name: 'order-path',
  specRef: '17 §3 order path',
  async run(ctx) {
    if (!ctx.hasCredentials) return { status: 'skip', reason: 'no credentials' }

    const free = await ctx.getBalanceFree()
    if (free < MIN_FREE_USDT) return { status: 'skip', reason: `unfunded testnet account (free=${free} USDT)` }

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
      symbol: 'BTC',
      side: 'long',
      type: 'limit',
      qty: ORDER_QTY,
      price: FAR_FROM_MARKET_PRICE,
      clientOrderId,
    })
    if (!placed.accepted) throw new Error('order was not accepted')

    // Known-slow testnet op: a `getOrder` read immediately after submit can briefly lag
    // (`docs/testnet-notes.md`), so retry a few times before treating it as a failure.
    const open = await retry(async () => {
      const o = await ctx.adapter.getOrder(clientOrderId)
      if (o.status !== 'OPEN') throw new Error(`expected OPEN after submit, got ${o.status}`)
      return o
    }, 3)
    void open

    // clientOrderId idempotency: a resubmit must not throw an unmapped/raw error — either
    // the venue treats it as a no-op (accepted) or maps to a typed AdapterError.
    try {
      await ctx.adapter.placeOrder({
        symbol: 'BTC',
        side: 'long',
        type: 'limit',
        qty: ORDER_QTY,
        price: FAR_FROM_MARKET_PRICE,
        clientOrderId,
      })
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

    // Malformed (sub-min-notional) order must surface as a typed OrderRejected, not accept
    // or throw raw — the order manager rejects pre-submit (`11` §3) and publishes the
    // verdict on the bus rather than throwing, so assert against the published event.
    const badClientOrderId = makeClientOrderId({ intentId: `tn-bad-${ctx.clock.now()}`, leg: 'entry', attempt: 1 })
    const badAck = await ctx.adapter.placeOrder({
      symbol: 'BTC',
      side: 'long',
      type: 'limit',
      qty: 0.0001,
      price: 1,
      clientOrderId: badClientOrderId,
    })
    if (badAck.accepted) throw new Error('malformed (sub-min-notional) order was accepted, expected a reject')
    const rejectedEvent = ctx.events.find(
      (e) => e.type === 'OrderUpdate' && e.clientOrderId === badClientOrderId && e.status === 'REJECTED',
    )
    if (
      rejectedEvent === undefined ||
      rejectedEvent.type !== 'OrderUpdate' ||
      rejectedEvent.errorKind !== 'OrderRejected'
    ) {
      throw new Error('malformed (sub-min-notional) order did not surface as typed OrderRejected')
    }

    return { status: 'pass' }
  },
}
