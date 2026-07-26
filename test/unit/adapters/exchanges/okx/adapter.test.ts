/**
 * Unit: OKX adapter (`10` §2–§4, `11` §6–§7), fixture-driven and fully offline against a fake
 * ccxt slice. Mirrors the Bybit sibling — registry load/validate/reload, `markets()`/
 * `normalize()`, the account REST reads, unmapped-code logging, fail-loud unwired paths — plus
 * the OKX-only behaviours worth pinning:
 *  - **two registry calls**: the funding interval is not a metadata field, it is
 *    `nextFundingTime − fundingTime` off the funding-rate read;
 *  - **the venue id is `info.instId`**, so every ccxt payload resolves on a different field
 *    than on either prior venue;
 *  - **`fundingIncome` is real**: account bills `type=8`, `balChg` **positive = received**,
 *    filtered to the instrument and the range.
 *
 * The contract-size chain (task 0430 DoD 1) lives in its own file,
 * `./contract-size-chain.test.ts`.
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
import { createOkxAdapter } from '../../../../../src/adapters/exchanges/okx/adapter.js'
import type { OkxMarketClient } from '../../../../../src/adapters/exchanges/okx/factory.js'
import type { ExchangeAdapter } from '../../../../../src/core/ports/exchange-adapter.js'
import { loadFundingRows, loadMarkets } from './fixtures.js'

const HOUR_MS = 3_600_000

/**
 * The captured funding rows as ccxt surfaces them: the raw venue row under `info` (which is
 * where the interval derivation reads `fundingTime`/`nextFundingTime`) plus the unified
 * fields. `BTC` and `XRP` are 8 h; `LAYER` is the venue's 4 h cadence.
 */
function fundingRatesFixture(): FundingRates {
  const out: FundingRates = {}
  for (const [instId, row] of Object.entries(loadFundingRows())) {
    out[instId] = { symbol: instId, info: row, fundingRate: -0.0005, timestamp: 1_000 } as unknown as FundingRate
  }
  return out
}

/** A fixture-backed fake with a swappable market set and per-call counters. */
function makeClient(initial: readonly string[]) {
  let stems = [...initial]
  let loads = 0
  let fundingReads = 0
  const client: OkxMarketClient = {
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
    fetchFundingRates() {
      fundingReads++
      return Promise.resolve(fundingRatesFixture())
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
      return Promise.resolve({
        clientOrderId: id,
        symbol,
        info: { instId: symbol },
        status: 'open',
        filled: 0,
      } as Order)
    },
    fetchOpenOrders() {
      return Promise.resolve([])
    },
    fetchLedger() {
      return Promise.resolve([])
    },
  }
  return { client, setStems: (s: string[]) => (stems = s), loads: () => loads, fundingReads: () => fundingReads }
}

