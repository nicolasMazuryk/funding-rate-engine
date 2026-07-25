/**
 * Unit: Bybit adapter (`10` §2–§4, `11` §6–§7), fixture-driven and fully offline against a fake
 * ccxt slice. Mirrors the Binance sibling — registry load/validate/reload, `markets()`/
 * `normalize()`, the account REST reads, unmapped-code logging, fail-loud unwired paths — plus
 * the two Bybit-only behaviours worth pinning:
 *  - **one registry call** (no `fetchFundingIntervals` analogue; the interval is in the row);
 *  - **`fundingIncome` is real**: transaction-log `SETTLEMENT` rows, `info.funding` with
 *    **positive = received**, filtered to the symbol and the range.
 */

import type {
  Balances,
  FundingRate,
  FundingRateHistory,
  FundingRates,
  LedgerEntry,
  Order,
  Position,
  Ticker,
} from 'ccxt'
import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { createBybitAdapter } from '../../../../../src/adapters/exchanges/bybit/adapter.js'
import type { BybitMarketClient } from '../../../../../src/adapters/exchanges/bybit/factory.js'
import type { ExchangeAdapter } from '../../../../../src/core/ports/exchange-adapter.js'
import { loadMarkets } from './fixtures.js'

const HOUR_MS = 3_600_000

