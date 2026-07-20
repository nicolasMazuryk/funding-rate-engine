/**
 * Live public-WS smoke for the Binance adapter — **no credentials, no orders**. Opens
 * the real native `WebsocketClient` public feeds, subscribes BTC funding + ticks, and
 * asserts the normalize→publish pipeline lands ≥1 `FundingPredicted` and ≥1 `MarketTick`
 * for BTC on the real bus within a bounded window, then closes cleanly (`10` §7).
 *
 * Env-gated (`RUN_BINANCE_INTEGRATION=1`), mirroring the market-load smoke: excluded
 * from `verify` and the Postgres integration suite; offline CI skips it.
 */

import { describe, expect, it } from 'vitest'
import { createRealClock } from '../../src/adapters/clock/real-clock.js'
import { createBinanceAdapter } from '../../src/adapters/exchanges/binance/adapter.js'
import { createBinanceClients } from '../../src/adapters/exchanges/binance/factory.js'
import type { BinanceWsClient } from '../../src/adapters/exchanges/binance/public-stream.js'
import type { ExchangeProfile } from '../../src/config/exchange-schema.js'
import { createEventBus } from '../../src/core/events/bus.js'
import type { EngineEvent } from '../../src/core/events/types.js'

const RUN = process.env.RUN_BINANCE_INTEGRATION === '1'

const PROFILE: ExchangeProfile = {
  takerFeePct: 0.04,
  makerFeePct: 0.02,
  submissionStaggerMs: 250,
  rateLimitReservePct: 10,
  rateLimitWeightPerMinute: 2400,
  wsOrderAdapter: true,
  ws: { publicUrl: 'wss://fstream.binance.com/ws', privateUrl: 'wss://fstream.binance.com/ws' },
  deltas: {},
}

/** Resolve once both event kinds for BTC have landed, or reject after `timeoutMs`. */
function awaitBtcFeeds(collected: EngineEvent[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      const funding = collected.some((e) => e.type === 'FundingPredicted' && e.symbol === 'BTC')
      const tick = collected.some((e) => e.type === 'MarketTick' && e.symbol === 'BTC')
      if (funding && tick) {
        clearInterval(poll)
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(poll)
        reject(new Error(`timed out; saw ${collected.length} events`))
      }
    }, 250)
  })
}

describe.skipIf(!RUN)('Binance live public WS', () => {
  it('publishes ≥1 FundingPredicted and ≥1 MarketTick for BTC, then closes clean', async () => {
    const clients = createBinanceClients(PROFILE, { apiKey: 'public', apiSecret: 'public' })
    const bus = createEventBus()
    const collected: EngineEvent[] = []
    bus.subscribe((e) => collected.push(e))

    const adapter = createBinanceAdapter({
      client: clients.ccxt,
      clock: createRealClock(),
      ws: clients.wsPublic as unknown as BinanceWsClient,
      bus,
    })
    await adapter.init()

    await adapter.streams.public.subscribe(['BTC'])
    await adapter.streams.public.subscribeTicks(['BTC'])

    await awaitBtcFeeds(collected, 20_000)

    expect(collected.some((e) => e.type === 'FundingPredicted' && e.symbol === 'BTC')).toBe(true)
    expect(collected.some((e) => e.type === 'MarketTick' && e.symbol === 'BTC')).toBe(true)

    await adapter.close()
  }, 30_000)
})
