import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Instrument } from '../../../../src/core/ports/exchange-adapter.js'
import {
  capReduceOnlyQty,
  checkFeasibility,
  computeQty,
  minFeasibleQty,
  roundPrice,
  splitLadder,
} from '../../../../src/core/sizing/sizing.js'

/** Default liquid instrument; override per case. `amountPrecision` is the lot step, `pricePrecision` the tick. */
function instrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    normalized: 'BTC',
    venueSymbol: 'BTCUSDT',
    contractSize: 1,
    pricePrecision: 0.1,
    amountPrecision: 0.001,
    minNotional: 5,
    minQty: 0.001,
    fundingIntervalHours: 8,
    ...overrides,
  }
}

/** True when `value` is (within float noise) a multiple of `step`. */
function isStepMultiple(value: number, step: number): boolean {
  const ratio = value / step
  return Math.abs(ratio - Math.round(ratio)) <= 1e-6 * Math.max(1, Math.abs(ratio))
}

describe('computeQty (00_globals §4)', () => {
  it('sizes qty = amountUsd / price / contractSize, floored to the lot step', () => {
    // 20 / 100 / 1 = 0.2, already a 0.001 multiple.
    expect(computeQty(20, 100, instrument())).toBeCloseTo(0.2, 12)
  })

  it('floors a value that is a step multiple past float drift, not one quantum down', () => {
    // 0.03 / 1 / 1 is stored as 0.0299999…; must floor to 0.030, never 0.029.
    const qty = computeQty(0.03, 1, instrument({ amountPrecision: 0.001 }))
    expect(qty).toBeCloseTo(0.03, 12)
    expect(qty).toBeGreaterThan(0.0295)
  })

  it('honours contractSize (1000PEPE): base-unit qty is contract-scaled', () => {
    // 20 / 0.000002 / 1000 = 10_000 base PEPE.
    const qty = computeQty(20, 0.000002, instrument({ contractSize: 1000, amountPrecision: 1 }))
    expect(qty).toBe(10_000)
  })
})

describe('roundPrice (11 §3 — never rejects)', () => {
  it('rounds down to the nearest tick', () => {
    expect(roundPrice(100.04, instrument())).toBeCloseTo(100.0, 12)
  })

  it('rounds up to the nearest tick', () => {
    expect(roundPrice(100.06, instrument())).toBeCloseTo(100.1, 12)
  })

  it('returns a price the venue can parse, not the raw float product', () => {
    // `1596 * 0.0001` is `0.15960000000000002`; Binance rejected exactly this decimal string
    // with "Precision is over the maximum defined for this asset." (0470 §5). The assertion is
    // on the *serialized* form, because that is what reaches the venue.
    const price = roundPrice(0.1596, instrument({ pricePrecision: 0.0001 }))
    expect(String(price)).toBe('0.1596')
  })
})

describe('checkFeasibility (11 §3 table)', () => {
  it('reports zero_qty when the lot floor collapsed qty to 0', () => {
    expect(checkFeasibility(0, 100, instrument())).toEqual({ ok: false, reason: 'zero_qty' })
  })

  it('reports min_notional when qty × price is below the exchange minimum', () => {
    // 0.001 × 100 = 0.1 < minNotional 5.
    expect(checkFeasibility(0.001, 100, instrument())).toEqual({ ok: false, reason: 'min_notional' })
  })

  it('reports min_qty when notional clears but qty is below minQty', () => {
    // 0.001 × 100_000 = 100 ≥ 5, but qty 0.001 < minQty 0.01.
    expect(checkFeasibility(0.001, 100_000, instrument({ minQty: 0.01 }))).toEqual({ ok: false, reason: 'min_qty' })
  })

  it('passes a qty that clears both minimums', () => {
    expect(checkFeasibility(0.1, 100, instrument())).toEqual({ ok: true })
  })
})

describe('capReduceOnlyQty (11 §3 reduce-only sanity)', () => {
  it('caps the exit qty to the tracked position qty', () => {
    expect(capReduceOnlyQty(0.5, 0.3)).toBe(0.3)
  })

  it('leaves the request untouched when it is already within the position', () => {
    expect(capReduceOnlyQty(0.2, 0.3)).toBe(0.2)
  })
})

describe('splitLadder (00_globals §G-R; 05 §2)', () => {
  it('drops a single sub-min-notional rung and places the rest (5 → 4)', () => {
    // perRung notional = 15/5 = 3. rungs 0–3 (price 1) floor exactly to qty 6 (notional 3.0 ≥ 2.5);
    // rung 4 (price 4.5) floors to qty 0.5 → notional 2.25 < 2.5 and, with no spare quanta to
    // redistribute (rungs 0–3 have zero remainder), is dropped.
    const inst = instrument({ amountPrecision: 0.5, minNotional: 2.5, minQty: 0.1 })
    const rungs = splitLadder(15, [1, 1, 1, 1, 4.5], inst)
    expect(rungs).toHaveLength(4)
    expect(rungs.map((r) => r.price)).toEqual([1, 1, 1, 1])
    for (const r of rungs) {
      expect(r.qty * r.price).toBeGreaterThanOrEqual(inst.minNotional)
    }
  })

  it('skips the whole ladder when the top rung is itself infeasible ([])', () => {
    // Single rung: qty 0.001 × price 1000 = 1.0 notional < minNotional 5 → top infeasible → [].
    expect(splitLadder(1, [1000], instrument())).toEqual([])
  })

  it('returns [] for an empty rung list', () => {
    expect(splitLadder(20, [], instrument())).toEqual([])
  })

  it('conserves the amountUsd-derived total qty within one lot step per rung', () => {
    // No minimums → nothing dropped, so the full distribution is observable.
    const inst = instrument({ minNotional: 0, minQty: 0, amountPrecision: 0.001 })
    const prices = [100, 101, 102, 103, 104]
    const rungs = splitLadder(50, prices, inst)
    const idealTotal = prices.reduce((sum, p) => sum + 50 / prices.length / p / inst.contractSize, 0)
    const distributed = rungs.reduce((sum, r) => sum + r.qty, 0)
    expect(Math.abs(distributed - idealTotal)).toBeLessThanOrEqual(inst.amountPrecision * prices.length)
  })

  it('is deterministic — identical inputs yield byte-identical rung arrays', () => {
    const inst = instrument({ amountPrecision: 0.5, minNotional: 2.5, minQty: 0.1 })
    const a = splitLadder(15, [1, 1, 1, 1, 4.5], inst)
    const b = splitLadder(15, [1, 1, 1, 1, 4.5], inst)
    expect(a).toEqual(b)
  })
})

