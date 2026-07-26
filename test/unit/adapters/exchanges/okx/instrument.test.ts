/**
 * Unit: OKX symbol normalization + `Instrument` mapping/registry (`10` §3–§4), fixture-driven
 * and fully offline. Mirrors the Bybit sibling, plus the OKX-only cases: `ctVal ≠ 1` as the
 * normal case (BTC 0.01, XRP 100), the funding interval **derived** from the captured
 * funding-rate rows rather than read off metadata, the `ctVal × ctMult` cross-check, and the
 * absence of any per-instrument minimum notional.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildInstrumentRegistry,
  ccxtMarketToInstrument,
  deriveFundingIntervalHours,
  filterMarkets,
} from '../../../../../src/adapters/exchanges/okx/instrument.js'
import { instIdToNormalized, normalizeSymbol } from '../../../../../src/adapters/exchanges/okx/normalize-symbol.js'
import { loadFundingIntervals, loadFundingRows, loadMarket } from './fixtures.js'

describe('normalizeSymbol', () => {
  it('leaves a plain base untouched (multiplier 1) — the whole live OKX listing', () => {
    expect(normalizeSymbol('BTC')).toEqual({ normalized: 'BTC', multiplier: 1 })
    expect(normalizeSymbol('XRP')).toEqual({ normalized: 'XRP', multiplier: 1 })
  })
  it('does not strip digits that are part of the name (live OKX false-positive traps)', () => {
    expect(normalizeSymbol('1INCH')).toEqual({ normalized: '1INCH', multiplier: 1 })
    expect(normalizeSymbol('2Z')).toEqual({ normalized: '2Z', multiplier: 1 })
    expect(normalizeSymbol('0G')).toEqual({ normalized: '0G', multiplier: 1 })
  })
  it('still strips a real multiplier prefix, longest first (forward guard)', () => {
    expect(normalizeSymbol('1000PEPE')).toEqual({ normalized: 'PEPE', multiplier: 1000 })
    expect(normalizeSymbol('1000000MOG')).toEqual({ normalized: 'MOG', multiplier: 1_000_000 })
  })
})

describe('instIdToNormalized', () => {
  it('splits a swap instId to its canonical name', () => {
    expect(instIdToNormalized('BTC-USDT-SWAP')).toBe('BTC')
    expect(instIdToNormalized('1INCH-USDT-SWAP')).toBe('1INCH')
  })
  it('rejects anything that is not a three-part swap id', () => {
    expect(instIdToNormalized('BTC-USDT')).toBeUndefined()
    expect(instIdToNormalized('BTC-USDT-260327')).toBeUndefined()
  })
})

describe('deriveFundingIntervalHours (OKX ships no interval field)', () => {
  it('derives 8h and 4h from the captured funding-rate rows', () => {
    const rows = loadFundingRows()
    const btc = rows['BTC-USDT-SWAP']
    const layer = rows['LAYER-USDT-SWAP']
    expect(deriveFundingIntervalHours(btc?.fundingTime, btc?.nextFundingTime)).toBe(8)
    expect(deriveFundingIntervalHours(layer?.fundingTime, layer?.nextFundingTime)).toBe(4)
  })
  it('returns undefined on a missing, unparsable or non-advancing pair', () => {
    expect(deriveFundingIntervalHours(undefined, '1785081600000')).toBeUndefined()
    expect(deriveFundingIntervalHours('', '1785081600000')).toBeUndefined()
    expect(deriveFundingIntervalHours('1785081600000', '1785081600000')).toBeUndefined()
  })
})

describe('filterMarkets (10 §3)', () => {
  const stems = ['clean-perp-btc', 'spot-btc', 'inverse-coinm', 'dated-expiry', 'delisted', 'ctval-100-xrp']
  const markets = stems.map(loadMarket)

  it('keeps only active linear USDT-settled perps', () => {
    expect(filterMarkets(markets).map((m) => m.id)).toEqual(['BTC-USDT-SWAP', 'XRP-USDT-SWAP'])
  })

  it('drops spot, inverse, dated expiry, and delisted', () => {
    const kept = filterMarkets(markets).map((m) => m.id)
    for (const id of ['BTC-USDT', 'BTC-USD-SWAP', 'BTC-USDT-260327', 'LUNA-USDT-SWAP']) {
      expect(kept).not.toContain(id)
    }
  })

  it('removes a symbol named in symbols.deny (by canonical name)', () => {
    expect(filterMarkets(markets, ['XRP']).map((m) => m.id)).toEqual(['BTC-USDT-SWAP'])
  })
})

describe('ccxtMarketToInstrument denomination', () => {
  it('maps a clean 8h perp, carrying the sub-unit ctVal into contractSize', () => {
    // OKX sizes BTC in 0.01-BTC contracts, and publishes no per-instrument min notional.
    expect(ccxtMarketToInstrument(loadMarket('clean-perp-btc'), 8)).toEqual({
      normalized: 'BTC',
      venueSymbol: 'BTC-USDT-SWAP',
      contractSize: 0.01,
      pricePrecision: 0.1,
      amountPrecision: 0.01,
      minNotional: 0,
      minQty: 0.01,
      fundingIntervalHours: 8,
    })
  })

  it('carries a large ctVal through (XRP = 100 XRP per contract)', () => {
    expect(ccxtMarketToInstrument(loadMarket('ctval-100-xrp'), 8)).toMatchObject({
      normalized: 'XRP',
      venueSymbol: 'XRP-USDT-SWAP',
      contractSize: 100,
    })
  })

  it('keeps a digit-leading base intact and its contractSize at 1', () => {
    expect(ccxtMarketToInstrument(loadMarket('digit-base-1inch'), 8)).toMatchObject({
      normalized: '1INCH',
      venueSymbol: '1INCH-USDT-SWAP',
      contractSize: 1,
    })
  })

  it('takes the derived per-symbol funding interval for a real 4h symbol', () => {
    const hours = loadFundingIntervals().get('LAYER-USDT-SWAP')
    expect(ccxtMarketToInstrument(loadMarket('funding-4h-layer'), hours).fundingIntervalHours).toBe(4)
  })

  it('falls back to 8h when no interval was derived for the symbol', () => {
    expect(ccxtMarketToInstrument(loadMarket('clean-perp-btc')).fundingIntervalHours).toBe(8)
  })

  it('folds a multiplier prefix into contractSize (forward guard, no live listing today)', () => {
    expect(ccxtMarketToInstrument(loadMarket('multiplier-cat'), 8)).toMatchObject({
      normalized: 'CAT',
      venueSymbol: '1000CAT-USDT-SWAP',
      contractSize: 1000,
    })
  })
})

describe('ccxtMarketToInstrument fail-loud (10 §4)', () => {
  it('throws on missing price precision', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-missing-precision'), 8)).toThrow(/price precision/)
  })
  it('throws on zero contractSize', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-zero-contractsize'), 8)).toThrow(/contractSize/)
  })
  it('throws on an unparsable base symbol', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-unparsable-base'), 8)).toThrow(/unparsable base symbol/)
  })
  it('throws when ccxt contractSize disagrees with the venue ctVal×ctMult', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-ctval-mismatch'), 8)).toThrow(
      /contractSize 1 disagrees with ctVal×ctMult 10/,
    )
  })
  it('throws on an out-of-set derived funding interval (3h)', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('clean-perp-btc'), 3)).toThrow(/3h ∉ \{1,2,4,8\}/)
  })
})

describe('buildInstrumentRegistry', () => {
  it('keys the validated registry by canonical name, with derived intervals', () => {
    const registry = buildInstrumentRegistry(
      [loadMarket('clean-perp-btc'), loadMarket('ctval-100-xrp'), loadMarket('funding-4h-layer')],
      [],
      loadFundingIntervals(),
    )
    expect([...registry.keys()].sort()).toEqual(['BTC', 'LAYER', 'XRP'])
    expect(registry.get('LAYER')?.fundingIntervalHours).toBe(4)
    expect(registry.get('BTC')?.fundingIntervalHours).toBe(8)
    expect(registry.get('XRP')?.contractSize).toBe(100)
  })

  it('aborts the whole load when any instrument is anomalous', () => {
    expect(() =>
      buildInstrumentRegistry([loadMarket('clean-perp-btc'), loadMarket('anomaly-zero-contractsize')]),
    ).toThrow(/contractSize/)
  })

  it('resolves a plain-vs-multiplier collision to the plain listing, either order', () => {
    const plainFirst = buildInstrumentRegistry([loadMarket('plain-cat'), loadMarket('multiplier-cat')])
    const multiFirst = buildInstrumentRegistry([loadMarket('multiplier-cat'), loadMarket('plain-cat')])
    expect(plainFirst.get('CAT')?.venueSymbol).toBe('CAT-USDT-SWAP')
    expect(multiFirst.get('CAT')?.venueSymbol).toBe('CAT-USDT-SWAP')
    expect(plainFirst.size).toBe(1)
    expect(multiFirst.size).toBe(1)
  })

  it('logs the dropped listing on a collision', () => {
    const log = vi.fn()
    buildInstrumentRegistry([loadMarket('plain-cat'), loadMarket('multiplier-cat')], [], undefined, log)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('okx: dropped colliding instrument listing', {
      normalized: 'CAT',
      venueSymbol: '1000CAT-USDT-SWAP',
      keptMultiplier: 1,
      droppedMultiplier: 1000,
    })
  })
})