/** Let the fire-and-forget reload's resolved-promise chain settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('createOkxAdapter', () => {
  it('type-checks as ExchangeAdapter with no cast (DoD)', () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter: ExchangeAdapter = createOkxAdapter({ client, clock })
    expect(adapter).toBeDefined()
  })

  it('init loads + validates the registry; markets()/normalize() read it', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'ctval-100-xrp'])
    const adapter = createOkxAdapter({ client, clock })
    await adapter.init()

    expect(adapter.markets()).toEqual([
      { normalized: 'BTC', venueSymbol: 'BTC-USDT-SWAP', status: 'trading' },
      { normalized: 'XRP', venueSymbol: 'XRP-USDT-SWAP', status: 'trading' },
    ])
    // The venue's face value, not a name prefix — this is the OKX-specific half.
    expect(adapter.normalize('BTC').contractSize).toBe(0.01)
    expect(adapter.normalize('XRP').contractSize).toBe(100)
  })

  it('derives fundingIntervalHours from the funding-rate read — a SECOND call, no metadata field', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc', 'funding-4h-layer'])
    const adapter = createOkxAdapter({ client: c.client, clock })
    await adapter.init()
    expect(c.loads()).toBe(1)
    expect(c.fundingReads()).toBe(1) // Bybit needs none; OKX ships no interval field at all
    expect(adapter.normalize('BTC').fundingIntervalHours).toBe(8)
    expect(adapter.normalize('LAYER').fundingIntervalHours).toBe(4)
  })

  it('normalize fails loud on an unknown symbol (sim parity)', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createOkxAdapter({ client, clock })
    await adapter.init()
    expect(() => adapter.normalize('DOGE')).toThrow(/unknown symbol 'DOGE'/)
  })

  it('init aborts (throws) when the load carries an anomalous instrument', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'anomaly-zero-contractsize'])
    const adapter = createOkxAdapter({ client, clock })
    await expect(adapter.init()).rejects.toThrow(/contractSize/)
  })

  it('honors symbols.deny', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc', 'ctval-100-xrp'])
    const adapter = createOkxAdapter({ client, clock, deny: ['XRP'] })
    await adapter.init()
    expect(adapter.markets().map((m) => m.normalized)).toEqual(['BTC'])
  })

  it('maps predictedFunding to signed percent + epoch ms', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createOkxAdapter({ client, clock })
    await adapter.init()
    expect(await adapter.predictedFunding('BTC')).toEqual({ symbol: 'BTC', rate: -0.05, ts: 1_000 })
  })

  it('maps fundingHistory to signed percent and filters to the range', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createOkxAdapter({ client, clock })
    await adapter.init()
    expect(await adapter.fundingHistory('BTC', { fromTs: 900, toTs: 6_000 })).toEqual([
      { symbol: 'BTC', rate: 0.01, settleTs: 1_000 },
      { symbol: 'BTC', rate: 0.02, settleTs: 5_000 },
    ])
  })

  it('reloads hourly and swaps in the fresh registry on a virtual-clock advance', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc'])
    const adapter = createOkxAdapter({ client: c.client, clock })
    await adapter.init()
    expect(adapter.markets()).toHaveLength(1)
    expect(c.loads()).toBe(1)

    c.setStems(['clean-perp-btc', 'ctval-100-xrp'])
    clock.advanceBy(HOUR_MS)
    await flush()

    expect(c.loads()).toBe(2)
    expect(adapter.markets().map((m) => m.normalized)).toEqual(['BTC', 'XRP'])
  })

  it('close cancels the pending reload timer', async () => {
    const clock = createVirtualClock(0)
    const c = makeClient(['clean-perp-btc'])
    const adapter = createOkxAdapter({ client: c.client, clock })
    await adapter.init()
    await adapter.close()

    clock.advanceBy(HOUR_MS * 3)
    await flush()
    expect(c.loads()).toBe(1) // no reload after close
  })

  it('order path, streams and account setup all fail loud without their deps', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createOkxAdapter({ client, clock })
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
    const adapter = createOkxAdapter({
      client,
      clock,
      accountSetup: {
        getAccountConfiguration: () => Promise.resolve([{ acctLv: '2', posMode: 'long_short_mode' }]),
        setLeverage: () => {
          seen.push('leverage')
          return Promise.resolve({})
        },
        setPositionMode: () => {
          seen.push('position')
          return Promise.resolve({})
        },
        setAccountMode: () => {
          seen.push('accountLevel')
          return Promise.resolve({})
        },
      },
    })
    await adapter.init()
    await expect(adapter.setPositionMode('one_way')).resolves.toBeUndefined()
    // acctLv 2 already supports the per-order isolated tdMode → no account-level write.
    await expect(adapter.setMarginMode('BTC', 'isolated')).resolves.toBeUndefined()
    await expect(adapter.setLeverage('BTC', 5)).resolves.toBeUndefined()
    expect(seen).toEqual(['position', 'leverage'])
  })

  it('logs an unmapped venue error code via the injected log callback', async () => {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const limiter = { acquire: () => Promise.resolve() }
    const log = vi.fn()
    const adapter = createOkxAdapter({ client, clock, limiter, log })
    await adapter.init()
    client.fetchBalance = () => Promise.reject(Object.assign(new Error('mystery venue error'), { code: '99999' }))

    await expect(adapter.getBalance()).rejects.toMatchObject({ kind: 'NetworkError' })
    expect(log).toHaveBeenCalledWith('okx: unmapped venue error code', { rawCode: 99999 })
  })
})

describe('createOkxAdapter — account REST reads', () => {
  /** Build a ready adapter over the ['clean-perp-btc'] registry with ccxt overrides applied. */
  async function withClient(overrides: Partial<OkxMarketClient>): Promise<ExchangeAdapter> {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const adapter = createOkxAdapter({ client: { ...client, ...overrides }, clock })
    await adapter.init()
    return adapter
  }

  it('getPositions resolves the canonical symbol via info.instId (not info.symbol)', async () => {
    const adapter = await withClient({
      fetchPositions: () =>
        Promise.resolve([
          {
            symbol: 'BTC/USDT:USDT',
            info: { instId: 'BTC-USDT-SWAP' },
            side: 'short',
            contracts: 3,
            entryPrice: 60_000,
          },
          // Unknown venue id → dropped (never guessed).
          { symbol: 'DOGE/USDT:USDT', info: { instId: 'DOGE-USDT-SWAP' }, side: 'long', contracts: 5 },
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
            id: 'ok-1',
            info: { instId: 'BTC-USDT-SWAP', reduceOnly: 'true' },
            side: 'sell',
            type: 'limit',
            status: 'open',
            filled: 0,
          },
          { clientOrderId: 'x', id: 'ok-2', info: { instId: 'DOGE-USDT-SWAP' }, side: 'buy', type: 'market' },
        ] as Order[]),
    })
    expect(await adapter.getOpenOrders('BTC')).toEqual([
      {
        clientOrderId: 'BTC-1-exit-1',
        venueOrderId: 'ok-1',
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

describe('createOkxAdapter — fundingIncome (real account-bills read)', () => {
  const RANGE = { fromTs: 1_000, toTs: 10_000 }

  /** One `/api/v5/account/bills` row as ccxt surfaces it (raw fields under `info`). */
  function ledgerRow(info: Record<string, unknown>, timestamp?: number): LedgerEntry {
    return { info, timestamp, currency: 'USDT' } as LedgerEntry
  }

  async function withLedger(rows: LedgerEntry[]): Promise<{ adapter: ExchangeAdapter; params: unknown[] }> {
    const clock = createVirtualClock(0)
    const { client } = makeClient(['clean-perp-btc'])
    const params: unknown[] = []
    const adapter = createOkxAdapter({
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

  it('maps funding-fee bills with balChg positive = received (no negation, unlike the WS delta)', async () => {
    const { adapter } = await withLedger([
      ledgerRow({ type: '8', instId: 'BTC-USDT-SWAP', balChg: '0.42' }, 2_000),
      ledgerRow({ type: '8', instId: 'BTC-USDT-SWAP', balChg: '-0.13' }, 3_000),
    ])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([
      { symbol: 'BTC', amount: 0.42, fundingTime: 2_000 },
      { symbol: 'BTC', amount: -0.13, fundingTime: 3_000 },
    ])
  })

  it('queries the SWAP bills for the instrument over the range, with no `type` param', async () => {
    // `type` is ccxt's reserved key for the *market* type: sending OKX's bill type through it
    // arrives as `instType=8` and the venue answers `51000 Parameter instType error` (live,
    // task 0430). The bill-type gate is the row filter, not a request param.
    const { adapter, params } = await withLedger([])
    await adapter.fundingIncome('BTC', RANGE)
    expect(params[0]).toEqual({
      instType: 'SWAP',
      instId: 'BTC-USDT-SWAP',
      begin: '1000',
      end: '10000',
    })
  })

  it('drops other bill types, other instruments, zero change, and out-of-range timestamps', async () => {
    const { adapter } = await withLedger([
      ledgerRow({ type: '2', instId: 'BTC-USDT-SWAP', balChg: '0.5' }, 2_000),
      ledgerRow({ type: '8', instId: 'ETH-USDT-SWAP', balChg: '0.5' }, 2_000),
      ledgerRow({ type: '8', instId: 'BTC-USDT-SWAP', balChg: '0' }, 2_000),
      ledgerRow({ type: '8', instId: 'BTC-USDT-SWAP', balChg: '0.5' }, 99_000),
      ledgerRow({ type: '8', instId: 'BTC-USDT-SWAP', balChg: '0.5' }, 2_500),
    ])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([{ symbol: 'BTC', amount: 0.5, fundingTime: 2_500 }])
  })

  it('falls back to the raw ts when ccxt carries no timestamp (it drops `since` on this call)', async () => {
    const { adapter } = await withLedger([
      ledgerRow({ type: '8', instId: 'BTC-USDT-SWAP', balChg: '0.25', ts: '4000' }),
    ])
    expect(await adapter.fundingIncome('BTC', RANGE)).toEqual([{ symbol: 'BTC', amount: 0.25, fundingTime: 4_000 }])
  })
})
