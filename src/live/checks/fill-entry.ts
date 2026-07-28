/**
 * `fill-entry` — the first live check that deliberately **spends** money (task 0470 phase 6;
 * `11` §6 order FSM, `15` §2 fills dimension).
 *
 * Everything before this tier could only prove that an order was *accepted*: sim fills are
 * modelled, testnet fills are fake money, and `self-test` cancels before the book can reach it.
 * This check submits a **marketable limit** — priced through the ask by `./symbol.ts`, so it is
 * still a priced order the cap binds on, unlike a market order the wrapper would have to refuse
 * as unpriceable — and asserts the venue reports a real `fillPx` and a real `fee`.
 *
 * A suite whose symbol is chosen for something other than liquidity (`funding-test` takes
 * whatever pays the most negative funding) can find a spread wider than its cross, so the entry
 * walks an **escalating ladder**: cancel, re-read last, cross harder, resubmit. Each rung is a
 * fresh `clientOrderId`, and the previous order is cancelled before the next goes out — two live
 * orders on one symbol could both fill and leave double the intended position.
 *
 * A missing fee is a **failure**, not a shrug: `feesUsd` is what the verdict checks against the
 * suite bound and what `15` §2 reconciles against, so a venue whose `getOrder` omits it is an
 * adapter gap this tier exists to find. The fill is recorded on the run state *before* that
 * assertion, so a fee-less fill still hands the close check something to flatten.
 *
 * The position tracker is built here rather than in the check that reads it: it consumes the
 * private stream's `PositionUpdate`, which is published while this order fills.
 */

import { makeClientOrderId } from '../../core/order-id/client-order-id.js'
import type { Order } from '../../core/ports/exchange-adapter.js'
import type { LiveContext, LiveFill } from '../context.js'
import { orderNotionalUsd } from '../notional.js'
import { retryOnClock } from '../poll.js'
import type { LiveCheck } from '../registry.js'
import { requireFundingWindow } from './funding-window.js'
import { ensurePositionTracker } from './position.js'
import { requirePreflight } from './preflight.js'
import { submitFailureReason } from './reject-reason.js'
import { ensurePickedSymbol, suiteEntryFactors, suitePrice } from './symbol.js'

/**
 * How long to wait for the fill, as poll attempts one second apart. A marketable order at these
 * sizes fills in milliseconds; the budget is for the venue's *read* to show it, not for the book
 * to reach the price. `PARTIAL` is not accepted — a partial capped order would leave a dust
 * position whose close is more expensive than the fill it proves.
 */
const FILL_ATTEMPTS = 15

/** Assert the venue's own report of the fill, and return it as the run's money truth. */
function readFill(order: Order, symbol: string, feeUsd: number): LiveFill {
  const { fillPx, qty } = order
  if (fillPx === undefined || !Number.isFinite(fillPx) || fillPx <= 0) {
    throw new Error(`${symbol} filled but reported no usable fill price: ${String(fillPx)}`)
  }
  if (qty === undefined || !Number.isFinite(qty) || qty <= 0) {
    throw new Error(`${symbol} filled but reported no usable filled quantity: ${String(qty)}`)
  }
  return { symbol, qty, fillPx, feeUsd }
}

export const fillEntryCheck: LiveCheck = {
  name: 'fill-entry',
  specRef: '11 §6 order FSM / 15 §2 fills',
  async run(ctx: LiveContext) {
    const skip = requirePreflight(ctx) ?? requireFundingWindow(ctx)
    if (skip !== undefined) return skip

    const pick = await ensurePickedSymbol(ctx)
    await ensurePositionTracker(ctx)

    // Short on purpose: OKX escapes every hyphen into two characters and caps `clOrdId` at 32,
    // so a `live-fill-<ms>-entry-1` id encodes to 35 and is refused before it leaves the process
    // (observed live, 0470 §6). `lf-<ms>-entry-1` encodes to 27.
    const intentId = `lf-${ctx.clock.now()}`
    const resting = new Set<string>()
    ctx.onCleanup(async () => {
      for (const id of resting) {
        try {
          await ctx.adapter.cancelOrder(id)
        } catch {
          // Best-effort: an order that filled, or never rested, has nothing to cancel.
        }
      }
    })

    const factors = suiteEntryFactors(ctx.suite)
    let filled: Order | undefined
    let clientOrderId = ''
    let price = pick.price
    for (let attempt = 0; attempt < factors.length && filled === undefined; attempt++) {
      // Re-read last on every retry: the first attempt failed either because the spread was
      // wider than its cross or because the market moved, and both are answered by re-anchoring.
      if (attempt > 0) price = suitePrice(ctx, pick.instrument, await ctx.lastPrice(pick.symbol), attempt)
      clientOrderId = makeClientOrderId({ intentId, leg: 'entry', attempt: attempt + 1 })

      const ack = await ctx.adapter.placeOrder({
        symbol: pick.symbol,
        side: 'long',
        type: 'limit',
        qty: pick.qty,
        price,
        clientOrderId,
      })
      if (!ack.accepted) {
        throw new Error(
          `the ${pick.notionalUsd.toFixed(2)} USD ${pick.symbol} marketable order was not accepted — ` +
            submitFailureReason(ctx, clientOrderId),
        )
      }
      resting.add(clientOrderId)

      filled = await retryOnClock(
        ctx.clock,
        async () => {
          const order = await ctx.adapter.getOrder(clientOrderId)
          if (order.status !== 'FILLED') throw new Error(`expected FILLED, got ${order.status}`)
          return order
        },
        FILL_ATTEMPTS,
      ).catch((err: unknown) => {
        // Not fatal while a deeper cross is still available — but the last one's failure is.
        if (attempt === factors.length - 1) throw err
        ctx.log('entry did not fill, crossing deeper', {
          symbol: pick.symbol,
          attempt: attempt + 1,
          price,
          error: err instanceof Error ? err.message : String(err),
        })
        return undefined
      })

      if (filled === undefined) {
        // Cancel before re-submitting: two live orders on the same symbol could both fill and
        // leave double the intended position on the venue.
        try {
          await ctx.adapter.cancelOrder(clientOrderId)
          resting.delete(clientOrderId)
        } catch {
          // Left in `resting` for the cleanup sweep — it may have filled in the meantime.
        }
      }
    }
    if (filled === undefined) throw new Error(`${pick.symbol} never filled across ${factors.length} attempts`)
    resting.delete(clientOrderId)

    // Record before asserting the fee: the position exists on the venue either way, and the
    // close check needs to know about it even when this check is about to fail.
    const fill = readFill(filled, pick.symbol, filled.fee ?? 0)
    ctx.state.fill = fill
    ctx.state.feesUsd += fill.feeUsd

    if (filled.fee === undefined || !Number.isFinite(filled.fee)) {
      throw new Error(
        `${ctx.venue} filled ${pick.symbol} but reported no realized fee — the adapter cannot ` +
          `reconcile this fill (15 §2); fee was ${String(filled.fee)}`,
      )
    }

    return {
      status: 'pass',
      detail: {
        symbol: fill.symbol,
        qty: fill.qty,
        limitPrice: price,
        entryAttempts: factors.length,
        fillPx: fill.fillPx,
        feeUsd: fill.feeUsd,
        // Same conservative reading the cap applied at submit, now against the realized fill.
        notionalUsd: orderNotionalUsd(
          { symbol: fill.symbol, side: 'long', type: 'limit', qty: fill.qty, price: fill.fillPx, clientOrderId },
          pick.instrument,
        ),
      },
    }
  },
}
