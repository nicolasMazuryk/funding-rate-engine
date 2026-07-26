/**
 * Unit: Bitget `Instrument` mapping, universe filter and registry build (`10` §3–§4),
 * fixture-driven and fully offline.
 *
 * Mirrors the OKX/Bybit siblings, pinning the three things Bitget does differently:
 *  - **the funding interval is one field, already in hours** — `info.fundInterval` as a string
 *    (`"8"`, `"4"`, `"1"`). No second REST read (Binance), no derivation from two timestamps
 *    (OKX), no minutes→hours conversion (Bybit). All three live cadences are captured, so a
 *    unit slip would show up as a `∉ {1,2,4,8}` throw rather than as silent mis-scheduling;
 *  - **`contractSize` is `1` on the entire linear listing**, and anything else is fatal. Bitget
 *    publishes no per-instrument face value to cross-check against (`info.sizeMultiplier` is
 *    the *quantity step*), so the enforced invariant is the equality itself — a future listing
 *    that ships a real face value fails startup instead of mis-sizing every order;
 *  - consequently **the multiplier prefix is the only face value in play**, folded into
 *    `contractSize` at map time (`1000BONK` → 1000). The sizing consequences of that fold are
 *    `./contract-size-chain.test.ts`.
 */

import type { MarketInterface } from 'ccxt'
import { describe, expect, it, vi } from 'vitest'
import {
  buildInstrumentRegistry,
  ccxtMarketToInstrument,
  filterMarkets,
  readFundingIntervalHours,
} from '../../../../../src/adapters/exchanges/bitget/instrument.js'
import { loadMarket, loadMarkets } from './fixtures.js'

/**
 * A captured market with its raw `fundInterval` overridden — the cadences below (`"3"`, `""`)
 * are not on the live listing, so there is no fixture to capture for them, but both are
 * reachable the moment Bitget adds a symbol or blanks a field.
 */
function withFundInterval(stem: string, fundInterval: string): MarketInterface {
  const market = loadMarket(stem)
  return { ...market, info: { ...market.info, fundInterval } }
}

describe('readFundingIntervalHours (info.fundInterval, already in hours)', () => {
  it('reads all three live cadences straight off the captured rows', () => {
    expect(readFundingIntervalHours(loadMarket('clean-perp-btc').info)).toBe(8)
    expect(readFundingIntervalHours(loadMarket('funding-4h-xtz').info)).toBe(4)
    expect(readFundingIntervalHours(loadMarket('funding-1h-dexe').info)).toBe(1)
  })

  it('treats a blank field as absent rather than as 0 hours', () => {
    // `Number('')` is 0, and Bitget writes `""` for "no value" — a 0 leaking through would be
    // an out-of-set interval instead of the 8h default the caller wants.
    expect(readFundingIntervalHours({ fundInterval: '' })).toBeUndefined()
  })

  it('returns undefined for a missing field or a non-object row', () => {
    expect(readFundingIntervalHours({})).toBeUndefined()
    expect(readFundingIntervalHours(undefined)).toBeUndefined()
    expect(readFundingIntervalHours(null)).toBeUndefined()
  })
})

describe('filterMarkets (10 §3)', () => {
  const stems = ['clean-perp-btc', 'spot-btc', 'inverse-coinm', 'delisted', 'multiplier-1000-bonk']
  const markets = stems.map(loadMarket)

  it('keeps only active linear USDT-settled perps', () => {
    expect(filterMarkets(markets).map((m) => m.id)).toEqual(['BTCUSDT', '1000BONKUSDT'])
  })

  it('drops spot, inverse coin-margined, and delisted rows', () => {
    const kept = filterMarkets(markets).map((m) => m.id)
    for (const id of ['BTCUSD', 'OLDUSDT']) expect(kept).not.toContain(id)
    // The spot row shares the venue id `BTCUSDT`; it is dropped on `type`/`settle`, not on id.
    expect(filterMarkets(markets).filter((m) => m.id === 'BTCUSDT').length).toBe(1)
  })

  it('removes a symbol named in symbols.deny by its canonical name, not its venue symbol', () => {
    // The deny list holds `BONK`; the listing is `1000BONKUSDT`.
    expect(filterMarkets(markets, ['BONK']).map((m) => m.id)).toEqual(['BTCUSDT'])
  })
})

