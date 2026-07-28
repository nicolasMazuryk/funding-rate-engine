import type {
  Balances,
  FundingHistory,
  FundingRate,
  FundingRateHistory,
  FundingRates,
  Order,
  Position,
  Ticker,
} from 'ccxt'
import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { createBinanceAdapter } from '../../../../../src/adapters/exchanges/binance/adapter.js'
import type { BinanceMarketClient } from '../../../../../src/adapters/exchanges/binance/factory.js'
import type { ExchangeAdapter } from '../../../../../src/core/ports/exchange-adapter.js'
import { loadMarkets } from './fixtures.js'

const HOUR_MS = 3_600_000

/** A fixture-backed fake with a swappable market set and a load counter. */
function makeClient(initial: readonly string[], intervalsByVenueSymbol: Readonly<Record<string, number>> = {}) {
  let stems = [...initial]
  let loads = 0
  const client: BinanceMarketClient = {
    loadMarkets() {
      loads++
      return Promise.resolve(loadMarkets(stems))
    },
    setLeverage() {
      return Promise.resolve({})
    },
    setMarginMode() {
      return Promise.resolve({})
    },
    setPositionMode() {
      return Promise.resolve({})
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
    fetchPositions() {
      return Promise.resolve([])
    },
    fetchBalance() {
      return Promise.resolve({ info: {} } as Balances)
    },
    fetchOrder(id, symbol) {
      return Promise.resolve({ clientOrderId: id, symbol, info: { symbol }, status: 'open', filled: 0 } as Order)
    },
    fetchOpenOrders() {
      return Promise.resolve([])
    },
    fetchMyTrades() {
      return Promise.resolve([])
    },
    fetchFundingRates(symbols) {
      const out: FundingRates = {}
      for (const symbol of symbols ?? []) {
        out[symbol] = { symbol, info: { symbol }, fundingRate: -0.0005, timestamp: 1_000 } as FundingRate
      }
      return Promise.resolve(out)
    },
    fetchFundingIntervals() {
      const out: FundingRates = {}
      for (const [venue, hours] of Object.entries(intervalsByVenueSymbol)) {
        out[venue] = { symbol: venue, info: { symbol: venue, fundingIntervalHours: hours } } as FundingRate
      }
      return Promise.resolve(out)
    },
    fetchFundingHistory() {
      return Promise.resolve([])
    },
  }
  return { client, setStems: (s: string[]) => (stems = s), loads: () => loads }
}

/** Let the fire-and-forget reload's resolved-promise chain settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
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

  it('init sources fundingIntervalHours from fetchFundingIntervals, overriding market.info (SUGGESTIONS L13)', async () => {
    const clock = createVirtualClock(0)
    // `funding-4h` fixture (id AAVEUSDT) carries 4h in market.info; fundingInfo overrides to 2h.
    const { client } = makeClient(['clean-perp-btc', 'funding-4h'], { AAVEUSDT: 2 })
    const adapter = createBinanceAdapter({ client, clock })
    await adapter.init()
    // AAVE's fundingInfo override (2h) wins over market.info's 4h.
    expect(adapter.normalize('AAVE').fundingIntervalHours).toBe(2)
    // BTC is absent from the fundingInfo response → stays at market.info's 8h default.
    expect(adapter.normalize('BTC').fundingIntervalHours).toBe(8)
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

  it('account setup applies (cached, no throw); order path + streams fail loud without their deps', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBinanceAdapter({ client, clock })
    await adapter.init()

    const order = { symbol: 'BTC', side: 'long', type: 'market', qty: 1, clientOrderId: 'o1' } as const
    // Order path is wired only when wsApiPrivate + restOrders + bus are injected; absent them it fails loud.
    expect(() => adapter.placeOrder(order)).toThrow(/order path requires wsApiPrivate \+ restOrders \+ bus deps/)
    expect(() => adapter.cancelOrder('o1')).toThrow(/order path requires wsApiPrivate \+ restOrders \+ bus deps/)
    // Account setup is wired (0240) — the cached ccxt writes resolve, no NotImplemented stub.
    await expect(adapter.setPositionMode('one_way')).resolves.toBeUndefined()
    await expect(adapter.setMarginMode('BTC', 'isolated')).resolves.toBeUndefined()
    await expect(adapter.setLeverage('BTC', 5)).resolves.toBeUndefined()
    // Public stream is wired only when ws+bus are injected; absent them it fails loud (not NotImplemented).
    expect(() => adapter.streams.public.subscribe(['BTC'])).toThrow(/public stream requires ws\+bus deps/)
    expect(() => adapter.streams.public.subscribeTicks(['BTC'])).toThrow(/public stream requires ws\+bus deps/)
    // Private stream likewise fails loud without wsPrivate+bus (implemented, not a NotImplemented stub).
    expect(() => adapter.streams.private.subscribe()).toThrow(/private stream requires wsPrivate\+bus deps/)
  })

  it('logs an unmapped venue error code via the injected log callback (SUGGESTIONS L14)', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    client.fetchBalance = () => Promise.reject(Object.assign(new Error('mystery venue error'), { code: -9999 }))
    const limiter = { acquire: () => Promise.resolve() }
    const log = vi.fn()
    const adapter = createBinanceAdapter({ client, clock, limiter, log })
    await adapter.init()

    await expect(adapter.getBalance()).rejects.toMatchObject({ kind: 'NetworkError' })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('binance: unmapped venue error code', { rawCode: -9999 })
  })
})

describe('createBinanceAdapter — account REST reads (0220)', () => {
  /** Build a ready adapter over the ['clean-perp-btc'] registry with ccxt overrides applied. */
  async function withClient(overrides: Partial<BinanceMarketClient>): Promise<ExchangeAdapter> {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBinanceAdapter({ client: { ...client, ...overrides }, clock })
    await adapter.init()
    return adapter
  }

  it('getPositions maps ccxt positions to canonical symbol + signed side, resolving via info.symbol', async () => {
    const adapter = await withClient({
      fetchPositions: () =>
        Promise.resolve([
          { symbol: 'BTC/USDT:USDT', info: { symbol: 'BTCUSDT' }, side: 'short', contracts: 3, entryPrice: 60_000 },
          // Unknown venue symbol → dropped (never guessed).
          { symbol: 'DOGE/USDT:USDT', info: { symbol: 'DOGEUSDT' }, side: 'long', contracts: 5 },
        ] as Position[]),
    })
    expect(await adapter.getPositions()).toEqual([{ symbol: 'BTC', side: 'short', qty: 3, entryPrice: 60_000 }])
  })

  it('getBalance reads the USDT quote asset free/used', async () => {
    const adapter = await withClient({
      fetchBalance: () =>
        Promise.resolve({ info: {}, USDT: { free: 1_000, used: 250, total: 1_250 } } as unknown as Balances),
    })
    expect(await adapter.getBalance()).toEqual({ asset: 'USDT', free: 1_000, used: 250 })
  })

  it('getBalance defaults free/used to 0 when the quote asset is absent', async () => {
    const adapter = await withClient({ fetchBalance: () => Promise.resolve({ info: {} } as Balances) })
    expect(await adapter.getBalance()).toEqual({ asset: 'USDT', free: 0, used: 0 })
  })

  it('getOrder throws NotFound for a clientOrderId with no known symbol (0230 populates the map)', async () => {
    const adapter = await withClient({})
    await expect(adapter.getOrder('unknown')).rejects.toThrow(/no known symbol for clientOrderId 'unknown'/)
  })
})

