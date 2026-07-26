/**
 * Unit: KuCoin adapter (`10` §2–§4, `11` §6–§7), fixture-driven and fully offline against a fake
 * ccxt slice + the virtual clock. Mirrors the four siblings for the shared shape — registry
 * load/validate/reload, `markets()`/`normalize()`, the account REST reads, unmapped-code logging,
 * fail-loud unwired paths — and pins the KuCoin divergences, each a place where copying a sibling
 * verbatim would be wrong:
 *  - **one registry call.** The funding interval is market metadata (`info.fundingRateGranularity`,
 *    in ms), so `init()` is a bare `loadMarkets()` — no companion funding read (OKX), no second
 *    endpoint (Binance). And there is no bulk funding read to make: the ccxt client slice does not
 *    even carry `fetchFundingRates`, because `kucoinfutures.has.fetchFundingRates === false`.
 *  - **the venue id is `info.symbol`** (Bybit/Bitget's field, not OKX's `instId`), so every ccxt
 *    payload resolves on it and an unknown venue symbol is dropped, never guessed.
 *  - **`getOrder` needs no symbol** — the only venue of the five where that works. ccxt maps
 *    `{ clientOid }` to `GET /api/v1/orders/byClientOid`, keyed by the client id alone, so the
 *    exact `fetchOrder` arguments are the assertion: an id this process never submitted still
 *    reaches the venue instead of short-circuiting on a local map miss (OKX/Bitget both do).
 *  - **`fundingIncome` is a real `fetchFundingHistory` read** whose rows are already scoped to
 *    funding settlements — no ledger/bill-type filter (Bybit, OKX) and not a stub (Binance).
 */

import type { Balances, FundingHistory, FundingRate, FundingRateHistory, Order, Position, Ticker } from 'ccxt'
import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { createKucoinAdapter } from '../../../../../src/adapters/exchanges/kucoin/adapter.js'
import type { KucoinMarketClient } from '../../../../../src/adapters/exchanges/kucoin/factory.js'
import type { ExchangeAdapter } from '../../../../../src/core/ports/exchange-adapter.js'
import { loadMarkets } from './fixtures.js'

const HOUR_MS = 3_600_000

