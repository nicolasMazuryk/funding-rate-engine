/**
 * Unit: Bitget adapter (`10` §2–§4, `11` §6–§7), fixture-driven and fully offline against a fake
 * ccxt slice + the virtual clock. Mirrors the OKX/Bybit siblings for the shared shape — registry
 * load/validate/reload, `markets()`/`normalize()`, the account REST reads, unmapped-code logging,
 * fail-loud unwired paths — and pins the four Bitget divergences, each of which is a place where
 * copying a sibling verbatim would be wrong:
 *  - **one registry call.** The funding interval is market metadata (`info.fundInterval`, in
 *    hours), so `init()` is a bare `loadMarkets()` — no companion funding-rate read (OKX) and no
 *    second endpoint (Binance). The call *count* is the assertion, not just the derived value.
 *  - **the venue id is `info.symbol`** (like Bybit, unlike OKX's `info.instId`), so every ccxt
 *    payload resolves on that field and an unknown venue symbol is dropped, never guessed.
 *  - **`contractSize` is 1 everywhere**; the only face value is the symbol multiplier, folded at
 *    registry build (`1000BONK` ⇒ canonical `BONK`, contractSize 1000).
 *  - **`fundingIncome` is a real `fetchFundingHistory` read.** ccxt's Bitget UTA branch returns
 *    rows already scoped to funding settlements, so there is no bill-type filter (Bybit, OKX) and
 *    it is not a stub (Binance). `amount` is signed, positive = received.
 */

import type { Balances, FundingHistory, FundingRate, FundingRateHistory, Order, Position, Ticker } from 'ccxt'
import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { createBitgetAdapter } from '../../../../../src/adapters/exchanges/bitget/adapter.js'
import type { BitgetMarketClient } from '../../../../../src/adapters/exchanges/bitget/factory.js'
import type { ExchangeAdapter } from '../../../../../src/core/ports/exchange-adapter.js'
import { loadMarkets } from './fixtures.js'

const HOUR_MS = 3_600_000

/** A fixture-backed fake with a swappable market set and per-call counters. */
function makeClient(initial: readonly string[]) {
  let stems = [...initial]
  let loads = 0
  let fundingReads = 0
  const client: BitgetMarketClient = {
    loadMarkets() {
      loads++
      return Promise.resolve(loadMarkets(stems))
    },
    fetchFundingRate(symbol) {
      return Promise.resolve({ symbol, info: { symbol }, fundingRate: -0.0005, timestamp: 1_000 } as FundingRate)
    },
    fetchFundingRateHistory(symbol) {
      const rows: FundingRateHistory[] = [
        { info: {}, symbol, fundingRate: 0.0001, timestamp: 1_000 },
        { info: {}, symbol, fundingRate: 0.0002, timestamp: 5_000 },
        { info: {}, symbol, fundingRate: 0.0003, timestamp: 20_000 },
      ]
      return Promise.resolve(rows)
    },
    fetchFundingRates() {
      // Counted so a regression that reintroduces the OKX-style companion read is visible.
      fundingReads++
      return Promise.resolve({})
    },
    fetchTicker(symbol) {
      return Promise.resolve({ symbol, info: { symbol }, last: 100, timestamp: 2_000 } as Ticker)
    },
    fetchPositions() {
      return Promise.resolve([])
    },
    fetchBalance() {
      return Promise.resolve({ info: {} } as Balances)
    },
    fetchOrder(id, symbol) {
      return Promise.resolve({
        clientOrderId: id,
        symbol,
        info: { symbol },
        status: 'open',
        filled: 0,
      } as Order)
    },
    fetchOpenOrders() {
      return Promise.resolve([])
    },
    fetchFundingHistory() {
      return Promise.resolve([])
    },
  }
  return { client, setStems: (s: string[]) => (stems = s), loads: () => loads, fundingReads: () => fundingReads }
}

