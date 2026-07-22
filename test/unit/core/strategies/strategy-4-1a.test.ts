/**
 * Strategy 4.1a unit tests (task 0330; `05_strategy_4_1a.md` §2/§3). S4.1a selects identically to
 * S1/S2/S3a (shared §G-L/§G-R rule) but adds the ladder entry geometry: the rung-price ladder, the
 * engine-side SL anchor from `P_avg_full`, and the per-fill TP. These assert the id/kind/selection
 * reuse, the `05` §2 rung formula (including the linear interpolation + `|F|` = realized rate), the
 * SL/TP price math, and the split-math consequences (sub-min-notional drop, top-rung infeasible → `[]`).
 */

import { describe, expect, it } from 'vitest'
import type { Instrument } from '../../../../src/core/ports/exchange-adapter.js'
import type { Candidate } from '../../../../src/core/runtime/finder.js'
import { roundPrice, splitLadder } from '../../../../src/core/sizing/sizing.js'
import { selectGroupL } from '../../../../src/core/strategies/group-l-selection.js'
import type { RuntimeStrategyConfig } from '../../../../src/core/strategies/registry.js'
import {
  createStrategy4_1a,
  strategy4_1aLadderPlan,
  strategy4_1aTpGeometry,
} from '../../../../src/core/strategies/strategy-4-1a.js'

const RUNTIME: RuntimeStrategyConfig = {
  id: 's4-1a',
  thresholdPercent: -0.4,
  direction: 'negative',
  entryOffsetSeconds: 3,
  ladderCount: 5,
  ladderTopMult: 0.7,
  ladderBottomMult: 1.8,
  takeProfitPct: 0.3,
  slMultiplier: 2.5,
  deadlineSeconds: 1800,
  amountUsd: 300,
  leverage: 1,
}

const BTC: Instrument = {
  normalized: 'BTC',
  venueSymbol: 'BTCUSDT',
  contractSize: 1,
  pricePrecision: 0.1,
  amountPrecision: 0.001,
  minNotional: 5,
  minQty: 0.001,
  fundingIntervalHours: 8,
}

function candidate(ratePercent: number): Candidate {
  return { symbol: 'BTC', ratePercent, settleTs: 8 * 3_600_000, observedTs: 0 }
}

describe('createStrategy4_1a', () => {
  const module = createStrategy4_1a()

  it('registers as a ladder sl_tp_deadline module under id s4-1a', () => {
    expect(module.id).toBe('s4-1a')
    expect(module.exitPolicyKind).toBe('sl_tp_deadline')
    expect(module.entryPlan).toBe(strategy4_1aLadderPlan)
  })

  it('selects with the shared §G-L rule (≤ threshold, inclusive)', () => {
    expect(module.select(candidate(-0.4), RUNTIME)).toEqual({ symbol: 'BTC', settleTs: 8 * 3_600_000 })
    expect(module.select(candidate(-0.39), RUNTIME)).toBeUndefined()
    // §G-R reuses §G-L verbatim (`05` §1) — same result as the shared helper, not a copy.
    expect(module.select(candidate(-0.5), RUNTIME)).toEqual(selectGroupL(candidate(-0.5), RUNTIME))
  })
})

describe('strategy4_1aLadderPlan.rungPrices (`05` §2)', () => {
  it('builds the linear rung ladder from ladder_top to ladder_bottom, |F| = the realized rate', () => {
    // |F| = 0.35 (realized), not the -0.4 threshold: ladder_top/bottom scale off the entered rate.
    const prices = strategy4_1aLadderPlan.rungPrices(60_000, RUNTIME, -0.35)
    // top = 60000×(1−0.35×0.7/100) = 59853; bottom = 60000×(1−0.35×1.8/100) = 59622; 4 equal steps.
    expect(prices).toEqual([59853, 59795.25, 59737.5, 59679.75, 59622])
  })

  it('falls back to the selection threshold when no realized rate is threaded', () => {
    const prices = strategy4_1aLadderPlan.rungPrices(60_000, RUNTIME)
    // |F| = 0.4: top = 60000×(1−0.4×0.7/100) = 59832; bottom = 60000×(1−0.4×1.8/100) = 59568.
    expect(prices[0]).toBeCloseTo(59832, 6)
    expect(prices[prices.length - 1]).toBeCloseTo(59568, 6)
  })
})

describe('strategy4_1aLadderPlan.slTriggerPrice (`05` §2 step 1)', () => {
  it('anchors the engine-side SL below the precomputed P_avg_full', () => {
    const pAvgFull = 59_737.52
    // P_avg_full × (1 − 0.35 × 2.5/100).
    expect(strategy4_1aLadderPlan.slTriggerPrice(pAvgFull, RUNTIME, -0.35)).toBeCloseTo(59_214.8167, 3)
  })
})

describe('strategy4_1aTpGeometry.tpPrice (`05` §3)', () => {
  it('places the TP a takeProfitPct above the running P_avg', () => {
    expect(strategy4_1aTpGeometry.tpPrice(59_737.52, RUNTIME)).toBeCloseTo(59_916.7326, 3)
  })
})

describe('ladder split-math consequences (`05` §2 / §G-R)', () => {
  const prices = strategy4_1aLadderPlan.rungPrices(60_000, RUNTIME, -0.35).map((p) => roundPrice(p, BTC))

  it('drops a sub-min-notional (bottom) rung, leaving ladderCount − 1 rungs', () => {
    // A min-notional between the bottom two rung notionals (0.001×59622 = 59.622 vs 0.001×59679.8 =
    // 59.6798): each rung gets exactly one lot, but the bottom rung falls below min-notional and is
    // dropped — the ladder goes out with 4 rungs, the top rung intact (`05` §2 / §G-R).
    const tight: Instrument = { ...BTC, minNotional: 59.65 }
    const rungs = splitLadder(300, prices, tight)
    expect(rungs).toHaveLength(4)
    expect(rungs[0]?.price).toBe(59853) // top rung survives
  })

  it('returns [] (skip the whole ladder) when the top rung is infeasible', () => {
    // amountUsd 20 across 5 rungs = 4 USD each → the top (smallest-remainder) rung floors to zero qty,
    // and an infeasible top rung skips the entire ladder.
    expect(splitLadder(20, prices, BTC)).toEqual([])
  })
})