describe('ccxtMarketToInstrument denomination', () => {
  it('maps the clean 8h BTC perp to base-unit fields', () => {
    expect(ccxtMarketToInstrument(loadMarket('clean-perp-btc'))).toEqual({
      normalized: 'BTC',
      venueSymbol: 'BTCUSDT',
      contractSize: 1, // Bitget sizes BTCUSDT in BTC, not in contracts
      pricePrecision: 0.1,
      amountPrecision: 0.0001,
      minNotional: 5, // `limits.cost.min` = the venue's `minTradeUSDT`
      minQty: 0.0001,
      fundingIntervalHours: 8,
    })
  })

  it('folds a 1000 multiplier into contractSize and normalizes the name', () => {
    expect(ccxtMarketToInstrument(loadMarket('multiplier-1000-bonk'))).toEqual({
      normalized: 'BONK',
      venueSymbol: '1000BONKUSDT', // the venue symbol stays intact for API calls
      contractSize: 1000,
      pricePrecision: 0.000001,
      amountPrecision: 1,
      minNotional: 5,
      minQty: 1,
      fundingIntervalHours: 4,
    })
  })

  it('folds a 1000000 multiplier into contractSize', () => {
    expect(ccxtMarketToInstrument(loadMarket('multiplier-1000000-mog'))).toMatchObject({
      normalized: 'MOG',
      venueSymbol: '1000000MOGUSDT',
      contractSize: 1_000_000,
      fundingIntervalHours: 4,
    })
  })

  it('keeps a digit-leading base intact and its contractSize at 1', () => {
    expect(ccxtMarketToInstrument(loadMarket('digit-base-1inch'))).toMatchObject({
      normalized: '1INCH',
      venueSymbol: '1INCHUSDT',
      contractSize: 1,
    })
  })

  it('carries the 4h and 1h cadences onto the Instrument', () => {
    expect(ccxtMarketToInstrument(loadMarket('funding-4h-xtz')).fundingIntervalHours).toBe(4)
    expect(ccxtMarketToInstrument(loadMarket('funding-1h-dexe')).fundingIntervalHours).toBe(1)
  })

  it('falls back to 8h when the row carries no usable fundInterval', () => {
    expect(ccxtMarketToInstrument(withFundInterval('clean-perp-btc', '')).fundingIntervalHours).toBe(8)
  })
})

describe('ccxtMarketToInstrument fail-loud (10 §4)', () => {
  it('throws on missing price precision', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-missing-precision'))).toThrow(/price precision/)
  })

  it('throws on zero contractSize', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-zero-contractsize'))).toThrow(
      /missing or non-positive contractSize/,
    )
  })

  it('throws on an unparsable base symbol', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-unparsable-base'))).toThrow(/unparsable base symbol/)
  })

  it('throws when a listing ships a contractSize other than 1 (the Bitget-only invariant)', () => {
    // Bitget publishes no face value to reconcile against, so a `contractSize ≠ 1` means the
    // venue changed its denomination model — trading on it would mis-size every order 100×.
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-contractsize-not-one'))).toThrow(
      /contractSize 100 ≠ 1 — Bitget sizes in base units/,
    )
  })

  it('throws on an out-of-set funding interval (3h)', () => {
    expect(() => ccxtMarketToInstrument(withFundInterval('clean-perp-btc', '3'))).toThrow(/3h ∉ \{1,2,4,8\}/)
  })
})

describe('buildInstrumentRegistry', () => {
  it('keys the validated registry by canonical name, with per-symbol intervals', () => {
    const markets = loadMarkets(['clean-perp-btc', 'funding-4h-xtz', 'funding-1h-dexe', 'multiplier-1000-bonk'])
    const registry = buildInstrumentRegistry(Object.values(markets))
    expect([...registry.keys()].sort()).toEqual(['BONK', 'BTC', 'DEXE', 'XTZ'])
    expect(registry.get('BTC')?.fundingIntervalHours).toBe(8)
    expect(registry.get('XTZ')?.fundingIntervalHours).toBe(4)
    expect(registry.get('DEXE')?.fundingIntervalHours).toBe(1)
    expect(registry.get('BONK')?.contractSize).toBe(1000)
  })

  it('skips ccxt’s undefined dictionary slots', () => {
    expect(buildInstrumentRegistry([loadMarket('clean-perp-btc'), undefined]).size).toBe(1)
  })

  it('aborts the whole load when any instrument is anomalous', () => {
    expect(() =>
      buildInstrumentRegistry([loadMarket('clean-perp-btc'), loadMarket('anomaly-zero-contractsize')]),
    ).toThrow(/contractSize/)
  })

  it('resolves the live BONK collision to the plain listing, either order', () => {
    // Bitget lists both BONKUSDT and 1000BONKUSDT, so this is a real load, not a forward guard.
    const plainFirst = buildInstrumentRegistry([loadMarket('plain-bonk'), loadMarket('multiplier-1000-bonk')])
    const multiFirst = buildInstrumentRegistry([loadMarket('multiplier-1000-bonk'), loadMarket('plain-bonk')])
    expect(plainFirst.get('BONK')?.venueSymbol).toBe('BONKUSDT')
    expect(multiFirst.get('BONK')?.venueSymbol).toBe('BONKUSDT')
    // The winner brings its own contractSize: the plain listing is 1, not the folded 1000.
    expect(plainFirst.get('BONK')?.contractSize).toBe(1)
    expect(multiFirst.get('BONK')?.contractSize).toBe(1)
    expect(plainFirst.size).toBe(1)
    expect(multiFirst.size).toBe(1)
  })

  it('logs the dropped listing on a collision', () => {
    const log = vi.fn()
    buildInstrumentRegistry([loadMarket('plain-bonk'), loadMarket('multiplier-1000-bonk')], [], log)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('bitget: dropped colliding instrument listing', {
      normalized: 'BONK',
      venueSymbol: '1000BONKUSDT',
      keptMultiplier: 1,
      droppedMultiplier: 1000,
    })
  })
})
