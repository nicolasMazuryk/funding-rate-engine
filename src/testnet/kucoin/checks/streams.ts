/**
 * Streams check (`17` §3 bullet 4, `10` §7 / `11` §7). Read-only throughout: subscribing is a
 * read, and the private half only re-primes via REST reads.
 *
 * Public — the KuCoin-specific assertion: the venue **splits** what Bybit and Bitget fuse, but
 * not the way OKX does. `/contract/instrument:<SYM>` multiplexes two subjects and only
 * `funding.rate` is mapped (→ `FundingPredicted`); the last traded price arrives on a second
 * topic, `/contractMarket/ticker:<SYM>` (→ `MarketTick`). So `subscribe` and `subscribeTicks`
 * open two independent topics and **both** event kinds must land on the bus. The two topics also
 * disagree on time units (ticker `ts` is nanoseconds, the funding frame's `timestamp` is ms), so
 * the tick's timestamp is sanity-checked here rather than just counted.
 *
 * Private (credentialed): subscribes the account stream, then exercises the REST reprime path
 * the reconnect FSM invokes (`getBalance`/`getPositions`) — deterministic, not a live
 * socket-yank, and on this venue also the only safe option: there is nothing to write.
 */

import type { KucoinLiveContext } from '../../context.js'
import { withTimeout } from '../../runner.js'
import type { Check } from '../../types.js'

/** `funding.rate` pushes only when the predicted rate moves, so the window is generous. */
const PUBLIC_WAIT_MS = 30_000
const POLL_MS = 250
const SYMBOL = 'BTC'

/** A `MarketTick` ts more than this far from now means the ns→ms scaling mis-fired. */
const TICK_TS_TOLERANCE_MS = 600_000

/** Resolve once both event kinds for BTC have landed within `timeoutMs`, else reject. */
function awaitBothSignals(ctx: KucoinLiveContext, timeoutMs: number): Promise<void> {
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
              `timed out waiting for both public signals (contract/instrument=${funding}, contractMarket/ticker=${tick}); saw ${ctx.events.length} events`,
            ),
          )
        }
      }, POLL_MS)
    }),
    timeoutMs + POLL_MS,
    'streams: public feed wait',
  )
}

export const streamsCheck: Check<KucoinLiveContext> = {
  name: 'streams',
  specRef: '17 §3 streams',
  async run(ctx) {
    // Two topics, two subscriptions — the venue divergence under test. Nothing is shared, so
    // `unsubscribeTicks` can always drop the ticker topic (no refcount, unlike Bybit).
    await ctx.adapter.streams.public.subscribe([SYMBOL])
    await ctx.adapter.streams.public.subscribeTicks([SYMBOL])
    ctx.onCleanup(async () => {
      await ctx.adapter.streams.public.unsubscribeTicks([SYMBOL])
    })
    await awaitBothSignals(ctx, PUBLIC_WAIT_MS)

    // The ns→ms scaling is KuCoin-only and silent when wrong, so the tick's clock is checked.
    const tick = ctx.events.find((e) => e.type === 'MarketTick' && e.symbol === SYMBOL)
    if (
      tick !== undefined &&
      tick.type === 'MarketTick' &&
      Math.abs(ctx.clock.now() - tick.ts) > TICK_TS_TOLERANCE_MS
    ) {
      throw new Error(`MarketTick ts ${tick.ts} is not epoch-ms-near-now — the nanosecond scaling mis-fired`)
    }

    const publicDetail = '/contract/instrument + /contractMarket/ticker, two topics'
    if (!ctx.hasCredentials) {
      return { status: 'pass', detail: { public: publicDetail, private: 'skipped' } }
    }

    await ctx.adapter.streams.private.subscribe()

    // Reconnect re-prime path: the same REST reads the reconnect FSM calls, directly and
    // deterministically. Both are reads — nothing here touches the live account's state.
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

    return { status: 'pass', detail: { public: publicDetail, private: true } }
  },
}
