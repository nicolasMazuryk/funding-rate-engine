import { describe, expect, it } from 'vitest'
import {
  LIVE_MAX_ORDER_NOTIONAL_USD,
  LIVE_MAX_TOTAL_NOTIONAL_USD,
  LIVE_SUITE_FEE_BOUND_USD,
  LIVE_SUITES,
  resolveCaps,
} from '../../../src/live/caps.js'

/** The compiled-in live ceilings (task 0470) — an override may only tighten them. */
describe('resolveCaps', () => {
  it('defaults to the compiled-in ceilings', () => {
    expect(resolveCaps()).toEqual({ maxOrderNotionalUsd: 25, maxTotalNotionalUsd: 50 })
    expect(LIVE_MAX_ORDER_NOTIONAL_USD).toBe(25)
    expect(LIVE_MAX_TOTAL_NOTIONAL_USD).toBe(50)
  })

  it('clamps down', () => {
    expect(resolveCaps({ maxOrderNotionalUsd: 5, maxTotalNotionalUsd: 10 })).toEqual({
      maxOrderNotionalUsd: 5,
      maxTotalNotionalUsd: 10,
    })
  })

  it('refuses to be widened', () => {
    expect(resolveCaps({ maxOrderNotionalUsd: 1_000, maxTotalNotionalUsd: 1_000 })).toEqual({
      maxOrderNotionalUsd: 25,
      maxTotalNotionalUsd: 50,
    })
  })

  it('throws on a ceiling that would disarm the cap', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveCaps({ maxOrderNotionalUsd: bad })).toThrow(/finite number > 0/)
      expect(() => resolveCaps({ maxTotalNotionalUsd: bad })).toThrow(/finite number > 0/)
    }
  })
})

describe('LIVE_SUITE_FEE_BOUND_USD', () => {
  it('bounds every suite with a small positive budget', () => {
    for (const suite of LIVE_SUITES) {
      const bound = LIVE_SUITE_FEE_BOUND_USD[suite]
      expect(bound).toBeGreaterThan(0)
      expect(bound).toBeLessThan(1)
    }
  })
})