describe('property: lot-step flooring (17 §2)', () => {
  it('computeQty result is a step multiple and never exceeds the raw qty', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.01, max: 1e4, noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom(1, 10, 1000),
        fc.constantFrom(0.001, 0.01, 0.1, 1),
        (amountUsd, price, contractSize, step) => {
          const inst = instrument({ contractSize, amountPrecision: step })
          const qty = computeQty(amountUsd, price, inst)
          const raw = amountUsd / price / contractSize
          expect(isStepMultiple(qty, step)).toBe(true)
          // Never rounds up beyond float-noise (bounded by the lot step itself).
          expect(qty).toBeLessThanOrEqual(raw + step)
        },
      ),
    )
  })
})

describe('property: ladder split (17 §2)', () => {
  const rungPricesArb = fc.array(fc.double({ min: 0.5, max: 1e4, noNaN: true, noDefaultInfinity: true }), {
    minLength: 1,
    maxLength: 20,
  })

  it('conserves total qty within one lot step per rung when nothing is dropped', () => {
    // Ranges chosen so every rung sizes to many lot-step quanta (never floors to
    // zero → nothing is dropped, so the whole distribution is observable).
    fc.assert(
      fc.property(
        fc.double({ min: 1e4, max: 1e5, noNaN: true, noDefaultInfinity: true }),
        fc.array(fc.double({ min: 1, max: 100, noNaN: true, noDefaultInfinity: true }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.constantFrom(0.001, 0.01, 0.1),
        (amountUsd, prices, step) => {
          const inst = instrument({ minNotional: 0, minQty: 0, amountPrecision: step })
          const rungs = splitLadder(amountUsd, prices, inst)
          const idealTotal = prices.reduce((sum, p) => sum + amountUsd / prices.length / p, 0)
          const distributed = rungs.reduce((sum, r) => sum + r.qty, 0)
          expect(Math.abs(distributed - idealTotal)).toBeLessThanOrEqual(step * (prices.length + 1))
        },
      ),
    )
  })

  it('every emitted rung clears minNotional and minQty', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 10, max: 1e5, noNaN: true, noDefaultInfinity: true }),
        rungPricesArb,
        (amountUsd, prices) => {
          const inst = instrument({ minNotional: 5, minQty: 0.001, amountPrecision: 0.001 })
          for (const rung of splitLadder(amountUsd, prices, inst)) {
            expect(rung.qty).toBeGreaterThanOrEqual(inst.minQty)
            expect(rung.qty * rung.price).toBeGreaterThanOrEqual(inst.minNotional)
          }
        },
      ),
    )
  })
})

describe('minFeasibleQty (07 §2 — S6 PRE_FUNDING size)', () => {
  it('ceils max(minQty, minNotional/(price·contractSize)) up to the lot step', () => {
    // 5 / (60000·1) = 0.0000833… → ceil to the 0.001 lot step = 0.001 (which is also minQty here).
    expect(minFeasibleQty(60_000, instrument())).toBeCloseTo(0.001, 12)
  })

  it('is min-notional-bound when min-notional dominates the lot minimum', () => {
    // minNotional 20, price 100 → 0.2; minQty 0.001 → notional wins, ceil-to-step 0.2.
    expect(minFeasibleQty(100, instrument({ minNotional: 20, minQty: 0.001 }))).toBeCloseTo(0.2, 12)
  })

  it('is min-qty-bound when the lot minimum dominates the notional floor', () => {
    // minNotional 5, price 100000 → 0.00005; minQty 0.01 wins.
    expect(minFeasibleQty(100_000, instrument({ minNotional: 5, minQty: 0.01, amountPrecision: 0.01 }))).toBeCloseTo(
      0.01,
      12,
    )
  })

  it('ceils a sub-step notional floor up to the next whole lot (never floors below feasibility)', () => {
    // 5 / (1234·1) = 0.004052… → must ceil to 0.005 (the next 0.001 step), not floor to 0.004.
    expect(minFeasibleQty(1234, instrument({ minNotional: 5, minQty: 0.001 }))).toBeCloseTo(0.005, 12)
  })

  it('boundary: sizing guard preQty == mainQty is a skip (minFeasibleQty equals the main lot)', () => {
    // With amount 5 at price 100000 (contractSize 1): computeQty = floor(5/100000)=0 lot... use a case where
    // main qty (amountUsd/price) equals the min feasible qty exactly → the engine skips (preQty >= mainQty).
    const inst = instrument({ minNotional: 5, minQty: 0.001, amountPrecision: 0.001 })
    const price = 1000
    const mainQty = computeQty(5, price, inst) // 5/1000 = 0.005
    const preQty = minFeasibleQty(price, inst) // ceil(max(0.001, 5/1000)) = 0.005
    expect(preQty).toBeCloseTo(mainQty, 12)
    expect(preQty >= mainQty).toBe(true) // engine's reversal sizing guard → skip
  })
})
