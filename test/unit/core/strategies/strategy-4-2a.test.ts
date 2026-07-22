/**
 * Strategy 4.2a unit tests (task 0340; `06_strategy_4_2a.md` §2/§3). S4.2a is the S4.1a ladder
 * collapsed to one BUY-LIMIT: it selects identically (shared §G-L/§G-R rule) but its `entryPlan`
 * returns a single price and it declares `entryExpiryErrorCode: 'limit_expired'`. These assert the
 * id/kind/selection reuse, the single-limit + SL/TP geometry (`06` §2), the `limit_expired` seam,
 * and a **property test** over the valid config space asserting `P_SL < P_limit` (verification #4).
 */

import { describe, expect, it } from 'vitest'
import type { Candidate } from '../../../../src/core/runtime/finder.js'
import { selectGroupL } from '../../../../src/core/strategies/group-l-selection.js'
import type { RuntimeStrategyConfig } from '../../../../src/core/strategies/registry.js'
import { strategy4_1aTpGeometry } from '../../../../src/core/strategies/strategy-4-1a.js'
import { createStrategy4_2a, strategy4_2aLimitPlan } from '../../../../src/core/strategies/strategy-4-2a.js'

const RUNTIME: RuntimeStrategyConfig = {
  id: 's4-2a',
  thresholdPercent: -0.4,
  direction: 'negative',
  entryOffsetSeconds: 5,
  limitOffsetMult: 0.75,
  takeProfitPct: 0.2,
  slMultiplier: 1.5,
  deadlineSeconds: 60,
  amountUsd: 300,
  leverage: 1,
}

function candidate(ratePercent: number): Candidate {
  return { symbol: 'BTC', ratePercent, settleTs: 8 * 3_600_000, observedTs: 0 }
}

describe('createStrategy4_2a', () => {
  const module = createStrategy4_2a()

  it('registers as a single-limit sl_tp_deadline module under id s4-2a with the limit_expired seam', () => {
    expect(module.id).toBe('s4-2a')
    expect(module.exitPolicyKind).toBe('sl_tp_deadline')
    expect(module.entryPlan).toBe(strategy4_2aLimitPlan)
    expect(module.entryExpiryErrorCode).toBe('limit_expired')
  })

  it('selects with the shared §G-L rule (≤ threshold, inclusive)', () => {
    expect(module.select(candidate(-0.4), RUNTIME)).toEqual({ symbol: 'BTC', settleTs: 8 * 3_600_000 })
    expect(module.select(candidate(-0.39), RUNTIME)).toBeUndefined()
    // §G-R reuses §G-L verbatim (`06` §1) — same result as the shared helper, not a copy.
    expect(module.select(candidate(-0.5), RUNTIME)).toEqual(selectGroupL(candidate(-0.5), RUNTIME))
  })
})

describe('strategy4_2aLimitPlan.rungPrices (`06` §2)', () => {
  it('returns the single BUY-LIMIT at P_ref × (1 − |F| × limitOffsetMult/100), |F| = the realized rate', () => {
    // |F| = 0.35 (realized): P_limit = 60000×(1−0.35×0.75/100) = 59842.5. One element, no interpolation.
    expect(strategy4_2aLimitPlan.rungPrices(60_000, RUNTIME, -0.35)).toEqual([59842.5])
  })

  it('falls back to the selection threshold when no realized rate is threaded', () => {
    // |F| = 0.4: P_limit = 60000×(1−0.4×0.75/100) = 59820.
    expect(strategy4_2aLimitPlan.rungPrices(60_000, RUNTIME)).toEqual([59820])
  })

  it('throws loud when limitOffsetMult is missing (misconfigured S4.2a is a startup bug)', () => {
    const { limitOffsetMult, ...noOffset } = RUNTIME
    void limitOffsetMult
    expect(() => strategy4_2aLimitPlan.rungPrices(60_000, noOffset, -0.35)).toThrow(/limitOffsetMult/)
  })
})

describe('strategy4_2aLimitPlan.slTriggerPrice (`06` §2 / §3)', () => {
  it('anchors the engine-side SL at P_limit × (1 − |F| × slMultiplier/100) below the single limit', () => {
    // P_limit 59842.5 × (1 − 0.35 × 1.5/100) = 59842.5 × 0.99475.
    expect(strategy4_2aLimitPlan.slTriggerPrice(59842.5, RUNTIME, -0.35)).toBeCloseTo(59528.326875, 5)
  })

  it('throws when the geometry would put P_SL ≥ P_limit (loader constraint violated)', () => {
    // slMultiplier 0 ⇒ P_SL = P_limit — the defensive invariant catches a config that slipped the loader.
    expect(() => strategy4_2aLimitPlan.slTriggerPrice(59842.5, { ...RUNTIME, slMultiplier: 0 }, -0.35)).toThrow(
      /P_SL.*must be < P_limit/,
    )
  })
})

describe('S4.2a TP geometry (reused from S4.1a, `06` §3)', () => {
  it('places the TP a takeProfitPct above the fill', () => {
    // The module reuses strategy4_1aTpGeometry at wiring time: P_fill × (1 + 0.2/100).
    expect(strategy4_1aTpGeometry.tpPrice(59842.5, RUNTIME)).toBeCloseTo(59962.185, 3)
  })
})

describe('property: P_SL < P_limit for all valid configs (`06` §2, verification #4)', () => {
  // The loader enforces slMultiplier ∈ [1.0, 4.0] ∧ slMultiplier > limitOffsetMult; limitOffsetMult
  // is a positive multiplier. Sweep that space and assert the geometric consequence holds everywhere.
  it('holds across the bounded config space', () => {
    const refPrices = [1_000, 60_000, 123.45]
    const rates = [-0.1, -0.35, -0.4, -1.2, -3.0]
    const limitOffsets = [0.5, 0.75, 1.0, 1.25]
    for (const refPrice of refPrices) {
      for (const ratePercent of rates) {
        for (const limitOffsetMult of limitOffsets) {
          for (const slMultiplier of [1.0, 1.5, 2.5, 4.0]) {
            if (slMultiplier <= limitOffsetMult) continue // loader rejects these
            const config: RuntimeStrategyConfig = { ...RUNTIME, limitOffsetMult, slMultiplier }
            const pLimit = strategy4_2aLimitPlan.rungPrices(refPrice, config, ratePercent)[0] as number
            const pSl = strategy4_2aLimitPlan.slTriggerPrice(pLimit, config, ratePercent)
            expect(pSl).toBeLessThan(pLimit)
          }
        }
      }
    }
  })
})
