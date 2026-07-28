/**
 * Unit: `funding-test`'s symbol picker (task 0470 phase 7).
 *
 * The pure half of the decision that puts real money on a venue for the length of a settlement:
 * which symbol, at what size. Its sibling `symbol-pick.test.ts` covers the cheapest-order rule;
 * this one covers the three ways this picker deliberately differs — rate-ranked, threshold-gated,
 * and sized toward the cap instead of the venue minimum.
 */

import { describe, expect, it } from 'vitest'
import type { Instrument } from '../../../src/core/ports/exchange-adapter.js'
import { resolveCaps } from '../../../src/live/caps.js'
import {
  type FundingCandidate,
  LIVE_FUNDING_RATE_THRESHOLD_PERCENT,
  LIVE_FUNDING_TARGET_NOTIONAL_USD,
  pickFundingSymbol,
} from '../../../src/live/funding-pick.js'

const CAPS = resolveCaps()

function instrument(normalized: string, over: Partial<Instrument> = {}): Instrument {
  return {
    normalized,
    venueSymbol: `${normalized}USDT`,
    contractSize: 1,
    pricePrecision: 0.001,
    amountPrecision: 0.1,
    minNotional: 5,
    minQty: 0.1,
    fundingIntervalHours: 1,
    ...over,
  }
}

function candidate(
  normalized: string,
  price: number,
  ratePercent: number,
  over?: Partial<Instrument>,
): FundingCandidate {
  return { instrument: instrument(normalized, over), price, ratePercent }
}

describe('pickFundingSymbol (0470 phase 7)', () => {
  it('ranks on the funding rate, not on what the order costs', () => {
    const pick = pickFundingSymbol(
      [candidate('CHEAP', 1, -0.02), candidate('RICH', 100, -0.4), candidate('MID', 10, -0.1)],
      CAPS,
    )
    expect(pick.symbol).toBe('RICH')
    expect(pick.ratePercent).toBe(-0.4)
  })

  it('excludes anything not paying a long by at least the threshold', () => {
    expect(() =>
      pickFundingSymbol([candidate('FLAT', 1, 0), candidate('PAYS', 1, 0.5), candidate('TINY', 1, -0.001)], CAPS),
    ).toThrow(/no symbol qualifies.*best rate seen -0.001%/s)
  })

  it('sizes toward the target notional rather than the venue minimum', () => {
    const pick = pickFundingSymbol([candidate('DOGE', 0.2, -0.05)], CAPS)

    expect(pick.notionalUsd).toBeGreaterThan(LIVE_FUNDING_TARGET_NOTIONAL_USD * 0.95)
    expect(pick.notionalUsd).toBeLessThanOrEqual(CAPS.maxOrderNotionalUsd)
    // 20 USD at 0.2 with a 0.1 lot step is 100 units — far above the 25-unit min-notional floor.
    expect(pick.qty).toBe(100)
    expect(pick.expectedFundingUsd).toBeCloseTo((pick.notionalUsd * 0.05) / 100, 12)
  })

  it('raises a lot-floored target back up to the venue minimum', () => {
    // One indivisible contract costs 22 USD, so the 20 USD target floors to zero contracts —
    // and one contract is still inside the cap, so the order is the minimum rather than nothing.
    const pick = pickFundingSymbol([candidate('BIG', 22, -0.05, { amountPrecision: 1, minQty: 1 })], CAPS)
    expect(pick.qty).toBe(1)
    expect(pick.notionalUsd).toBe(22)
  })

  it('refuses a qualifying symbol whose smallest order is over the per-order cap', () => {
    expect(() =>
      // 60 USD a contract, indivisible — qualifying on rate but unbuyable under a 25 USD cap.
      pickFundingSymbol([candidate('HUGE', 60, -0.3, { amountPrecision: 1, minQty: 1 })], CAPS),
    ).toThrow(/qualifying but over cap: HUGE \(60.00 USD\)/)
  })

  it('breaks a rate tie on the symbol, so an unchanged market picks the same symbol twice', () => {
    const rate = LIVE_FUNDING_RATE_THRESHOLD_PERCENT
    const first = pickFundingSymbol([candidate('BBB', 1, rate), candidate('AAA', 1, rate)], CAPS)
    const second = pickFundingSymbol([candidate('AAA', 1, rate), candidate('BBB', 1, rate)], CAPS)
    expect(first.symbol).toBe('AAA')
    expect(second.symbol).toBe('AAA')
  })

  it('names what it scanned when nothing qualified at all', () => {
    expect(() => pickFundingSymbol([], CAPS)).toThrow(/scanned 0, needed a predicted rate <= -0.01%/)
  })
})
