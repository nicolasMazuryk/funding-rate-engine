/**
 * Unit: Bybit symbol normalization + `Instrument` mapping/registry (`10` §3–§4), fixture-driven
 * and fully offline. Mirrors the Binance sibling, plus the Bybit-only cases: the `10000`
 * multiplier, the `1INCH`/`2Z`/`0G` false-positive guard, the **minutes → hours** funding
 * conversion (incl. a real 240 → 4h row and a `0` → reject), and the `minNotionalValue`
 * fallback ccxt leaves out of `limits.cost`.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildInstrumentRegistry,
  ccxtMarketToInstrument,
  filterMarkets,
} from '../../../../../src/adapters/exchanges/bybit/instrument.js'
import { normalizeSymbol } from '../../../../../src/adapters/exchanges/bybit/normalize-symbol.js'
import { loadMarket } from './fixtures.js'

describe('normalizeSymbol', () => {
  it('strips a 1000 multiplier and reports it', () => {
    expect(normalizeSymbol('1000PEPE')).toEqual({ normalized: 'PEPE', multiplier: 1000 })
  })
  it('strips a 10000 multiplier and reports it (Bybit-only prefix)', () => {
    expect(normalizeSymbol('10000SATS')).toEqual({ normalized: 'SATS', multiplier: 10_000 })
  })
  it('strips a 1000000 multiplier, longest prefix first', () => {
    expect(normalizeSymbol('1000000MOG')).toEqual({ normalized: 'MOG', multiplier: 1_000_000 })
  })
  it('leaves a plain base untouched (multiplier 1)', () => {
    expect(normalizeSymbol('BTC')).toEqual({ normalized: 'BTC', multiplier: 1 })
  })
  it('does not strip digits that are part of the name (live Bybit false-positive traps)', () => {
    expect(normalizeSymbol('1INCH')).toEqual({ normalized: '1INCH', multiplier: 1 })
    expect(normalizeSymbol('2Z')).toEqual({ normalized: '2Z', multiplier: 1 })
    expect(normalizeSymbol('0G')).toEqual({ normalized: '0G', multiplier: 1 })
  })
})

describe('filterMarkets (10 §3)', () => {
  const stems = ['clean-perp-btc', 'spot-btc', 'inverse-coinm', 'dated-expiry', 'delisted', 'multiplier-pepe']
  const markets = stems.map(loadMarket)

  it('keeps only active linear USDT perps', () => {
    expect(filterMarkets(markets).map((m) => m.id)).toEqual(['BTCUSDT', '1000PEPEUSDT'])
  })

  it('drops spot, inverse, dated expiry, and delisted', () => {
    const kept = filterMarkets(markets).map((m) => m.id)
    for (const id of ['BTCUSD', 'BTC-26DEC25', 'LUNAUSDT']) expect(kept).not.toContain(id)
  })

  it('removes a symbol named in symbols.deny (by canonical name)', () => {
    expect(filterMarkets(markets, ['PEPE']).map((m) => m.id)).toEqual(['BTCUSDT'])
  })
})

describe('ccxtMarketToInstrument denomination', () => {
  it('maps a clean 8h perp to base-unit fields, reading minNotional off lotSizeFilter', () => {
    // ccxt leaves `limits.cost` empty on Bybit; `info.lotSizeFilter.minNotionalValue` is the truth.
    expect(ccxtMarketToInstrument(loadMarket('clean-perp-btc'))).toEqual({
      normalized: 'BTC',
      venueSymbol: 'BTCUSDT',
      contractSize: 1,
      pricePrecision: 0.1,
      amountPrecision: 0.001,
      minNotional: 5,
      minQty: 0.001,
      fundingIntervalHours: 8,
    })
  })

  it('converts fundingInterval minutes → hours for a real 4h symbol (Bybit majority case)', () => {
    expect(ccxtMarketToInstrument(loadMarket('funding-4h-tia')).fundingIntervalHours).toBe(4)
  })

  it('folds a 1000X multiplier into contractSize', () => {
    const pepe = ccxtMarketToInstrument(loadMarket('multiplier-pepe'))
    expect(pepe).toMatchObject({ normalized: 'PEPE', venueSymbol: '1000PEPEUSDT', contractSize: 1000 })
  })

  it('folds a 10000X multiplier into contractSize (Bybit-only prefix)', () => {
    const sats = ccxtMarketToInstrument(loadMarket('multiplier-sats'))
    expect(sats).toMatchObject({ normalized: 'SATS', venueSymbol: '10000SATSUSDT', contractSize: 10_000 })
  })

  it('folds a 1000000X multiplier into contractSize', () => {
    expect(ccxtMarketToInstrument(loadMarket('multiplier-mog')).contractSize).toBe(1_000_000)
  })

  it('minNotional falls back to 0 when neither ccxt nor the raw row carries one', () => {
    expect(ccxtMarketToInstrument(loadMarket('multiplier-mog')).minNotional).toBe(0)
  })
})

describe('ccxtMarketToInstrument fail-loud (10 §4)', () => {
  it('throws on missing price precision', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-missing-precision'))).toThrow(/price precision/)
  })
  it('throws on zero contractSize', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-zero-contractsize'))).toThrow(/contractSize/)
  })
  it('throws on an unparsable base symbol', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-unparsable-base'))).toThrow(/unparsable base symbol/)
  })
  it('throws on an out-of-set funding interval (180 min = 3h)', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-bad-funding'))).toThrow(/3h ∉ \{1,2,4,8\}/)
  })
  it('throws on a 0-minute funding interval (a dated row leaking past the type filter)', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-zero-funding'))).toThrow(/0h ∉ \{1,2,4,8\}/)
  })
})

describe('buildInstrumentRegistry', () => {
  it('keys the validated registry by canonical name', () => {
    const registry = buildInstrumentRegistry([loadMarket('clean-perp-btc'), loadMarket('multiplier-pepe')])
    expect([...registry.keys()].sort()).toEqual(['BTC', 'PEPE'])
  })

  it('aborts the whole load when any instrument is anomalous', () => {
    expect(() =>
      buildInstrumentRegistry([loadMarket('clean-perp-btc'), loadMarket('anomaly-zero-contractsize')]),
    ).toThrow(/contractSize/)
  })

  it('resolves a plain-vs-multiplier collision to the plain listing, either order', () => {
    const plainFirst = buildInstrumentRegistry([loadMarket('plain-cat'), loadMarket('multiplier-cat')])
    const multiFirst = buildInstrumentRegistry([loadMarket('multiplier-cat'), loadMarket('plain-cat')])
    expect(plainFirst.get('CAT')?.venueSymbol).toBe('CATUSDT')
    expect(multiFirst.get('CAT')?.venueSymbol).toBe('CATUSDT')
    expect(plainFirst.size).toBe(1)
    expect(multiFirst.size).toBe(1)
  })

  it('logs the dropped listing on a collision', () => {
    const log = vi.fn()
    const registry = buildInstrumentRegistry([loadMarket('plain-cat'), loadMarket('multiplier-cat')], [], log)
    expect(registry.get('CAT')?.venueSymbol).toBe('CATUSDT')
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('bybit: dropped colliding instrument listing', {
      normalized: 'CAT',
      venueSymbol: '1000CATUSDT',
      keptMultiplier: 1,
      droppedMultiplier: 1000,
    })
  })
})
