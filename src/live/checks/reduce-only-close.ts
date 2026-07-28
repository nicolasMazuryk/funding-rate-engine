/**
 * `reduce-only-close` — close the position the entry opened, the way the engine closes one
 * (task 0470 phase 6; `11` §6, `13` §4 flatten).
 *
 * A reduce-only market order on the opposite side, sized from **REST ground truth** rather than
 * from what the entry thought it filled, then polled to `FILLED` and confirmed gone from
 * `getPositions()`. This is the leg that proves the cap's reduce-only exemption works against a
 * real venue: the wrapper lets it through untouched (a close must always be possible), and the
 * verdict's realized fee is the *round trip*, entry plus exit, which is what the suite's fee
 * bound is sized for.
 *
 * `assert-flat` still runs after this and still owns the verdict's `verifiedFlat`. The point of
 * closing here rather than leaving it to teardown is that a close is a *behavior under test* —
 * teardown is the safety net, and a safety net that is also the only test proves nothing about
 * the ordinary path.
 */

import { makeClientOrderId } from '../../core/order-id/client-order-id.js'
import type { Side } from '../../core/ports/exchange-adapter.js'
import type { LiveContext } from '../context.js'
import { retryOnClock } from '../poll.js'
import type { LiveCheck } from '../registry.js'
import { requirePreflight } from './preflight.js'
import { submitFailureReason } from './reject-reason.js'

/** Poll attempts, one second apart, for the close to fill and for the venue to show it flat. */
const CLOSE_ATTEMPTS = 15

export const reduceOnlyCloseCheck: LiveCheck = {
  name: 'reduce-only-close',
  specRef: '13 §4 flatten / 11 §6',
  async run(ctx: LiveContext) {
    const skip = requirePreflight(ctx)
    if (skip !== undefined) return skip

    const fill = ctx.state.fill
    if (fill === undefined) return { status: 'skip', reason: 'no entry fill to close' }

    // Ground truth, not the entry's own report: a partial or a venue-side rounding would
    // otherwise send a close for a quantity that does not exist.
    const position = (await ctx.adapter.getPositions()).find((p) => p.symbol === fill.symbol && p.qty > 0)
    if (position === undefined) return { status: 'skip', reason: `${fill.symbol} is already flat at the venue` }

    const closeSide: Side = position.side === 'long' ? 'short' : 'long'
    // Short for the same reason as the entry's: OKX's escaped `clOrdId` ceiling is 32 chars.
    const clientOrderId = makeClientOrderId({ intentId: `lc-${ctx.clock.now()}`, leg: 'exit', attempt: 1 })

    const ack = await ctx.adapter.placeOrder({
      symbol: fill.symbol,
      side: closeSide,
      type: 'market',
      qty: position.qty,
      clientOrderId,
      reduceOnly: true,
    })
    if (!ack.accepted) {
      // A cap refusal here would mean the reduce-only exemption itself is broken, which is why
      // the reason is quoted rather than summarized.
      throw new Error(
        `the reduce-only close of ${position.qty} ${fill.symbol} was not accepted — ` +
          submitFailureReason(ctx, clientOrderId),
      )
    }

    const closed = await retryOnClock(
      ctx.clock,
      async () => {
        const order = await ctx.adapter.getOrder(clientOrderId)
        if (order.status !== 'FILLED') throw new Error(`expected FILLED close, got ${order.status}`)
        return order
      },
      CLOSE_ATTEMPTS,
    )
    const closeFeeUsd = closed.fee ?? 0
    ctx.state.feesUsd += closeFeeUsd

    await retryOnClock(
      ctx.clock,
      async () => {
        const still = (await ctx.adapter.getPositions()).find((p) => p.symbol === fill.symbol && p.qty > 0)
        if (still !== undefined) throw new Error(`${fill.symbol} still shows ${still.qty} after the close filled`)
      },
      CLOSE_ATTEMPTS,
    )

    return {
      status: 'pass',
      detail: {
        symbol: fill.symbol,
        closeSide,
        qty: position.qty,
        closePx: closed.fillPx,
        closeFeeUsd,
        roundTripFeeUsd: ctx.state.feesUsd,
      },
    }
  },
}
