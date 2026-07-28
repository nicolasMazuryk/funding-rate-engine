/**
 * Unit: **`pickCheapestSymbol`** — the live tier picks the symbol, nothing configures it
 * (task 0470 phase 4).
 *
 * The properties that matter with real money: never pick something whose smallest legal order
 * is over the cap (the two real-venue offenders — Binance BTC's 50 USDT min-notional and
 * KuCoin's ~90 USD BTC contract — are excluded *by construction*, not by a deny-list), pick the
 * cheapest of what is left, be deterministic on ties, and **throw** rather than fall back.
 */

import { describe, expect, it } from 'vitest'
import type { Instrument } from '../../../src/core/ports/exchange-adapter.js'
import { resolveCaps } from '../../../src/live/caps.js'
import { pickCheapestSymbol, type SymbolCandidate } from '../../../src/live/symbol-pick.js'

const CAPS = resolveCaps()

function instrument(overrides: Partial<Instrument> & { normalized: string }): Instrument {
  return {
    venueSymbol: `${overrides.normalized}USDT`,
    contractSize: 1,
    pricePrecision: 0.0001,
    amountPrecision: 1,
    minNotional: 5,
    minQty: 1,
    fundingIntervalHours: 8,
    ...overrides,
  }
}

function candidate(normalized: string, price: number, overrides: Partial<Instrument> = {}): SymbolCandidate {
  return { instrument: instrument({ normalized, ...overrides }), price }
}

describe('pickCheapestSymbol (0470 phase 4)', () => {
  it('picks the cheapest candidate that fits the per-order cap', () => {
    const pick = pickCheapestSymbol(
      [
        candidate('SOL', 150, { minQty: 0.1, amountPrecision: 0.1, minNotional: 5 }), // 15 USD
        candidate('DOGE', 0.2, { minQty: 10, amountPrecision: 1, minNotional: 5 }), // 5 USD
        candidate('ETH', 3_000, { minQty: 0.001, amountPrecision: 0.001, minNotional: 5 }), // 5 USD but pricier lot
      ],
      CAPS,
    )
    expect(pick.symbol).toBe('DOGE')
    expect(pick.qty).toBe(25) // 5 USD min-notional / 0.2, ceiled to the lot step
    expect(pick.notionalUsd).toBeLessThanOrEqual(CAPS.maxOrderNotionalUsd)
  })

  it("excludes Binance's 50 USDT-min-notional BTC by construction", () => {
    const pick = pickCheapestSymbol(
      [
        candidate('BTC', 100_000, { minQty: 0.001, amountPrecision: 0.001, minNotional: 50 }),
        candidate('DOGE', 0.2, { minQty: 10, amountPrecision: 1 }),
      ],
      CAPS,
    )
    expect(pick.symbol).toBe('DOGE')
  })

  it("excludes KuCoin's ~90 USD BTC contract by construction (contractSize ≠ 1)", () => {
    // XBTUSDTM: one contract is 0.001 BTC, and `minQty` is one contract — but the conservative
    // notional reading (`max(qty·px, qty·px·contractSize)`) is what decides candidacy.
    const kucoinBtc = candidate('BTC', 90_000, {
      minQty: 1,
      amountPrecision: 1,
      contractSize: 0.001,
      minNotional: 0,
    })
    expect(() => pickCheapestSymbol([kucoinBtc], CAPS)).toThrow(/no candidate symbol fits/)
  })

  it('breaks ties on the symbol so repeated runs pick the same market', () => {
    const first = pickCheapestSymbol([candidate('XRP', 2, { minQty: 5 }), candidate('ADA', 1, { minQty: 10 })], CAPS)
    const second = pickCheapestSymbol([candidate('ADA', 1, { minQty: 10 }), candidate('XRP', 2, { minQty: 5 })], CAPS)
    expect(first.symbol).toBe('ADA')
    expect(second.symbol).toBe('ADA')
  })

  it('throws — naming every candidate and its cost — when nothing fits', () => {
    expect(() =>
      pickCheapestSymbol([candidate('BTC', 100_000, { minQty: 0.001, amountPrecision: 0.001, minNotional: 50 })], CAPS),
    ).toThrow(/BTC \(min 100\.00 USD, order 100\.00 USD\)/)
  })

  it('throws on an empty candidate list rather than returning nothing', () => {
    expect(() => pickCheapestSymbol([], CAPS)).toThrow(/no candidate symbol fits/)
  })

  it('honours a tightened cap', () => {
    const tight = resolveCaps({ maxOrderNotionalUsd: 6 })
    const candidates = [candidate('SOL', 150, { minQty: 0.1, amountPrecision: 0.1 }), candidate('DOGE', 0.2)]
    expect(pickCheapestSymbol(candidates, tight).symbol).toBe('DOGE')
    expect(() => pickCheapestSymbol([candidates[0] as SymbolCandidate], tight)).toThrow(/no candidate symbol fits/)
  })
})