describe('createBinanceAdapter — fundingIncome (real fapi/v1/income read, 0470 §7)', () => {
  const RANGE = { fromTs: 1_000, toTs: 10_000 }

  /** One `fapi/v1/income` row as ccxt surfaces it — unified `amount`, raw venue id under `info`. */
  function incomeRow(amount: number, timestamp: number | undefined, venueSymbol = 'BTCUSDT'): FundingHistory {
    return {
      info: { symbol: venueSymbol, incomeType: 'FUNDING_FEE', income: String(amount) },
      symbol: 'BTC/USDT:USDT',
      code: 'USDT',
      id: '1',
      amount,
      timestamp,
    } as FundingHistory
  }

  async function withIncome(rows: FundingHistory[]): Promise<{ adapter: ExchangeAdapter; args: unknown[][] }> {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const args: unknown[][] = []
    const adapter = createBinanceAdapter({
      client: {
        ...client,
        fetchFundingHistory: (symbol, since, limit, params) => {
          args.push([symbol, since, limit, params])
          return Promise.resolve(rows)
        },
      },
      clock,
    })
    await adapter.init()
    return { adapter, args }
  }

  it('maps signed income rows with positive = received', async () => {
    const { adapter } = await withIncome([incomeRow(0.42, 2_000), incomeRow(-0.13, 3_000)])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([
      { symbol: 'BTC', amount: 0.42, fundingTime: 2_000 },
      { symbol: 'BTC', amount: -0.13, fundingTime: 3_000 },
    ])
  })

  it('asks ccxt for the venue symbol over the range (ccxt pins incomeType=FUNDING_FEE itself)', async () => {
    const { adapter, args } = await withIncome([])
    await adapter.fundingIncome('BTC', RANGE)
    expect(args[0]).toEqual(['BTCUSDT', 1_000, undefined, { until: 10_000 }])
  })

  it('drops other symbols, zero amounts, and out-of-range timestamps', async () => {
    const { adapter } = await withIncome([
      incomeRow(0.5, 2_000, 'ETHUSDT'),
      incomeRow(0, 2_000),
      incomeRow(0.5, 99_000),
      incomeRow(0.5, undefined),
      incomeRow(0.5, 2_500),
    ])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([{ symbol: 'BTC', amount: 0.5, fundingTime: 2_500 }])
  })
})
