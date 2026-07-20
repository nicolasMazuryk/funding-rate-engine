import { describe, expect, it } from 'vitest'
import {
  buildInstrumentRegistry,
  ccxtMarketToInstrument,
  filterMarkets,
} from '../../../../../src/adapters/exchanges/binance/instrument.js'
import { normalizeSymbol } from '../../../../../src/adapters/exchanges/binance/normalize-symbol.js'
import { loadMarket } from './fixtures.js'

describe('normalizeSymbol', () => {
  it('strips a 1000 multiplier and reports it', () => {
    expect(normalizeSymbol('1000PEPE')).toEqual({ normalized: 'PEPE', multiplier: 1000 })
  })
  it('strips a 1000000 multiplier and reports it', () => {
    expect(normalizeSymbol('1000000MOG')).toEqual({ normalized: 'MOG', multiplier: 1_000_000 })
  })
  it('leaves a plain base untouched (multiplier 1)', () => {
    expect(normalizeSymbol('BTC')).toEqual({ normalized: 'BTC', multiplier: 1 })
  })
  it('does not strip digits that are part of the name (1INCH)', () => {
    expect(normalizeSymbol('1INCH')).toEqual({ normalized: '1INCH', multiplier: 1 })
  })
})

describe('filterMarkets (10 §3)', () => {
  const stems = ['clean-perp-btc', 'spot-btc', 'inverse-coinm', 'dated-expiry', 'delisted', 'multiplier-pepe']
  const markets = stems.map(loadMarket)

  it('keeps only active linear USDT perps', () => {
    const ids = filterMarkets(markets).map((m) => m.id)
    expect(ids).toEqual(['BTCUSDT', '1000PEPEUSDT'])
  })

  it('drops spot, inverse/coin-margined, dated expiry, and delisted', () => {
    const kept = filterMarkets(markets).map((m) => m.id)
    for (const id of ['BTCUSDT', 'BTCUSD_PERP', 'BTCUSDT_240628', 'SRMUSDT']) {
      if (id === 'BTCUSDT') expect(kept).toContain(id)
      else expect(kept).not.toContain(id)
    }
  })

  it('removes a symbol named in symbols.deny (by canonical name)', () => {
    const kept = filterMarkets(markets, ['PEPE']).map((m) => m.id)
    expect(kept).toEqual(['BTCUSDT'])
  })
})

describe('ccxtMarketToInstrument denomination', () => {
  it('maps a clean perp to base-unit fields', () => {
    expect(ccxtMarketToInstrument(loadMarket('clean-perp-btc'))).toEqual({
      normalized: 'BTC',
      venueSymbol: 'BTCUSDT',
      contractSize: 1,
      pricePrecision: 0.1,
      amountPrecision: 0.001,
      minNotional: 50,
      minQty: 0.001,
      fundingIntervalHours: 8,
    })
  })

  it('folds a 1000X multiplier into contractSize (matches the sim PEPE row)', () => {
    const pepe = ccxtMarketToInstrument(loadMarket('multiplier-pepe'))
    expect(pepe.normalized).toBe('PEPE')
    expect(pepe.venueSymbol).toBe('1000PEPEUSDT')
    expect(pepe.contractSize).toBe(1000)
    expect(pepe.amountPrecision).toBe(1)
    expect(pepe.minQty).toBe(1)
  })

  it('folds a 1000000X multiplier into contractSize', () => {
    expect(ccxtMarketToInstrument(loadMarket('multiplier-mog')).contractSize).toBe(1_000_000)
  })

  it('reads a non-default funding interval from market metadata', () => {
    expect(ccxtMarketToInstrument(loadMarket('funding-4h')).fundingIntervalHours).toBe(4)
  })
})

describe('ccxtMarketToInstrument fail-loud (10 §4)', () => {
  it('throws on missing price precision', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-missing-precision'))).toThrow(/price precision/)
  })
  it('throws on zero contractSize', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-zero-contractsize'))).toThrow(/contractSize/)
  })
  it('throws on an out-of-set funding interval', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-bad-funding'))).toThrow(/∉ \{1,2,4,8\}/)
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
})
