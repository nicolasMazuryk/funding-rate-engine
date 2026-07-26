/**
 * Unit: KuCoin `Instrument` mapping, universe filter and registry build (`10` §3–§4),
 * fixture-driven and fully offline.
 *
 * Mirrors the OKX/Bitget siblings, pinning the three things KuCoin does differently:
 *  - **the funding interval is a millisecond field** — `info.fundingRateGranularity`
 *    (3 600 000 / 14 400 000 / 28 800 000 on the live listing). Binance publishes hours, Bybit
 *    minutes, Bitget hours-as-a-string, OKX nothing at all; KuCoin is the only one in ms, so a
 *    unit slip is a 3 600 000 h interval and shows up as a `∉ {1,2,4,8}` throw rather than as
 *    silent mis-scheduling;
 *  - **the face value lives in `info.multiplier`**, which ccxt copies into `contractSize`. The
 *    two are **cross-checked** and disagreement is fatal — a wrong contract size silently
 *    mis-sizes every order. The sizing consequences are `./contract-size-chain.test.ts`;
 *  - **the name-prefix multiplier is NOT folded into `contractSize`** (the one deviation from the
 *    three siblings), so it survives *only* as the registry's collision tie-breaker: the plain
 *    listing still wins, but for reasons that have nothing to do with the face value it carries.
 */

import type { MarketInterface } from 'ccxt'
import { describe, expect, it, vi } from 'vitest'
import {
  buildInstrumentRegistry,
  ccxtMarketToInstrument,
  filterMarkets,
  readFundingIntervalHours,
} from '../../../../../src/adapters/exchanges/kucoin/instrument.js'
import { loadMarket, loadMarkets } from './fixtures.js'

/**
 * A captured market with its raw `fundingRateGranularity` overridden — the cadences below are not
 * on the live listing, but each is reachable the moment KuCoin adds a symbol or blanks a field.
 */
function withGranularity(stem: string, fundingRateGranularity: unknown): MarketInterface {
  const market = loadMarket(stem)
  return { ...market, info: { ...market.info, fundingRateGranularity } }
}

describe('readFundingIntervalHours (info.fundingRateGranularity, in milliseconds)', () => {
  it('reads all three live cadences straight off the captured rows', () => {
    expect(readFundingIntervalHours(loadMarket('clean-perp-btc').info)).toBe(8) // 28 800 000 ms
    expect(readFundingIntervalHours(loadMarket('funding-4h-wif').info)).toBe(4) // 14 400 000 ms
    expect(readFundingIntervalHours(loadMarket('funding-1h-lrc').info)).toBe(1) // 3 600 000 ms
  })

  it('treats a blank or zero field as absent rather than as 0 hours', () => {
    // `Number('')` is 0, and a 0 leaking through would be an out-of-set interval instead of the
    // 8 h default the caller wants.
    expect(readFundingIntervalHours({ fundingRateGranularity: '' })).toBeUndefined()
    expect(readFundingIntervalHours({ fundingRateGranularity: 0 })).toBeUndefined()
    // The live listing's only `null` is the dated inverse future the filter drops anyway.
    expect(readFundingIntervalHours({ fundingRateGranularity: null })).toBeUndefined()
  })

  it('returns undefined for a missing field or a non-object row', () => {
    expect(readFundingIntervalHours({})).toBeUndefined()
    expect(readFundingIntervalHours(undefined)).toBeUndefined()
    expect(readFundingIntervalHours(null)).toBeUndefined()
  })

  it('parses the ms value the venue sends, not a fixed table', () => {
    expect(readFundingIntervalHours({ fundingRateGranularity: 7_200_000 })).toBe(2)
  })
})

