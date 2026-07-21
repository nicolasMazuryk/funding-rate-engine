/**
 * Streams check (`17` §3 bullet 4, `10` §7 / `11` §7; folds
 * `binance-public-ws.integration.test.ts` + `binance-private-ws.integration.test.ts`).
 *
 * Public: subscribes BTC funding + ticks and asserts ≥1 `FundingPredicted` and ≥1
 * `MarketTick` land on the bus within a generous bounded wait (testnets are slower and
 * flakier than prod, spec `0000` "expertise notes" — bounded waits, not fixed sleeps).
 *
 * Private (credentialed): subscribes the user-data stream, then exercises the REST
 * reprime path directly (`getBalance`/`getPositions`) the reconnect FSM invokes on
 * reconnect — deterministic, not a live socket-yank.
 *
 * Funding-fee settlement rarely lands in-window on testnet, so it is not asserted here
 * (documented divergence, `docs/testnet-notes.md`).
 */

import type { BinanceTestnetContext } from '../../context.js'
import { withTimeout } from '../../runner.js'
import type { Check } from '../../types.js'

const PUBLIC_WAIT_MS = 20_000
const POLL_MS = 250

/** Resolve once both event kinds for BTC have landed within `timeoutMs`, else reject. */
function awaitBtcFeeds(ctx: BinanceTestnetContext, timeoutMs: number): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const started = ctx.clock.now()
      const poll = setInterval(() => {
        const funding = ctx.events.some((e) => e.type === 'FundingPredicted' && e.symbol === 'BTC')
        const tick = ctx.events.some((e) => e.type === 'MarketTick' && e.symbol === 'BTC')
        if (funding && tick) {
          clearInterval(poll)
          resolve()
          return
        }
        if (ctx.clock.now() - started > timeoutMs) {
          clearInterval(poll)
          reject(new Error(`timed out waiting for BTC feeds; saw ${ctx.events.length} events`))
        }
      }, POLL_MS)
    }),
    timeoutMs + POLL_MS,
    'streams: public feed wait',
  )
}

export const streamsCheck: Check<BinanceTestnetContext> = {
  name: 'streams',
  specRef: '17 §3 streams',
  async run(ctx) {
    await ctx.adapter.streams.public.subscribe(['BTC'])
    await ctx.adapter.streams.public.subscribeTicks(['BTC'])
    ctx.onCleanup(async () => {
      await ctx.adapter.streams.public.unsubscribeTicks(['BTC'])
    })
    await awaitBtcFeeds(ctx, PUBLIC_WAIT_MS)

    if (!ctx.hasCredentials) {
      return { status: 'pass', detail: { public: true, private: 'skipped (no credentials)' } }
    }

    await ctx.adapter.streams.private.subscribe()

    // Reconnect re-prime path: invoke the same REST reads the reconnect FSM calls,
    // directly and deterministically rather than yanking the live socket.
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

    return { status: 'pass', detail: { public: true, private: true } }
  },
}