/** A fixture-backed fake with a swappable market set and per-call recording. */
function makeClient(initial: readonly string[]) {
  let stems = [...initial]
  let loads = 0
  /** Every `fetchOrder` argument list, in call order — the client-id read is asserted on it. */
  const orderReads: unknown[][] = []
  const client: KucoinMarketClient = {
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
    fetchTicker(symbol) {
      return Promise.resolve({ symbol, info: { symbol }, last: 64_706.1, timestamp: 2_000 } as Ticker)
    },
    fetchPositions() {
      return Promise.resolve([])
    },
    fetchBalance() {
      return Promise.resolve({ info: {} } as Balances)
    },
    fetchOrder(id, symbol, params) {
      orderReads.push([id, symbol, params])
      return Promise.resolve({
        clientOrderId: (params as { clientOid?: string } | undefined)?.clientOid,
        info: { symbol: 'XBTUSDTM' },
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
  return { client, setStems: (s: string[]) => (stems = s), loads: () => loads, orderReads }
}

/** Let the fire-and-forget reload's resolved-promise chain settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('createKucoinAdapter', () => {
  it('type-checks as ExchangeAdapter with no cast (DoD)', () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter: ExchangeAdapter = createKucoinAdapter({ client, clock })
    expect(adapter).toBeDefined()
  })

  it('init loads + validates the registry; markets()/normalize() read it', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'funding-4h-wif'])
    const adapter = createKucoinAdapter({ client, clock })
    await adapter.init()

    expect(adapter.markets()).toEqual([
      { normalized: 'BTC', venueSymbol: 'XBTUSDTM', status: 'trading' },
      { normalized: 'WIF', venueSymbol: 'WIFUSDTM', status: 'trading' },
    ])
    expect(adapter.normalize('BTC')).toEqual({
      normalized: 'BTC',
      venueSymbol: 'XBTUSDTM',
      contractSize: 0.001, // = info.multiplier: one contract is 0.001 BTC
      pricePrecision: 0.1,
      amountPrecision: 1, // integer contracts
      minNotional: 0, // KuCoin publishes no per-instrument min notional
      minQty: 1,
      fundingIntervalHours: 8,
    })
  })

  it('loads the registry with ONE call — the interval is ms metadata, so there is no funding read', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc', 'funding-4h-wif', 'funding-1h-lrc'])
    const adapter = createKucoinAdapter({ client: c.client, clock })
    await adapter.init()
    expect(c.loads()).toBe(1)
    // 28 800 000 / 14 400 000 / 3 600 000 ms — the only venue of the five publishing milliseconds.
    expect(adapter.normalize('BTC').fundingIntervalHours).toBe(8)
    expect(adapter.normalize('WIF').fundingIntervalHours).toBe(4)
    expect(adapter.normalize('LRC').fundingIntervalHours).toBe(1)
  })

  it('takes contractSize from the venue multiplier and does NOT fold the name prefix', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['prefix-1000-bonk', 'prefix-10000-cat', 'digit-base-1inch'])
    const adapter = createKucoinAdapter({ client, clock })
    await adapter.init()

    // The KuCoin deviation from its three siblings: the quoted price is already per prefixed unit,
    // so folding the prefix on top would under-size by 1000× (`./contract-size-chain.test.ts`).
    expect(adapter.normalize('BONK')).toMatchObject({ venueSymbol: '1000BONKUSDTM', contractSize: 1_000 })
    expect(adapter.normalize('CAT')).toMatchObject({ venueSymbol: '10000CATUSDTM', contractSize: 10 })
    // `1INCH` is a genuine name, not a multiplier: a prefix only counts when a letter follows.
    expect(adapter.normalize('1INCH')).toMatchObject({ venueSymbol: '1INCHUSDTM', contractSize: 1 })
  })

  it('filters the universe to active linear USDT-settled swaps (10 §3)', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'spot-btc', 'inverse-coinm-xbt', 'delisted'])
    const adapter = createKucoinAdapter({ client, clock })
    await adapter.init()
    expect(adapter.markets().map((m) => m.normalized)).toEqual(['BTC'])
  })

  it('normalize fails loud on an unknown symbol (sim parity)', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createKucoinAdapter({ client, clock })
    await adapter.init()
    expect(() => adapter.normalize('DOGE')).toThrow(/unknown symbol 'DOGE'/)
  })

  it('init aborts (throws) when the load carries an anomalous instrument', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'anomaly-multiplier-mismatch'])
    const adapter = createKucoinAdapter({ client, clock })
    await expect(adapter.init()).rejects.toThrow(/disagrees with info.multiplier/)
  })

  it('honors symbols.deny', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'funding-4h-wif'])
    const adapter = createKucoinAdapter({ client, clock, deny: ['WIF'] })
    await adapter.init()
    expect(adapter.markets().map((m) => m.normalized)).toEqual(['BTC'])
  })

  it('maps predictedFunding to signed percent + epoch ms', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createKucoinAdapter({ client, clock })
    await adapter.init()
    expect(await adapter.predictedFunding('BTC')).toEqual({ symbol: 'BTC', rate: -0.05, ts: 1_000 })
  })

  it('maps fundingHistory to signed percent and filters to the range', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createKucoinAdapter({ client, clock })
    await adapter.init()
    expect(await adapter.fundingHistory('BTC', { fromTs: 900, toTs: 6_000 })).toEqual([
      { symbol: 'BTC', rate: 0.01, settleTs: 1_000 },
      { symbol: 'BTC', rate: 0.02, settleTs: 5_000 },
    ])
  })

  it('reloads hourly and swaps in the fresh registry on a virtual-clock advance', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc'])
    const adapter = createKucoinAdapter({ client: c.client, clock })
    await adapter.init()
    expect(c.loads()).toBe(1)

    c.setStems(['clean-perp-btc', 'funding-4h-wif'])
    clock.advanceBy(HOUR_MS)
    await flush()

    expect(c.loads()).toBe(2)
    expect(adapter.markets().map((m) => m.normalized)).toEqual(['BTC', 'WIF'])
  })

  it('close cancels the pending reload timer', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc'])
    const adapter = createKucoinAdapter({ client: c.client, clock })
    await adapter.init()
    await adapter.close()

    clock.advanceBy(HOUR_MS * 3)
    await flush()
    expect(c.loads()).toBe(1) // no reload after close
  })

  it('order path, streams and account setup all fail loud without their deps', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createKucoinAdapter({ client, clock })
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
    const adapter = createKucoinAdapter({
      client,
      clock,
      accountSetup: {
        // Already ISOLATED + one-way → both reads short-circuit their writes.
        getMarginMode: () => Promise.resolve({ data: { marginMode: 'ISOLATED' } }),
        updateMarginMode: () => {
          seen.push('marginMode')
          return Promise.resolve({})
        },
        getPositionMode: () => Promise.resolve({ data: { positionMode: '0' } }),
        updatePositionMode: () => {
          seen.push('positionMode')
          return Promise.resolve({})
        },
      },
    })
    await adapter.init()
    await expect(adapter.setPositionMode('one_way')).resolves.toBeUndefined()
    await expect(adapter.setMarginMode('BTC', 'isolated')).resolves.toBeUndefined()
    await expect(adapter.setLeverage('BTC', 5)).resolves.toBeUndefined()
    // Nothing was written — and leverage was never a venue call in the first place.
    expect(seen).toEqual([])
  })

  it('logs an unmapped venue error code via the injected log callback', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const limiter = { acquire: () => Promise.resolve() }
    const log = vi.fn()
    const adapter = createKucoinAdapter({ client, clock, limiter, log })
    await adapter.init()
    client.fetchBalance = () => Promise.reject(Object.assign(new Error('mystery venue error'), { code: '999999' }))

    await expect(adapter.getBalance()).rejects.toMatchObject({ kind: 'NetworkError' })
    // KuCoin codes are STRINGS on the wire, so the logged rawCode is `'999999'`, not the number.
    expect(log).toHaveBeenCalledWith('kucoin: unmapped venue error code', { rawCode: '999999' })
  })
})

describe('createKucoinAdapter — account REST reads', () => {
  /** Build a ready adapter over the ['clean-perp-btc'] registry with ccxt overrides applied. */
  async function withClient(overrides: Partial<KucoinMarketClient>): Promise<ExchangeAdapter> {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createKucoinAdapter({ client: { ...client, ...overrides }, clock })
    await adapter.init()
    return adapter
  }

  it('getPositions resolves the canonical symbol via info.symbol (not OKX’s instId)', async () => {
    const adapter = await withClient({
      fetchPositions: () =>
        Promise.resolve([
          { symbol: 'BTC/USDT:USDT', info: { symbol: 'XBTUSDTM' }, side: 'short', contracts: 5, entryPrice: 62_800.3 },
          // Unknown venue symbol → dropped (never guessed from ccxt's unified name).
          { symbol: 'DOGE/USDT:USDT', info: { symbol: 'DOGEUSDTM' }, side: 'long', contracts: 5 },
          // `info.instId` is the OKX field and means nothing here — also dropped.
          { symbol: 'BTC/USDT:USDT', info: { instId: 'XBTUSDTM' }, side: 'long', contracts: 7 },
        ] as Position[]),
    })
    expect(await adapter.getPositions()).toEqual([{ symbol: 'BTC', side: 'short', qty: 5, entryPrice: 62_800.3 }])
  })

  it('getBalance reads the USDT quote asset free/used, defaulting to 0 when absent', async () => {
    const withQuote = await withClient({
      fetchBalance: () =>
        Promise.resolve({ info: {}, USDT: { free: 9_935.08, used: 64.92, total: 10_000 } } as unknown as Balances),
    })
    expect(await withQuote.getBalance()).toEqual({ asset: 'USDT', free: 9_935.08, used: 64.92 })

    const empty = await withClient({ fetchBalance: () => Promise.resolve({ info: {} } as Balances) })
    expect(await empty.getBalance()).toEqual({ asset: 'USDT', free: 0, used: 0 })
  })

  it('getOpenOrders maps rows and filters to one canonical symbol', async () => {
    const adapter = await withClient({
      fetchOpenOrders: () =>
        Promise.resolve([
          {
            clientOrderId: 'BTC-1785080220000-exit-1',
            id: 'kc-1',
            info: { symbol: 'XBTUSDTM' },
            side: 'sell',
            type: 'limit',
            status: 'open',
            filled: 0,
            reduceOnly: true,
          },
          { clientOrderId: 'x', id: 'kc-2', info: { symbol: 'DOGEUSDTM' }, side: 'buy', type: 'market' },
        ] as Order[]),
    })
    expect(await adapter.getOpenOrders('BTC')).toEqual([
      {
        clientOrderId: 'BTC-1785080220000-exit-1',
        venueOrderId: 'kc-1',
        symbol: 'BTC',
        side: 'short',
        type: 'limit',
        status: 'OPEN',
        reduceOnly: true,
      },
    ])
  })
})

/**
 * The read that makes KuCoin the outlier of the five. OKX and Bitget both demand the instrument,
 * so their `getOrder` rides a submit-time `clientOrderId → symbol` map and an unknown id is a
 * *local* NotFound. Here the client id alone is the whole query, so the read reaches the venue
 * regardless — which is why the exact arguments, not just the result, are the assertion.
 */
describe('createKucoinAdapter — getOrder reads by clientOid, with NO symbol', () => {
  it('passes the client id as a param and undefined for the instrument', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc'])
    const adapter = createKucoinAdapter({ client: c.client, clock })
    await adapter.init()

    const order = await adapter.getOrder('BTC-1785080220000-entry-1')
    expect(c.orderReads).toEqual([['', undefined, { clientOid: 'BTC-1785080220000-entry-1' }]])
    // The canonical symbol still comes back, resolved off the row's own `info.symbol`.
    expect(order).toMatchObject({ clientOrderId: 'BTC-1785080220000-entry-1', symbol: 'BTC', status: 'OPEN' })
  })

  it('reaches the venue for an id this process never submitted (no local map short-circuit)', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc'])
    const adapter = createKucoinAdapter({ client: c.client, clock })
    await adapter.init()
    await adapter.getOrder('BTC-1785080220000-exit-9')
    expect(c.orderReads).toHaveLength(1)
  })

  it('turns an empty venue row into a typed NotFound rather than a half-built Order', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createKucoinAdapter({
      client: { ...client, fetchOrder: () => Promise.resolve(undefined as unknown as Order) },
      clock,
    })
    await adapter.init()
    await expect(adapter.getOrder('BTC-1785080220000-entry-1')).rejects.toThrow(/not found/)
  })
})

