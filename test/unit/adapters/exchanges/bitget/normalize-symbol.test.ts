/**
 * Unit: Bitget venue-symbol → canonical-name normalization (`10` §4 denomination), pure and
 * fully offline.
 *
 * Bitget is the only venue so far where the multiplier prefix is the **whole** face-value
 * story: `contractSize` is `1` on every linear listing (`./instrument.ts`), so unlike OKX's
 * `ctVal` there is no second place a face value can come from. Whatever this function returns
 * as `multiplier` is what `Instrument.contractSize` becomes — get it wrong and every order on
 * that symbol is mis-sized by a factor of 1000 or more, silently.
 *
 * Two properties are pinned here, both drawn from the live listing:
 *  - the three prefixes Bitget actually uses (`1000`, `10000`, `1000000`) are stripped, longest
 *    first, so `1000000MOG` folds 1e6 rather than 1e3 onto a bogus `000MOG`;
 *  - a prefix only counts when a **letter** follows it, so the genuine digit-leading names on
 *    the venue (`1INCH`, `2Z`, `0G`) survive intact rather than normalizing to a different —
 *    and possibly *existing* — instrument.
 */

import { describe, expect, it } from 'vitest'
import { normalizeSymbol } from '../../../../../src/adapters/exchanges/bitget/normalize-symbol.js'
import { loadMarket } from './fixtures.js'

describe('normalizeSymbol', () => {
  it('leaves a plain base untouched (multiplier 1) — the bulk of the listing', () => {
    expect(normalizeSymbol('BTC')).toEqual({ normalized: 'BTC', multiplier: 1 })
    expect(normalizeSymbol('XTZ')).toEqual({ normalized: 'XTZ', multiplier: 1 })
  })

  it('strips a 1000 multiplier and reports it (live: 1000BONKUSDT)', () => {
    expect(normalizeSymbol('1000BONK')).toEqual({ normalized: 'BONK', multiplier: 1000 })
  })

  it('strips a 10000 multiplier and reports it', () => {
    expect(normalizeSymbol('10000SATS')).toEqual({ normalized: 'SATS', multiplier: 10_000 })
  })

  it('strips a 1000000 multiplier, longest prefix first (live: 1000000MOGUSDT)', () => {
    // Shortest-first matching would yield `000MOG` at 1000× — a name that is not an instrument
    // and a face value 1000× too small.
    expect(normalizeSymbol('1000000MOG')).toEqual({ normalized: 'MOG', multiplier: 1_000_000 })
  })

  it('does not strip digits that are part of the name (live false-positive traps)', () => {
    expect(normalizeSymbol('1INCH')).toEqual({ normalized: '1INCH', multiplier: 1 })
    expect(normalizeSymbol('2Z')).toEqual({ normalized: '2Z', multiplier: 1 })
    expect(normalizeSymbol('0G')).toEqual({ normalized: '0G', multiplier: 1 })
  })

  it('requires a letter after the prefix, so a digits-only base is left alone', () => {
    // Nothing follows the prefix, so there is no canonical name to fold onto — stripping here
    // would leave the empty string and the instrument mapper would then reject the row.
    expect(normalizeSymbol('1000')).toEqual({ normalized: '1000', multiplier: 1 })
    expect(normalizeSymbol('10001')).toEqual({ normalized: '10001', multiplier: 1 })
  })

  it('reads the captured venue bases, not hand-typed ones', () => {
    // Guards against a fixture recapture silently changing the shape this function is fed.
    expect(normalizeSymbol(loadMarket('multiplier-1000-bonk').base)).toEqual({
      normalized: 'BONK',
      multiplier: 1000,
    })
    expect(normalizeSymbol(loadMarket('multiplier-1000000-mog').base)).toEqual({
      normalized: 'MOG',
      multiplier: 1_000_000,
    })
    expect(normalizeSymbol(loadMarket('digit-base-1inch').base)).toEqual({
      normalized: '1INCH',
      multiplier: 1,
    })
  })

  it('folds the prefixed listing onto the same canonical name as the plain one', () => {
    // This is what makes the registry collision in `./instrument.test.ts` reachable: Bitget
    // lists both BONKUSDT and 1000BONKUSDT.
    expect(normalizeSymbol(loadMarket('plain-bonk').base).normalized).toBe(
      normalizeSymbol(loadMarket('multiplier-1000-bonk').base).normalized,
    )
  })
})