/** Let the fire-and-forget reload's resolved-promise chain settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('createBitgetAdapter', () => {
  it('type-checks as ExchangeAdapter with no cast (DoD)', () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter: ExchangeAdapter = createBitgetAdapter({ client, clock })
    expect(adapter).toBeDefined()
  })

  it('init loads + validates the registry; markets()/normalize() read it', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'funding-4h-xtz'])
    const adapter = createBitgetAdapter({ client, clock })
    await adapter.init()

    expect(adapter.markets()).toEqual([
      { normalized: 'BTC', venueSymbol: 'BTCUSDT', status: 'trading' },
      { normalized: 'XTZ', venueSymbol: 'XTZUSDT', status: 'trading' },
    ])
    expect(adapter.normalize('BTC')).toEqual({
      normalized: 'BTC',
      venueSymbol: 'BTCUSDT',
      contractSize: 1,
      pricePrecision: 0.1,
      amountPrecision: 0.0001,
      minNotional: 5,
      minQty: 0.0001,
      fundingIntervalHours: 8,
    })
  })

  it('loads the registry with ONE call — the interval is metadata, so there is no funding read', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc', 'funding-4h-xtz', 'funding-1h-dexe'])
    const adapter = createBitgetAdapter({ client: c.client, clock })
    await adapter.init()
    expect(c.loads()).toBe(1)
    expect(c.fundingReads()).toBe(0) // the OKX divergence: that venue needs a second read here
    // `info.fundInterval` is already in hours (Bybit publishes minutes, Binance a second endpoint).
    expect(adapter.normalize('BTC').fundingIntervalHours).toBe(8)
    expect(adapter.normalize('XTZ').fundingIntervalHours).toBe(4)
    expect(adapter.normalize('DEXE').fundingIntervalHours).toBe(1)
  })

  it('folds the symbol multiplier into contractSize while the venue symbol stays intact', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['multiplier-1000-bonk', 'multiplier-1000000-mog', 'digit-base-1inch'])
    const adapter = createBitgetAdapter({ client, clock })
    await adapter.init()

    // Bitget's own contractSize is 1 on every row; the face value lives only in the prefix.
    expect(adapter.normalize('BONK')).toMatchObject({ venueSymbol: '1000BONKUSDT', contractSize: 1_000 })
    expect(adapter.normalize('MOG')).toMatchObject({ venueSymbol: '1000000MOGUSDT', contractSize: 1_000_000 })
    // `1INCH` is a genuine name, not a multiplier: a prefix only counts when a letter follows.
    expect(adapter.normalize('1INCH')).toMatchObject({ venueSymbol: '1INCHUSDT', contractSize: 1 })
  })

  it('filters the universe to active linear USDT-settled swaps (10 §3)', async () => {
    const clock = createVirtualClock(0)
    // The coin-margined and the delisted rows are dropped; the spot row is checked on its own
    // below because it shares the venue id `BTCUSDT` with the perp (ccxt keys markets by id).
    const { client } = makeClient(['clean-perp-btc', 'inverse-coinm', 'delisted'])
    const adapter = createBitgetAdapter({ client, clock })
    await adapter.init()
    expect(adapter.markets().map((m) => m.normalized)).toEqual(['BTC'])

    const spotOnly = makeClient(['spot-btc'])
    const spotAdapter = createBitgetAdapter({ client: spotOnly.client, clock })
    await spotAdapter.init()
    expect(spotAdapter.markets()).toEqual([])
  })

  it('normalize fails loud on an unknown symbol (sim parity)', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBitgetAdapter({ client, clock })
    await adapter.init()
    expect(() => adapter.normalize('DOGE')).toThrow(/unknown symbol 'DOGE'/)
  })

  it('init aborts (throws) when the load carries an anomalous instrument', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'anomaly-zero-contractsize'])
    const adapter = createBitgetAdapter({ client, clock })
    await expect(adapter.init()).rejects.toThrow(/contractSize/)
  })

  it('init aborts when a row publishes a contract size other than 1 (Bitget sizes in base units)', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'anomaly-contractsize-not-one'])
    const adapter = createBitgetAdapter({ client, clock })
    await expect(adapter.init()).rejects.toThrow(/contractSize 100 ≠ 1/)
  })

  it('init aborts on a missing precision', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['anomaly-missing-precision'])
    const adapter = createBitgetAdapter({ client, clock })
    await expect(adapter.init()).rejects.toThrow(/price precision/)
  })

  it('honors symbols.deny', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'funding-4h-xtz'])
    const adapter = createBitgetAdapter({ client, clock, deny: ['XTZ'] })
    await adapter.init()
    expect(adapter.markets().map((m) => m.normalized)).toEqual(['BTC'])
  })

  it('maps predictedFunding to signed percent + epoch ms', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBitgetAdapter({ client, clock })
    await adapter.init()
    expect(await adapter.predictedFunding('BTC')).toEqual({ symbol: 'BTC', rate: -0.05, ts: 1_000 })
  })

  it('maps fundingHistory to signed percent and filters to the range', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBitgetAdapter({ client, clock })
    await adapter.init()
    expect(await adapter.fundingHistory('BTC', { fromTs: 900, toTs: 6_000 })).toEqual([
      { symbol: 'BTC', rate: 0.01, settleTs: 1_000 },
      { symbol: 'BTC', rate: 0.02, settleTs: 5_000 },
    ])
  })

  it('reloads hourly and swaps in the fresh registry on a virtual-clock advance', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc'])
    const adapter = createBitgetAdapter({ client: c.client, clock })
    await adapter.init()
    expect(adapter.markets()).toHaveLength(1)
    expect(c.loads()).toBe(1)

    c.setStems(['clean-perp-btc', 'funding-4h-xtz'])
    clock.advanceBy(HOUR_MS)
    await flush()

    expect(c.loads()).toBe(2)
    expect(adapter.markets().map((m) => m.normalized)).toEqual(['BTC', 'XTZ'])
  })

  it('close cancels the pending reload timer', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc'])
    const adapter = createBitgetAdapter({ client: c.client, clock })
    await adapter.init()
    await adapter.close()

    clock.advanceBy(HOUR_MS * 3)
    await flush()
    expect(c.loads()).toBe(1) // no reload after close
  })

  it('order path, streams and account setup all fail loud without their deps', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBitgetAdapter({ client, clock })
    await adapter.init()

    const order = { symbol: 'BTC', side: 'long', type: 'market', qty: 1, clientOrderId: 'o1' } as const
    expect(() => adapter.placeOrder(order)).toThrow(/order path requires wsApiPrivate \+ restOrders \+ bus deps/)
    expect(() => adapter.cancelOrder('o1')).toThrow(/order path requires wsApiPrivate \+ restOrders \+ bus deps/)
    expect(() => adapter.setPositionMode('one_way')).toThrow(/account setup requires the accountSetup dep/)
    expect(() => adapter.setMarginMode('BTC', 'isolated')).toThrow(/account setup requires the accountSetup dep/)
    expect(() => adapter.setLeverage('BTC', 5)).toThrow(/account setup requires the accountSetup dep/)
    expect(() => adapter.streams.public.subscribe(['BTC'])).toThrow(/public stream requires ws\+bus deps/)
    expect(() => adapter.streams.private.subscribe()).toThrow(/private stream requires wsPrivate\+bus deps/)
  })

  it('account setup applies (cached) when the native client is injected', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const seen: string[] = []
    const adapter = createBitgetAdapter({
      client,
      clock,
      accountSetup: {
        // Already `isolated` + `one_way_mode` → both reads short-circuit their writes.
        getAccountSettings: () => Promise.resolve({ data: { accountLevel: 'isolated', holdMode: 'one_way_mode' } }),
        adjustAccountMode: () => {
          seen.push('accountLevel')
          return Promise.resolve({})
        },
        setHoldMode: () => {
          seen.push('holdMode')
          return Promise.resolve({})
        },
        setLeverage: () => {
          seen.push('leverage')
          return Promise.resolve({})
        },
      },
    })
    await adapter.init()
    await expect(adapter.setPositionMode('one_way')).resolves.toBeUndefined()
    await expect(adapter.setMarginMode('BTC', 'isolated')).resolves.toBeUndefined()
    await expect(adapter.setLeverage('BTC', 5)).resolves.toBeUndefined()
    await expect(adapter.setLeverage('BTC', 5)).resolves.toBeUndefined() // cached → no second write
    expect(seen).toEqual(['leverage'])
  })

  it('logs an unmapped venue error code via the injected log callback', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const limiter = { acquire: () => Promise.resolve() }
    const log = vi.fn()
    const adapter = createBitgetAdapter({ client, clock, limiter, log })
    await adapter.init()
    client.fetchBalance = () => Promise.reject(Object.assign(new Error('mystery venue error'), { code: '99999' }))

    await expect(adapter.getBalance()).rejects.toMatchObject({ kind: 'NetworkError' })
    // Bitget codes are STRINGS on the wire (its success envelope is `"00000"`, which would
    // collapse onto 0 numerically), so the logged rawCode is `'99999'`, not the number.
    expect(log).toHaveBeenCalledWith('bitget: unmapped venue error code', { rawCode: '99999' })
  })
})

describe('createBitgetAdapter — account REST reads', () => {
  /** Build a ready adapter over the ['clean-perp-btc'] registry with ccxt overrides applied. */
  async function withClient(overrides: Partial<BitgetMarketClient>): Promise<ExchangeAdapter> {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createBitgetAdapter({ client: { ...client, ...overrides }, clock })
    await adapter.init()
    return adapter
  }

  it('getPositions resolves the canonical symbol via info.symbol (Bybit-style, not OKX instId)', async () => {
    const adapter = await withClient({
      fetchPositions: () =>
        Promise.resolve([
          {
            symbol: 'BTC/USDT:USDT',
            info: { symbol: 'BTCUSDT' },
            side: 'short',
            contracts: 3,
            entryPrice: 60_000,
          },
          // Unknown venue symbol → dropped (never guessed from ccxt's unified name).
          { symbol: 'DOGE/USDT:USDT', info: { symbol: 'DOGEUSDT' }, side: 'long', contracts: 5 },
          // `info.instId` is the OKX field and means nothing here — also dropped.
          { symbol: 'BTC/USDT:USDT', info: { instId: 'BTCUSDT' }, side: 'long', contracts: 7 },
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
            id: 'bg-1',
            // Bitget spells reduce-only as the string "YES" on the raw row.
            info: { symbol: 'BTCUSDT', reduceOnly: 'YES' },
            side: 'sell',
            type: 'limit',
            status: 'open',
            filled: 0,
          },
          { clientOrderId: 'x', id: 'bg-2', info: { symbol: 'DOGEUSDT' }, side: 'buy', type: 'market' },
        ] as Order[]),
    })
    expect(await adapter.getOpenOrders('BTC')).toEqual([
      {
        clientOrderId: 'BTC-1-exit-1',
        venueOrderId: 'bg-1',
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

describe('createBitgetAdapter — fundingIncome (real fetchFundingHistory read)', () => {
  const RANGE = { fromTs: 1_000, toTs: 10_000 }

  /** One settlement row as ccxt's Bitget UTA branch surfaces it (raw row under `info`). */
  function fundingRow(amount: number | undefined, timestamp: number | undefined, venue = 'BTCUSDT'): FundingHistory {
    return { info: { symbol: venue }, symbol: 'BTC/USDT:USDT', code: 'USDT', amount, timestamp } as FundingHistory
  }

  async function withFunding(rows: FundingHistory[]): Promise<{ adapter: ExchangeAdapter; args: unknown[][] }> {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const args: unknown[][] = []
    const adapter = createBitgetAdapter({
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

  it('maps signed amounts straight through — positive = received, no negation and no bill filter', async () => {
    const { adapter } = await withFunding([fundingRow(0.42, 2_000), fundingRow(-0.13, 3_000)])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([
      { symbol: 'BTC', amount: 0.42, fundingTime: 2_000 },
      { symbol: 'BTC', amount: -0.13, fundingTime: 3_000 },
    ])
  })

  it('queries the venue symbol over the range (since + an explicit endTime param)', async () => {
    // ccxt's `since` bounds only the first page of the cursor-paginated read, hence the
    // explicit `endTime` — and hence the client-side range re-check below.
    const { adapter, args } = await withFunding([])
    await adapter.fundingIncome('BTC', RANGE)
    expect(args[0]).toEqual(['BTCUSDT', 1_000, undefined, { endTime: 10_000 }])
  })

  it('drops out-of-range rows, zero amounts, and rows for another venue symbol', async () => {
    const { adapter } = await withFunding([
      fundingRow(0.5, 500), // before the window
      fundingRow(0.5, 99_000), // after the window
      fundingRow(0, 2_000), // zero settlement — not an income event
      fundingRow(0.5, 2_000, 'ETHUSDT'), // another instrument's settlement
      fundingRow(0.5, 2_500),
    ])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([{ symbol: 'BTC', amount: 0.5, fundingTime: 2_500 }])
  })

  it('drops a row with no timestamp — an unplaceable settlement is never dated by guesswork', async () => {
    const { adapter } = await withFunding([fundingRow(0.25, undefined)])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([])
  })
})