describe('createKucoinAdapter — fundingIncome (real fetchFundingHistory read)', () => {
  const RANGE = { fromTs: 1_000, toTs: 10_000 }

  /** One settlement row as ccxt's KuCoin branch surfaces it (raw row under `info`). */
  function fundingRow(amount: number | undefined, timestamp: number | undefined, venue = 'XBTUSDTM'): FundingHistory {
    return { info: { symbol: venue }, symbol: 'BTC/USDT:USDT', code: 'USDT', amount, timestamp } as FundingHistory
  }

  async function withFunding(rows: FundingHistory[]): Promise<{ adapter: ExchangeAdapter; args: unknown[][] }> {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const args: unknown[][] = []
    const adapter = createKucoinAdapter({
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
    const { adapter } = await withFunding([fundingRow(0.42, 2_000), fundingRow(-0.1213, 3_000)])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([
      { symbol: 'BTC', amount: 0.42, fundingTime: 2_000 },
      { symbol: 'BTC', amount: -0.1213, fundingTime: 3_000 },
    ])
  })

  it('queries the venue symbol over the range (since + an explicit endAt param)', async () => {
    const { adapter, args } = await withFunding([])
    await adapter.fundingIncome('BTC', RANGE)
    expect(args[0]).toEqual(['XBTUSDTM', 1_000, undefined, { endAt: 10_000 }])
  })

  it('filters the range CLIENT-side — `since` only bounds the first page of the read', async () => {
    const { adapter } = await withFunding([
      fundingRow(0.5, 500), // before the window
      fundingRow(0.5, 99_000), // after the window
      fundingRow(0, 2_000), // zero settlement — not an income event
      fundingRow(0.5, 2_000, 'ETHUSDTM'), // another instrument's settlement
      fundingRow(0.5, 2_500),
    ])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([{ symbol: 'BTC', amount: 0.5, fundingTime: 2_500 }])
  })

  it('keeps the boundary rows — the range is inclusive at both ends', async () => {
    const { adapter } = await withFunding([fundingRow(0.1, RANGE.fromTs), fundingRow(0.2, RANGE.toTs)])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([
      { symbol: 'BTC', amount: 0.1, fundingTime: 1_000 },
      { symbol: 'BTC', amount: 0.2, fundingTime: 10_000 },
    ])
  })

  it('drops a row with no timestamp — an unplaceable settlement is never dated by guesswork', async () => {
    const { adapter } = await withFunding([fundingRow(0.25, undefined)])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([])
  })
})