describe('filterMarkets (10 §3)', () => {
  const stems = ['clean-perp-btc', 'spot-btc', 'inverse-coinm-xbt', 'delisted', 'prefix-1000-bonk']
  const markets = stems.map(loadMarket)

  it('keeps only active linear USDT-settled perps', () => {
    expect(filterMarkets(markets).map((m) => m.id)).toEqual(['XBTUSDTM', '1000BONKUSDTM'])
  })

  it('drops the spot row, the coin-margined inverse twin, and the delisted row', () => {
    const kept = filterMarkets(markets).map((m) => m.id)
    // `BTC-USDT` is `ccxt.kucoin`'s spelling — it would only ever appear if the factory built the
    // spot class (`./factory.test.ts`); dropped here on `type`/`settle` regardless.
    for (const id of ['BTC-USDT', 'XBTUSDM', 'OLDUSDTM']) expect(kept).not.toContain(id)
    // `XBTUSDM` is dropped on `settle === 'BTC'` before its `info.multiplier: -1` could ever reach
    // the positive-contract-size guard.
    expect((loadMarket('inverse-coinm-xbt').info as { multiplier: number }).multiplier).toBe(-1)
  })

  it('removes a symbol named in symbols.deny by its canonical name, not its venue symbol', () => {
    // The deny list holds `BONK`; the listing is `1000BONKUSDTM`.
    expect(filterMarkets(markets, ['BONK']).map((m) => m.id)).toEqual(['XBTUSDTM'])
  })
})

describe('ccxtMarketToInstrument denomination', () => {
  it('maps the clean 8h BTC perp, contract size and all', () => {
    expect(ccxtMarketToInstrument(loadMarket('clean-perp-btc'))).toEqual({
      normalized: 'BTC', // ccxt already resolved XBT → BTC (`./normalize-symbol.test.ts`)
      venueSymbol: 'XBTUSDTM',
      contractSize: 0.001, // = info.multiplier: 1 contract is 0.001 BTC
      pricePrecision: 0.1,
      amountPrecision: 1, // integer contracts
      minNotional: 0, // KuCoin publishes no per-instrument min notional (`limits.cost` is empty)
      minQty: 1, // one contract
      fundingIntervalHours: 8,
    })
  })

  it('carries a face value above 1 and one below it', () => {
    expect(ccxtMarketToInstrument(loadMarket('multiplier-100-doge'))).toMatchObject({
      normalized: 'DOGE',
      venueSymbol: 'DOGEUSDTM',
      contractSize: 100,
    })
    expect(ccxtMarketToInstrument(loadMarket('multiplier-sub-unit-eth'))).toMatchObject({
      normalized: 'ETH',
      venueSymbol: 'ETHUSDTM',
      contractSize: 0.01,
    })
  })

  it('takes the prefixed listing’s contractSize from the multiplier alone, prefix unfolded', () => {
    expect(ccxtMarketToInstrument(loadMarket('prefix-1000-bonk'))).toMatchObject({
      normalized: 'BONK',
      venueSymbol: '1000BONKUSDTM', // the venue symbol stays intact for API calls
      contractSize: 1000, // NOT 1000 × 1000 — see `./contract-size-chain.test.ts`
      fundingIntervalHours: 4,
    })
    expect(ccxtMarketToInstrument(loadMarket('prefix-10000-cat'))).toMatchObject({
      normalized: 'CAT',
      venueSymbol: '10000CATUSDTM',
      contractSize: 10, // the venue multiplier, unrelated to the 10 000 in the name
    })
  })

  it('keeps a digit-leading base intact', () => {
    expect(ccxtMarketToInstrument(loadMarket('digit-base-1inch'))).toMatchObject({
      normalized: '1INCH',
      venueSymbol: '1INCHUSDTM',
      contractSize: 1,
    })
  })

  it('carries the 4h and 1h cadences onto the Instrument', () => {
    expect(ccxtMarketToInstrument(loadMarket('funding-4h-wif')).fundingIntervalHours).toBe(4)
    expect(ccxtMarketToInstrument(loadMarket('funding-1h-lrc')).fundingIntervalHours).toBe(1)
  })

  it('falls back to 8h when the row carries no usable granularity', () => {
    expect(ccxtMarketToInstrument(withGranularity('clean-perp-btc', null)).fundingIntervalHours).toBe(8)
  })
})

