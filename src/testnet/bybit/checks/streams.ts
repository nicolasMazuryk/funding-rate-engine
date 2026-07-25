/**
 * Streams check (`17` §3 bullet 4, `10` §7 / `11` §7).
 *
 * Public — the Bybit-specific assertion: there is **no all-symbol mark-price stream** (the
 * Binance `!markPrice@arr@1s` analogue does not exist), and instead the **single**
 * `tickers.<SYMBOL>` topic carries `fundingRate`/`nextFundingTime` *and* `lastPrice`. So this
 * subscribes BTC once — `subscribe` opens the topic, `subscribeTicks` only opens the tick
 * gate on the *same* topic (`public-stream.ts` reference-counts it) — and asserts that this
 * one subscription yields **both** a `FundingPredicted` and a `MarketTick` on the bus.
 * Because Bybit pushes deltas after the initial snapshot, either field can be absent from any
 * given frame, so the wait is generous and bounded (never a fixed sleep).
 *
 * Private (credentialed): subscribes the account stream, then exercises the REST reprime path
 * directly (`getBalance`/`getPositions`) the reconnect FSM invokes on reconnect —
 * deterministic, not a live socket-yank.
 */

import type { BybitTestnetContext } from '../../context.js'
import { withTimeout } from '../../runner.js'
import type { Check } from '../../types.js'

/** Deltas can omit either field for a while, so allow a longer window than Binance's 20 s. */
const PUBLIC_WAIT_MS = 30_000
const POLL_MS = 250
const SYMBOL = 'BTC'

/** Resolve once both event kinds for BTC have landed within `timeoutMs`, else reject. */
function awaitBothSignals(ctx: BybitTestnetContext, timeoutMs: number): Promise<void> {
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
              `timed out waiting for both signals off tickers.${SYMBOL} (funding=${funding}, tick=${tick}); saw ${ctx.events.length} events`,
            ),
          )
        }
      }, POLL_MS)
    }),
    timeoutMs + POLL_MS,
    'streams: public feed wait',
  )
}

export const streamsCheck: Check<BybitTestnetContext> = {
  name: 'streams',
  specRef: '17 §3 streams',
  async run(ctx) {
    // One topic, both gates: `subscribeTicks` adds no second subscription for a symbol the
    // funding universe already covers — that folding is the venue divergence under test.
    await ctx.adapter.streams.public.subscribe([SYMBOL])
    await ctx.adapter.streams.public.subscribeTicks([SYMBOL])
    ctx.onCleanup(async () => {
      await ctx.adapter.streams.public.unsubscribeTicks([SYMBOL])
    })
    await awaitBothSignals(ctx, PUBLIC_WAIT_MS)

    if (!ctx.hasCredentials) {
      return { status: 'pass', detail: { public: 'funding + tick off one tickers topic', private: 'skipped' } }
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

    return { status: 'pass', detail: { public: 'funding + tick off one tickers topic', private: true } }
  },
}
