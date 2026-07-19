import { describe, expect, it } from 'vitest'
import {
  evaluateProfitCondition,
  type FeeInputs,
  groupLFees,
  groupRTpFees,
  s3aSlOrDeadlineFees,
  s3aTpFees,
  s6Fees,
} from '../../../../src/core/runtime/cost-model.js'

/** Binance profile fees (config/exchanges.yaml) — matches every spec worked example. */
const FEES: FeeInputs = { takerFeePct: 0.05, makerFeePct: 0.02 }

describe('cost-model fee helpers (00_globals §4)', () => {
  it('computes each named exit-path fee', () => {
    expect(groupLFees(FEES)).toBeCloseTo(0.1)
    expect(s3aTpFees(FEES)).toBeCloseTo(0.07)
    expect(s3aSlOrDeadlineFees(FEES)).toBeCloseTo(0.1)
    expect(groupRTpFees(FEES)).toBeCloseTo(0.04)
    expect(s6Fees(FEES)).toBeCloseTo(0.17)
  })
})

describe('evaluateProfitCondition — Group L (s1/s1-ws/s2)', () => {
  it('passes at threshold −0.4 (breakeven drop tolerance 0.30%)', () => {
    const b = evaluateProfitCondition('s1', { fundingRatePercent: -0.4, fees: FEES, params: {} })
    expect(b.feeTerm).toBeCloseTo(0.1)
    expect(b.fundingTerm).toBeCloseTo(0.4)
    expect(b.deltaTerm).toBe(0)
    expect(b.passes).toBe(true)
  })

  it('fails at threshold −0.1 — the R10 reject case (0.1 <= 0.10)', () => {
    const b = evaluateProfitCondition('s1', { fundingRatePercent: -0.1, fees: FEES, params: {} })
    expect(b.feeTerm).toBeCloseTo(0.1)
    expect(b.fundingTerm).toBeCloseTo(0.1)
    expect(b.passes).toBe(false)
  })
})

describe('evaluateProfitCondition — Group S (s3a) TP path', () => {
  it('nets +0.13% at F=−0.4, tpMult 1.5', () => {
    const b = evaluateProfitCondition('s3a', {
      fundingRatePercent: -0.4,
      fees: FEES,
      params: { tpVariantAMultiplier: 1.5 },
    })
    expect(b.deltaTerm).toBeCloseTo(0.6)
    expect(b.fundingTerm).toBeCloseTo(-0.4)
    expect(b.feeTerm).toBeCloseTo(0.07)
    expect(b.passes).toBe(true)
    expect(b.deltaTerm + b.fundingTerm - b.feeTerm).toBeCloseTo(0.13)
  })

  it('viability bound |F|>0.14: −0.15 passes, −0.13 fails', () => {
    const params = { tpVariantAMultiplier: 1.5 }
    expect(evaluateProfitCondition('s3a', { fundingRatePercent: -0.15, fees: FEES, params }).passes).toBe(true)
    expect(evaluateProfitCondition('s3a', { fundingRatePercent: -0.13, fees: FEES, params }).passes).toBe(false)
  })
})

describe('evaluateProfitCondition — Group R (s4-1a/s4-2a) TP path', () => {
  it('passes with takeProfitPct 0.2 (bound takeProfitPct > 0.04)', () => {
    const b = evaluateProfitCondition('s4-1a', { fundingRatePercent: -0.4, fees: FEES, params: { takeProfitPct: 0.2 } })
    expect(b.feeTerm).toBeCloseTo(0.04)
    expect(b.deltaTerm).toBeCloseTo(0.2)
    expect(b.passes).toBe(true)
  })

  it('boundary takeProfitPct 0.04 fails, 0.041 passes', () => {
    expect(
      evaluateProfitCondition('s4-2a', { fundingRatePercent: -0.4, fees: FEES, params: { takeProfitPct: 0.04 } })
        .passes,
    ).toBe(false)
    expect(
      evaluateProfitCondition('s4-2a', { fundingRatePercent: -0.4, fees: FEES, params: { takeProfitPct: 0.041 } })
        .passes,
    ).toBe(true)
  })
})

describe('evaluateProfitCondition — Group D (s6, illustrative)', () => {
  // No spec-cited numbers: PRE-leg terms are exchange-sourced live values. These
  // inputs only assert the inequality shape flips on exPostDeltaPnlPercent.
  it('fails when MAIN_DELTA cannot clear |F| + fees, passes when it can', () => {
    const base = { fundingRatePercent: -0.2, fees: FEES, params: {} }
    // feeTerm = 0.17, fundingTerm = -0.2 ⇒ need deltaTerm > 0.37.
    expect(evaluateProfitCondition('s6', { ...base, exPostDeltaPnlPercent: 0.3 }).passes).toBe(false)
    expect(evaluateProfitCondition('s6', { ...base, exPostDeltaPnlPercent: 0.5 }).passes).toBe(true)
  })
})

describe('evaluateProfitCondition — Group R ex-post funding', () => {
  it('adds exchange-sourced FUNDING_PNL to the delta term', () => {
    const b = evaluateProfitCondition('s4-1a', {
      fundingRatePercent: 0,
      fees: FEES,
      params: { takeProfitPct: 0.03 },
      exPostFundingPnlPercent: 0.02,
    })
    // 0.03 + 0.02 = 0.05 > 0.04 ⇒ passes (would fail on the TP path alone).
    expect(b.passes).toBe(true)
  })
})
