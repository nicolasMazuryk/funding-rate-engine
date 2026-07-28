/**
 * `order-lifecycle` — the smallest real order this venue accepts, opened and cancelled
 * (task 0470 phase 4; `11` §5–§6 order FSM).
 *
 * Places one limit buy **inside the venue's price band but far enough below last that it cannot
 * fill within the check's lifetime** (the anchoring the testnet `order-path` checks established:
 * a hard-coded far-from-market price is rejected as out of range on Bybit/OKX/Bitget). Then:
 * `getOrder` → `OPEN` → cancel → `CANCELLED`. No fill is intended here — that is `fill-test`
 * (phase 6) — so the only money at risk is the resting notional, itself under the 25 USD cap.
 *
 * The symbol is picked, not configured (`./symbol.ts` → `../symbol-pick.ts`), and parked on the
 * run state for the later checks. The order it produces is the one the picker priced, so the cap
 * wrapper's estimate at submit is the same number the picker fit under the cap.
 *
 * Registers a cleanup that cancels the resting order on any mid-check throw, so a failure here
 * cannot leak an open order into the account (teardown would catch it too — this is the cheap
 * first line).
 */

import { makeClientOrderId } from '../../core/order-id/client-order-id.js'
import { retry } from '../../testnet/runner.js'
import type { LiveContext } from '../context.js'
import type { LiveCheck } from '../registry.js'
import { requirePreflight } from './preflight.js'
import { submitFailureReason } from './reject-reason.js'
import { ensurePickedSymbol } from './symbol.js'

/** REST reads immediately after a submit/cancel can lag on any venue — retry before failing. */
const READ_ATTEMPTS = 3

export const orderLifecycleCheck: LiveCheck = {
  name: 'order-lifecycle',
  specRef: '11 §5–§6 order FSM',
  async run(ctx: LiveContext) {
    const skip = requirePreflight(ctx)
    if (skip !== undefined) return skip

    const pick = await ensurePickedSymbol(ctx)

    const clientOrderId = makeClientOrderId({ intentId: `live-${ctx.clock.now()}`, leg: 'entry', attempt: 1 })
    let resting = true
    ctx.onCleanup(async () => {
      if (!resting) return
      try {
        await ctx.adapter.cancelOrder(clientOrderId)
      } catch {
        // Best-effort: if it never rested, or is already gone, there is nothing to cancel.
      }
    })

    const ack = await ctx.adapter.placeOrder({
      symbol: pick.symbol,
      side: 'long',
      type: 'limit',
      qty: pick.qty,
      price: pick.price,
      clientOrderId,
    })
    if (!ack.accepted) {
      throw new Error(
        `the ${pick.notionalUsd.toFixed(2)} USD ${pick.symbol} order was not accepted — ` +
          submitFailureReason(ctx, clientOrderId),
      )
    }

    await retry(async () => {
      const order = await ctx.adapter.getOrder(clientOrderId)
      if (order.status !== 'OPEN') throw new Error(`expected OPEN after submit, got ${order.status}`)
    }, READ_ATTEMPTS)

    await ctx.adapter.cancelOrder(clientOrderId)
    resting = false
    await retry(async () => {
      const order = await ctx.adapter.getOrder(clientOrderId)
      if (order.status !== 'CANCELLED') throw new Error(`expected CANCELLED after cancel, got ${order.status}`)
    }, READ_ATTEMPTS)

    return {
      status: 'pass',
      detail: {
        symbol: pick.symbol,
        venueSymbol: pick.venueSymbol,
        qty: pick.qty,
        price: pick.price,
        contractSize: pick.instrument.contractSize,
        notionalUsd: pick.notionalUsd,
      },
    }
  },
}
