/**
 * Streams check (`17` §3 bullet 4, `10` §7 / `11` §7).
 *
 * Public — the Bitget-specific assertion: the venue **fuses** what OKX splits. One
 * `ticker` topic per symbol carries the last price *and* the funding rate + next funding time
 * (Bybit's shape), so `subscribe` and `subscribeTicks` share one subscription and **both**
 * event kinds must land off it. Frames are full snapshots rather than deltas, but an absent
 * or empty field must still never publish a zero, which is why both kinds are awaited rather
 * than just counting frames.
 *
 * Private (credentialed): subscribes the account stream, then exercises the REST reprime path
 * directly (`getBalance`/`getPositions`) the reconnect FSM invokes on reconnect —
 * deterministic, not a live socket-yank. Bitget publishes **no funding-fee channel** at all
 * (the adapter infers the credit from the `account` balance delta, with REST
 * `fetchFundingHistory` as the money truth), so there is nothing to await here — that gap is a
 * recorded venue delta, not a check.
 */

import type { BitgetTestnetContext } from '../../context.js'
import { withTimeout } from '../../runner.js'
import type { Check } from '../../types.js'

/** The `ticker` topic pushes on every trade, so this window is generous rather than tight. */
const PUBLIC_WAIT_MS = 30_000
const POLL_MS = 250
const SYMBOL = 'BTC'

/** Resolve once both event kinds for BTC have landed within `timeoutMs`, else reject. */
function awaitBothSignals(ctx: BitgetTestnetContext, timeoutMs: number): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const started = ctx.clock.now()
      const poll = setInterval(() => {
        const funding = ctx.events.some((e) => e.type === 'FundingPredicted' && e.symbol === SYMBOL)
        const tick = ctx.events.some((e) => e.type === 'MarketTick' && e.symbol === SYMBOL)
        if (funding && tick) {
          clearInterval(poll)
          resolve()
          return
        }
        if (ctx.clock.now() - started > timeoutMs) {
          clearInterval(poll)
          reject(
            new Error(
              `timed out waiting for both public signals (funding=${funding}, tick=${tick}); saw ${ctx.events.length} events`,
            ),
          )
        }
      }, POLL_MS)
    }),
    timeoutMs + POLL_MS,
    'streams: public feed wait',
  )
}

export const streamsCheck: Check<BitgetTestnetContext> = {
  name: 'streams',
  specRef: '17 §3 streams',
  async run(ctx) {
    // One topic, two logical subscriptions — the venue divergence under test.
    await ctx.adapter.streams.public.subscribe([SYMBOL])
    await ctx.adapter.streams.public.subscribeTicks([SYMBOL])
    ctx.onCleanup(async () => {
      await ctx.adapter.streams.public.unsubscribeTicks([SYMBOL])
    })
    await awaitBothSignals(ctx, PUBLIC_WAIT_MS)

    if (!ctx.hasCredentials) {
      return { status: 'pass', detail: { public: 'ticker — one fused channel', private: 'skipped' } }
    }

    await ctx.adapter.streams.private.subscribe()

    // Reconnect re-prime path: invoke the same REST reads the reconnect FSM calls, directly
    // and deterministically rather than yanking the live socket.
    const balance = await ctx.adapter.getBalance()
    if (balance.asset !== 'USDT' || !Number.isFinite(balance.free) || !Number.isFinite(balance.used)) {
      throw new Error(`private reprime: malformed balance read ${JSON.stringify(balance)}`)
    }
    const positions = await ctx.adapter.getPositions()
    for (const p of positions) {
      if (typeof p.symbol !== 'string' || (p.side !== 'long' && p.side !== 'short') || !Number.isFinite(p.qty)) {
        throw new Error(`private reprime: malformed position read ${JSON.stringify(p)}`)
      }
    }

    return { status: 'pass', detail: { public: 'ticker — one fused channel', private: true } }
  },
}
