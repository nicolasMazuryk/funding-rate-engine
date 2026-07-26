/**
 * Streams check (`17` §3 bullet 4, `10` §7 / `11` §7).
 *
 * Public — the OKX-specific assertion: the venue **splits** what Bybit fuses. There is no
 * all-symbol funding stream (Binance's `!markPrice@arr@1s`) *and* no single topic carrying
 * both signals (Bybit's `tickers.<SYM>`): OKX publishes `funding-rate` → `FundingPredicted`
 * and `tickers` → `MarketTick` as two independent per-`instId` channels. So `subscribe` and
 * `subscribeTicks` really do open two subscriptions here, and this asserts **both** land on
 * the bus. Frames are full snapshots rather than deltas, so the wait can be shorter than
 * Bybit's — but the funding channel only pushes on a rate change, so it is still generous.
 *
 * Private (credentialed): subscribes the account stream, then exercises the REST reprime path
 * directly (`getBalance`/`getPositions`) the reconnect FSM invokes on reconnect —
 * deterministic, not a live socket-yank.
 */

import type { OkxTestnetContext } from '../../context.js'
import { withTimeout } from '../../runner.js'
import type { Check } from '../../types.js'

/** `funding-rate` pushes only when the predicted rate moves, so allow a Bybit-sized window. */
const PUBLIC_WAIT_MS = 30_000
const POLL_MS = 250
const SYMBOL = 'BTC'

/** Resolve once both event kinds for BTC have landed within `timeoutMs`, else reject. */
function awaitBothSignals(ctx: OkxTestnetContext, timeoutMs: number): Promise<void> {
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
              `timed out waiting for both public signals (funding-rate=${funding}, tickers=${tick}); saw ${ctx.events.length} events`,
            ),
          )
        }
      }, POLL_MS)
    }),
    timeoutMs + POLL_MS,
    'streams: public feed wait',
  )
}

export const streamsCheck: Check<OkxTestnetContext> = {
  name: 'streams',
  specRef: '17 §3 streams',
  async run(ctx) {
    // Two channels, two subscriptions — the venue divergence under test. `unsubscribeTicks`
    // can always drop the `tickers` topic because nothing else shares it (no refcount, unlike
    // Bybit).
    await ctx.adapter.streams.public.subscribe([SYMBOL])
    await ctx.adapter.streams.public.subscribeTicks([SYMBOL])
    ctx.onCleanup(async () => {
      await ctx.adapter.streams.public.unsubscribeTicks([SYMBOL])
    })
    await awaitBothSignals(ctx, PUBLIC_WAIT_MS)

    if (!ctx.hasCredentials) {
      return { status: 'pass', detail: { public: 'funding-rate + tickers, two channels', private: 'skipped' } }
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

    return { status: 'pass', detail: { public: 'funding-rate + tickers, two channels', private: true } }
  },
}