describe('ccxtMarketToInstrument fail-loud (10 §4) — every message names the venue symbol', () => {
  it('throws on missing price precision', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-missing-precision'))).toThrow(
      /KuCoin instrument 'NOPRECUSDTM': missing or non-positive price precision/,
    )
  })

  it('throws on zero contractSize', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-zero-contractsize'))).toThrow(
      /KuCoin instrument 'ZEROUSDTM': missing or non-positive contractSize/,
    )
  })

  it('throws on an unparsable base symbol', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-unparsable-base'))).toThrow(
      /KuCoin instrument 'BADUSDTM': unparsable base symbol/,
    )
  })

  it('throws when ccxt’s contractSize disagrees with the venue’s own info.multiplier', () => {
    // The KuCoin-only cross-check: the face value has two sources and they must agree, because a
    // wrong one mis-sizes every order on that symbol silently rather than failing.
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-multiplier-mismatch'))).toThrow(
      /KuCoin instrument 'MISMATCHUSDTM': contractSize 100 disagrees with info.multiplier 10/,
    )
  })

  it('throws on an out-of-set funding interval (10 800 000 ms = 3h)', () => {
    expect(() => ccxtMarketToInstrument(loadMarket('anomaly-funding-interval'))).toThrow(
      /KuCoin instrument 'ODDUSDTM': funding interval 3h ∉ \{1,2,4,8\}/,
    )
  })

  it('rejects a granularity that is in seconds rather than ms (the unit slip this venue invites)', () => {
    // 28 800 (seconds) instead of 28 800 000 (ms) is 0.008 h — nowhere near the set, so it aborts
    // startup instead of scheduling funding 125× too often.
    expect(() => ccxtMarketToInstrument(withGranularity('clean-perp-btc', 28_800))).toThrow(/∉ \{1,2,4,8\}/)
  })
})

describe('buildInstrumentRegistry', () => {
  it('keys the validated registry by canonical name, with per-symbol intervals and face values', () => {
    const markets = loadMarkets(['clean-perp-btc', 'funding-4h-wif', 'funding-1h-lrc', 'multiplier-100-doge'])
    const registry = buildInstrumentRegistry(Object.values(markets))
    expect([...registry.keys()].sort()).toEqual(['BTC', 'DOGE', 'LRC', 'WIF'])
    expect(registry.get('BTC')?.fundingIntervalHours).toBe(8)
    expect(registry.get('WIF')?.fundingIntervalHours).toBe(4)
    expect(registry.get('LRC')?.fundingIntervalHours).toBe(1)
    expect(registry.get('DOGE')?.contractSize).toBe(100)
  })

  it('applies the 10 §3 filter, so spot/inverse/delisted rows never reach the mapper', () => {
    const registry = buildInstrumentRegistry([
      loadMarket('clean-perp-btc'),
      loadMarket('spot-btc'),
      loadMarket('inverse-coinm-xbt'),
      loadMarket('delisted'),
    ])
    expect([...registry.keys()]).toEqual(['BTC'])
    expect(registry.get('BTC')?.venueSymbol).toBe('XBTUSDTM')
  })

  it('skips ccxt’s undefined dictionary slots', () => {
    expect(buildInstrumentRegistry([loadMarket('clean-perp-btc'), undefined]).size).toBe(1)
  })

  it('aborts the whole load when any instrument is anomalous', () => {
    expect(() =>
      buildInstrumentRegistry([loadMarket('clean-perp-btc'), loadMarket('anomaly-multiplier-mismatch')]),
    ).toThrow(/disagrees with info.multiplier/)
  })

  it('resolves the BONK canonical-name collision to the plain listing, either order', () => {
    const plainFirst = buildInstrumentRegistry([loadMarket('plain-bonk'), loadMarket('prefix-1000-bonk')])
    const prefixFirst = buildInstrumentRegistry([loadMarket('prefix-1000-bonk'), loadMarket('plain-bonk')])
    expect(plainFirst.get('BONK')?.venueSymbol).toBe('BONKUSDTM')
    expect(prefixFirst.get('BONK')?.venueSymbol).toBe('BONKUSDTM')
    expect(plainFirst.size).toBe(1)
    expect(prefixFirst.size).toBe(1)
    // The winner brings its own face value, which on this venue is independent of the name: the
    // plain listing is 10 000 BONK per contract while the prefixed one is 1000 × 1000BONK. The
    // tie-breaker is the *name* multiplier (1 beats 1000), never the contract size.
    expect(plainFirst.get('BONK')?.contractSize).toBe(10_000)
    expect(prefixFirst.get('BONK')?.contractSize).toBe(10_000)
  })

  it('logs the dropped listing on a collision', () => {
    const log = vi.fn()
    buildInstrumentRegistry([loadMarket('plain-bonk'), loadMarket('prefix-1000-bonk')], [], log)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('kucoin: dropped colliding instrument listing', {
      normalized: 'BONK',
      venueSymbol: '1000BONKUSDTM',
      keptMultiplier: 1,
      droppedMultiplier: 1000,
    })
  })
})
