import type { FundingRate, FundingRateHistory, Ticker } from 'ccxt'
import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { createBinanceAdapter } from '../../../../../src/adapters/exchanges/binance/adapter.js'
import type { BinanceMarketClient } from '../../../../../src/adapters/exchanges/binance/factory.js'
import type { ExchangeAdapter } from '../../../../../src/core/ports/exchange-adapter.js'
import { loadMarkets } from './fixtures.js'

const HOUR_MS = 3_600_000

/** A fixture-backed fake with a swappable market set and a load counter. */
function makeClient(initial: readonly string[]) {
  let stems = [...initial]
  let loads = 0
  const client: BinanceMarketClient = {
    loadMarkets() {
      loads++
      return Promise.resolve(loadMarkets(stems))
    },
    fetchFundingRate(symbol) {
      return Promise.resolve({ symbol, info: {}, fundingRate: -0.0005, timestamp: 1_000 } as FundingRate)
    },
    fetchFundingRateHistory(_symbol, _since) {
      const rows: FundingRateHistory[] = [
        { info: {}, symbol: _symbol, fundingRate: 0.0001, timestamp: 1_000 },
        { info: {}, symbol: _symbol, fundingRate: 0.0002, timestamp: 5_000 },
        { info: {}, symbol: _symbol, fundingRate: 0.0003, timestamp: 20_000 },
      ]
      return Promise.resolve(rows)
    },
    fetchTicker(symbol) {
      return Promise.resolve({ symbol, info: {}, last: 100, timestamp: 2_000 } as Ticker)
    },
  }
  return { client, setStems: (s: string[]) => (stems = s), loads: () => loads }
}

/** Let the fire-and-forget reload's resolved-promise chain settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe('createBinanceAdapter', () => {
  it('type-checks as ExchangeAdapter with no cast (DoD)', () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter: ExchangeAdapter = createBinanceAdapter({ client, clock })
    expect(adapter).toBeDefined()
  })

  it('init loads + validates the registry; markets()/normalize() read it', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'multiplier-pepe'])
    const adapter = createBinanceAdapter({ client, clock })
    await adapter.init()

    expect(adapter.markets()).toEqual([
      { normalized: 'BTC', venueSymbol: 'BTCUSDT', status: 'trading' },
      { normalized: 'PEPE', venueSymbol: '1000PEPEUSDT', status: 'trading' },
    ])
    expect(adapter.normalize('PEPE').contractSize).toBe(1000)
  })

  it('normalize fails loud on an unknown symbol (sim parity)', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBinanceAdapter({ client, clock })
    await adapter.init()
    expect(() => adapter.normalize('DOGE')).toThrow(/unknown symbol 'DOGE'/)
  })

  it('init aborts (throws) when the load carries an anomalous instrument', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'anomaly-zero-contractsize'])
    const adapter = createBinanceAdapter({ client, clock })
    await expect(adapter.init()).rejects.toThrow(/contractSize/)
  })

  it('honors symbols.deny', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'multiplier-pepe'])
    const adapter = createBinanceAdapter({ client, clock, deny: ['PEPE'] })
    await adapter.init()
    expect(adapter.markets().map((m) => m.normalized)).toEqual(['BTC'])
  })

  it('maps predictedFunding to signed percent + epoch ms', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBinanceAdapter({ client, clock })
    await adapter.init()
    expect(await adapter.predictedFunding('BTC')).toEqual({ symbol: 'BTC', rate: -0.05, ts: 1_000 })
  })

  it('maps fundingHistory to signed percent and filters to the range', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBinanceAdapter({ client, clock })
    await adapter.init()
    const events = await adapter.fundingHistory('BTC', { fromTs: 900, toTs: 6_000 })
    expect(events).toEqual([
      { symbol: 'BTC', rate: 0.01, settleTs: 1_000 },
      { symbol: 'BTC', rate: 0.02, settleTs: 5_000 },
    ])
  })

  it('reloads hourly and swaps in the fresh registry on a virtual-clock advance', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc'])
    const adapter = createBinanceAdapter({ client: c.client, clock })
    await adapter.init()
    expect(adapter.markets()).toHaveLength(1)
    expect(c.loads()).toBe(1)

    c.setStems(['clean-perp-btc', 'multiplier-pepe'])
    clock.advanceBy(HOUR_MS)
    await flush()

    expect(c.loads()).toBe(2)
    expect(adapter.markets().map((m) => m.normalized)).toEqual(['BTC', 'PEPE'])
  })

  it('close cancels the pending reload timer', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc'])
    const adapter = createBinanceAdapter({ client: c.client, clock })
    await adapter.init()
    await adapter.close()

    clock.advanceBy(HOUR_MS * 3)
    await flush()
    expect(c.loads()).toBe(1) // no reload after close
  })

  it('trade-side stubs are NotImplemented; public stream fails loud without ws+bus deps', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBinanceAdapter({ client, clock })
    await adapter.init()

    const order = { symbol: 'BTC', side: 'long', type: 'market', qty: 1, clientOrderId: 'o1' } as const
    expect(() => adapter.placeOrder(order)).toThrow(/NotImplemented: BinanceAdapter.placeOrder — task 0230/)
    expect(() => adapter.getBalance()).toThrow(/NotImplemented: BinanceAdapter.getBalance — task 0240/)
    expect(() => adapter.setPositionMode('one_way')).toThrow(/NotImplemented/)
    // Public stream is wired only when ws+bus are injected; absent them it fails loud (not NotImplemented).
    expect(() => adapter.streams.public.subscribe(['BTC'])).toThrow(/public stream requires ws\+bus deps/)
    expect(() => adapter.streams.public.subscribeTicks(['BTC'])).toThrow(/public stream requires ws\+bus deps/)
    // Private stream is still a 0220 NotImplemented stub.
    expect(() => adapter.streams.private.subscribe()).toThrow(/NotImplemented: BinanceAdapter/)
  })
})
