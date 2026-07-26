/**
 * Unit: KuCoin venue-symbol → canonical-name normalization (`10` §4 denomination), pure and
 * fully offline.
 *
 * Two things are pinned here, and the second one is the unusual one:
 *
 *  - **the letter-follows guard.** The same three prefixes as Bybit/Bitget appear on the live
 *    listing (`1000BONK`, `10000CAT`, `1000000MOG`), stripped longest-first; and a prefix only
 *    counts when a **letter** follows it, so the genuine digit-leading names (`1INCH`, `2Z`,
 *    `0G`) survive intact rather than normalizing onto a different — possibly *existing* —
 *    instrument. Note that on KuCoin, unlike Bitget, the returned `multiplier` is used **only**
 *    for the registry's collision policy: it is deliberately never folded into `contractSize`
 *    (`./contract-size-chain.test.ts`).
 *
 *  - **`XBT` → `BTC` is ccxt's mapping, not ours.** KuCoin spells Bitcoin `XBT` on the wire
 *    (`XBTUSDTM`, `info.baseCurrency: 'XBT'`, `market.baseId: 'XBT'`), but ccxt already resolves
 *    `market.base` to `BTC`, so `normalize-symbol.ts` carries no alias table. That is a
 *    *dependency* of ours, not a fact of the venue — so the assertions below pin **where** the
 *    mapping happens, against the captured row. A ccxt upgrade that drops the alias makes this
 *    file red instead of shipping an unrecognizable `XBT` instrument into production.
 */

import { describe, expect, it } from 'vitest'
import { normalizeSymbol } from '../../../../../src/adapters/exchanges/kucoin/normalize-symbol.js'
import { loadMarket } from './fixtures.js'

describe('normalizeSymbol', () => {
  it('leaves a plain base untouched (multiplier 1) — the bulk of the listing', () => {
    expect(normalizeSymbol('BTC')).toEqual({ normalized: 'BTC', multiplier: 1 })
    expect(normalizeSymbol('DOGE')).toEqual({ normalized: 'DOGE', multiplier: 1 })
  })

  it('strips a 1000 multiplier and reports it (live: 1000BONKUSDTM)', () => {
    expect(normalizeSymbol('1000BONK')).toEqual({ normalized: 'BONK', multiplier: 1000 })
  })

  it('strips a 10000 multiplier and reports it (live: 10000CATUSDTM)', () => {
    expect(normalizeSymbol('10000CAT')).toEqual({ normalized: 'CAT', multiplier: 10_000 })
  })

  it('strips a 1000000 multiplier, longest prefix first', () => {
    // Shortest-first matching would yield `000MOG` at 1000× — a name that is not an instrument.
    expect(normalizeSymbol('1000000MOG')).toEqual({ normalized: 'MOG', multiplier: 1_000_000 })
  })

  it('does not strip digits that are part of the name (live false-positive traps)', () => {
    expect(normalizeSymbol('1INCH')).toEqual({ normalized: '1INCH', multiplier: 1 })
    expect(normalizeSymbol('2Z')).toEqual({ normalized: '2Z', multiplier: 1 })
    expect(normalizeSymbol('0G')).toEqual({ normalized: '0G', multiplier: 1 })
  })

  it('leaves a non-numeric-prefix name alone (live: 1MBABYDOGE — `1M` is not in the set)', () => {
    expect(normalizeSymbol('1MBABYDOGE')).toEqual({ normalized: '1MBABYDOGE', multiplier: 1 })
  })

  it('requires a letter after the prefix, so a digits-only base is left alone', () => {
    // Nothing follows the prefix, so there is no canonical name to fold onto — stripping here
    // would leave the empty string and the instrument mapper would then reject the row.
    expect(normalizeSymbol('1000')).toEqual({ normalized: '1000', multiplier: 1 })
    expect(normalizeSymbol('10001')).toEqual({ normalized: '10001', multiplier: 1 })
    expect(normalizeSymbol('4')).toEqual({ normalized: '4', multiplier: 1 })
  })

  it('reads the captured venue bases, not hand-typed ones', () => {
    // Guards against a fixture recapture silently changing the shape this function is fed.
    expect(normalizeSymbol(loadMarket('prefix-1000-bonk').base)).toEqual({ normalized: 'BONK', multiplier: 1000 })
    expect(normalizeSymbol(loadMarket('prefix-10000-cat').base)).toEqual({ normalized: 'CAT', multiplier: 10_000 })
    expect(normalizeSymbol(loadMarket('digit-base-1inch').base)).toEqual({ normalized: '1INCH', multiplier: 1 })
  })

  it('folds the prefixed listing onto the same canonical name as the plain one', () => {
    // This is what makes the registry collision in `./instrument.test.ts` reachable.
    expect(normalizeSymbol(loadMarket('plain-bonk').base).normalized).toBe(
      normalizeSymbol(loadMarket('prefix-1000-bonk').base).normalized,
    )
  })
})

describe('XBT → BTC happens in ccxt, before this function ever sees the base', () => {
  const btc = loadMarket('clean-perp-btc')

  it('the venue really does spell it XBT — on the id, the baseId and the raw row', () => {
    expect(btc.id).toBe('XBTUSDTM')
    expect(btc.baseId).toBe('XBT')
    expect((btc.info as { baseCurrency: string }).baseCurrency).toBe('XBT')
  })

  it('ccxt has already resolved `market.base` (and `symbol`) to BTC', () => {
    // The load-bearing assertion: this is the field `ccxtMarketToInstrument` reads. If a ccxt
    // upgrade drops the XBT alias, `base` becomes 'XBT' and this line fails here rather than
    // producing an instrument no strategy can name.
    expect(btc.base).toBe('BTC')
    expect(btc.symbol).toBe('BTC/USDT:USDT')
  })

  it('normalizeSymbol does nothing to it — there is no alias table on our side', () => {
    expect(normalizeSymbol(btc.base)).toEqual({ normalized: 'BTC', multiplier: 1 })
    // Fed the venue's own spelling it would pass `XBT` straight through, which is the proof that
    // the mapping is not ours to perform.
    expect(normalizeSymbol(btc.baseId as string)).toEqual({ normalized: 'XBT', multiplier: 1 })
  })
})