/** A fixture-backed fake with a swappable market set and a load counter. */
function makeClient(initial: readonly string[]) {
  let stems = [...initial]
  let loads = 0
  const client: BybitMarketClient = {
    loadMarkets() {
      loads++
      return Promise.resolve(loadMarkets(stems))
    },
    fetchFundingRate(symbol) {
      return Promise.resolve({ symbol, info: {}, fundingRate: -0.0005, timestamp: 1_000 } as FundingRate)
    },
    fetchFundingRateHistory(symbol) {
      const rows: FundingRateHistory[] = [
        { info: {}, symbol, fundingRate: 0.0001, timestamp: 1_000 },
        { info: {}, symbol, fundingRate: 0.0002, timestamp: 5_000 },
        { info: {}, symbol, fundingRate: 0.0003, timestamp: 20_000 },
      ]
      return Promise.resolve(rows)
    },
    fetchFundingRates(symbols) {
      const out: FundingRates = {}
      for (const symbol of symbols ?? []) {
        out[symbol] = { symbol, info: { symbol }, fundingRate: -0.0005, timestamp: 1_000 } as FundingRate
      }
      return Promise.resolve(out)
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
    fetchLedger() {
      return Promise.resolve([])
    },
  }
  return { client, setStems: (s: string[]) => (stems = s), loads: () => loads }
}

/** Let the fire-and-forget reload's resolved-promise chain settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('createBybitAdapter', () => {
  it('type-checks as ExchangeAdapter with no cast (DoD)', () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter: ExchangeAdapter = createBybitAdapter({ client, clock })
    expect(adapter).toBeDefined()
  })

  it('init loads + validates the registry; markets()/normalize() read it', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'multiplier-pepe'])
    const adapter = createBybitAdapter({ client, clock })
    await adapter.init()

    expect(adapter.markets()).toEqual([
      { normalized: 'BTC', venueSymbol: 'BTCUSDT', status: 'trading' },
      { normalized: 'PEPE', venueSymbol: '1000PEPEUSDT', status: 'trading' },
    ])
    expect(adapter.normalize('PEPE').contractSize).toBe(1000)
  })

  it('sources fundingIntervalHours from the market row alone — one load call, no second read', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc', 'funding-4h-tia'])
    const adapter = createBybitAdapter({ client: c.client, clock })
    await adapter.init()
    expect(c.loads()).toBe(1)
    expect(adapter.normalize('BTC').fundingIntervalHours).toBe(8)
    expect(adapter.normalize('TIA').fundingIntervalHours).toBe(4)
  })

  it('normalize fails loud on an unknown symbol (sim parity)', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBybitAdapter({ client, clock })
    await adapter.init()
    expect(() => adapter.normalize('DOGE')).toThrow(/unknown symbol 'DOGE'/)
  })

  it('init aborts (throws) when the load carries an anomalous instrument', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'anomaly-zero-contractsize'])
    const adapter = createBybitAdapter({ client, clock })
    await expect(adapter.init()).rejects.toThrow(/contractSize/)
  })

  it('honors symbols.deny', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'multiplier-pepe'])
    const adapter = createBybitAdapter({ client, clock, deny: ['PEPE'] })
    await adapter.init()
    expect(adapter.markets().map((m) => m.normalized)).toEqual(['BTC'])
  })

  it('maps predictedFunding to signed percent + epoch ms', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBybitAdapter({ client, clock })
    await adapter.init()
    expect(await adapter.predictedFunding('BTC')).toEqual({ symbol: 'BTC', rate: -0.05, ts: 1_000 })
  })

  it('maps fundingHistory to signed percent and filters to the range', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBybitAdapter({ client, clock })
    await adapter.init()
    expect(await adapter.fundingHistory('BTC', { fromTs: 900, toTs: 6_000 })).toEqual([
      { symbol: 'BTC', rate: 0.01, settleTs: 1_000 },
      { symbol: 'BTC', rate: 0.02, settleTs: 5_000 },
    ])
  })

  it('reloads hourly and swaps in the fresh registry on a virtual-clock advance', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc'])
    const adapter = createBybitAdapter({ client: c.client, clock })
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
    const adapter = createBybitAdapter({ client: c.client, clock })
    await adapter.init()
    await adapter.close()

    clock.advanceBy(HOUR_MS * 3)
    await flush()
    expect(c.loads()).toBe(1) // no reload after close
  })

  it('order path, streams and account setup all fail loud without their deps', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBybitAdapter({ client, clock })
    await adapter.init()

    const order = { symbol: 'BTC', side: 'long', type: 'market', qty: 1, clientOrderId: 'o1' } as const
    expect(() => adapter.placeOrder(order)).toThrow(/order path requires wsApiPrivate \+ restOrders \+ bus deps/)
    expect(() => adapter.cancelOrder('o1')).toThrow(/order path requires wsApiPrivate \+ restOrders \+ bus deps/)
    expect(() => adapter.setPositionMode('one_way')).toThrow(/account setup requires the accountSetup dep/)
    expect(() => adapter.streams.public.subscribe(['BTC'])).toThrow(/public stream requires ws\+bus deps/)
    expect(() => adapter.streams.private.subscribe()).toThrow(/private stream requires wsPrivate\+bus deps/)
  })

  it('account setup applies (cached) when the native client is injected', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const seen: string[] = []
    const adapter = createBybitAdapter({
      client,
      clock,
      accountSetup: {
        setLeverage: () => {
          seen.push('leverage')
          return Promise.resolve({})
        },
        setMarginMode: (mode) => {
          seen.push(`margin:${mode}`)
          return Promise.resolve({})
        },
        switchPositionMode: () => {
          seen.push('position')
          return Promise.resolve({})
        },
      },
    })
    await adapter.init()
    await expect(adapter.setPositionMode('one_way')).resolves.toBeUndefined()
    await expect(adapter.setMarginMode('BTC', 'isolated')).resolves.toBeUndefined()
    await expect(adapter.setLeverage('BTC', 5)).resolves.toBeUndefined()
    expect(seen).toEqual(['position', 'margin:ISOLATED_MARGIN', 'leverage'])
  })

  it('logs an unmapped venue error code via the injected log callback', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    client.fetchBalance = () => Promise.reject(Object.assign(new Error('mystery venue error'), { code: 999999 }))
    const limiter = { acquire: () => Promise.resolve() }
    const log = vi.fn()
    const adapter = createBybitAdapter({ client, clock, limiter, log })
    await adapter.init()

    await expect(adapter.getBalance()).rejects.toMatchObject({ kind: 'NetworkError' })
    expect(log).toHaveBeenCalledWith('bybit: unmapped venue error code', { rawCode: 999999 })
  })
})

describe('createBybitAdapter — account REST reads', () => {
  /** Build a ready adapter over the ['clean-perp-btc'] registry with ccxt overrides applied. */
  async function withClient(overrides: Partial<BybitMarketClient>): Promise<ExchangeAdapter> {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBybitAdapter({ client: { ...client, ...overrides }, clock })
    await adapter.init()
    return adapter
  }

  it('getPositions maps ccxt positions to canonical symbol + side, resolving via info.symbol', async () => {
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

  it('getBalance reads the USDT quote asset free/used, defaulting to 0 when absent', async () => {
    const withQuote = await withClient({
      fetchBalance: () =>
        Promise.resolve({ info: {}, USDT: { free: 1_000, used: 250, total: 1_250 } } as unknown as Balances),
    })
    expect(await withQuote.getBalance()).toEqual({ asset: 'USDT', free: 1_000, used: 250 })

    const empty = await withClient({ fetchBalance: () => Promise.resolve({ info: {} } as Balances) })
    expect(await empty.getBalance()).toEqual({ asset: 'USDT', free: 0, used: 0 })
  })

  it('getOpenOrders maps rows and filters to one canonical symbol', async () => {
    const adapter = await withClient({
      fetchOpenOrders: () =>
        Promise.resolve([
          {
            clientOrderId: 'BTC-1-exit-1',
            id: 'ff-1',
            info: { symbol: 'BTCUSDT', reduceOnly: true },
            side: 'sell',
            type: 'limit',
            status: 'open',
            filled: 0,
          },
          { clientOrderId: 'x', id: 'ff-2', info: { symbol: 'DOGEUSDT' }, side: 'buy', type: 'market', status: 'open' },
        ] as Order[]),
    })
    expect(await adapter.getOpenOrders('BTC')).toEqual([
      {
        clientOrderId: 'BTC-1-exit-1',
        venueOrderId: 'ff-1',
        symbol: 'BTC',
        side: 'short',
        type: 'limit',
        status: 'OPEN',
        reduceOnly: true,
      },
    ])
  })

  it('getOrder throws NotFound for a clientOrderId with no known symbol (submit populates the map)', async () => {
    const adapter = await withClient({})
    await expect(adapter.getOrder('unknown')).rejects.toThrow(/no known symbol for clientOrderId 'unknown'/)
  })
})

describe('createBybitAdapter — fundingIncome (real transaction-log read)', () => {
  const RANGE = { fromTs: 1_000, toTs: 10_000 }

  /** One `/v5/account/transaction-log` row as ccxt surfaces it (raw fields under `info`). */
  function ledgerRow(info: Record<string, unknown>, timestamp?: number): LedgerEntry {
    return { info, timestamp, currency: 'USDT' } as LedgerEntry
  }

  async function withLedger(rows: LedgerEntry[]): Promise<{ adapter: ExchangeAdapter; params: unknown[] }> {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const params: unknown[] = []
    const adapter = createBybitAdapter({
      client: {
        ...client,
        fetchLedger: (_code, _since, _limit, p) => {
          params.push(p)
          return Promise.resolve(rows)
        },
      },
      clock,
    })
    await adapter.init()
    return { adapter, params }
  }

  it('maps SETTLEMENT rows with funding positive = received', async () => {
    const { adapter } = await withLedger([
      ledgerRow({ type: 'SETTLEMENT', symbol: 'BTCUSDT', funding: '0.42' }, 2_000),
      ledgerRow({ type: 'SETTLEMENT', symbol: 'BTCUSDT', funding: '-0.13' }, 3_000),
    ])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([
      { symbol: 'BTC', amount: 0.42, fundingTime: 2_000 },
      { symbol: 'BTC', amount: -0.13, fundingTime: 3_000 },
    ])
  })

  it('queries the linear SETTLEMENT rows for the venue symbol over the range', async () => {
    const { adapter, params } = await withLedger([])
    await adapter.fundingIncome('BTC', RANGE)
    expect(params[0]).toEqual({ category: 'linear', type: 'SETTLEMENT', symbol: 'BTCUSDT', endTime: 10_000 })
  })

  it('drops non-settlement rows, other symbols, zero funding, and out-of-range timestamps', async () => {
    const { adapter } = await withLedger([
      ledgerRow({ type: 'TRADE', symbol: 'BTCUSDT', funding: '0.5' }, 2_000),
      ledgerRow({ type: 'SETTLEMENT', symbol: 'ETHUSDT', funding: '0.5' }, 2_000),
      ledgerRow({ type: 'SETTLEMENT', symbol: 'BTCUSDT', funding: '0' }, 2_000),
      ledgerRow({ type: 'SETTLEMENT', symbol: 'BTCUSDT', funding: '0.5' }, 99_000),
      ledgerRow({ type: 'SETTLEMENT', symbol: 'BTCUSDT', funding: '0.5' }, 2_500),
    ])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([{ symbol: 'BTC', amount: 0.5, fundingTime: 2_500 }])
  })

  it('falls back to the raw transactionTime when ccxt carries no timestamp', async () => {
    const { adapter } = await withLedger([
      ledgerRow({ type: 'SETTLEMENT', symbol: 'BTCUSDT', funding: '0.25', transactionTime: '4000' }),
    ])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([{ symbol: 'BTC', amount: 0.25, fundingTime: 4_000 }])
  })
})
