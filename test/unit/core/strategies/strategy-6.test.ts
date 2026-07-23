/**
 * Unit: **Strategy 6** selection + OCO geometry (`07_strategy_6.md` §1/§2 step 4).
 *
 *  - `selectSignedAny` — the signed-any threshold rule (positive ⇒ `F ≥ t`, negative ⇒ `F ≤ t`,
 *    zero ⇒ always-on), independent of `mainSide`.
 *  - `strategy6Geometry` — TP/SL computed at MAIN fill from the **settled** `|F|`
 *    (`settledRatePercent`), on the correct side of the managed net position for LONG and SHORT.
 *    The test uses a settled rate ≠ the predicted rate so the settled-vs-predicted distinction is
 *    numerically observable (verification step 6).
 */

import { describe, expect, it } from 'vitest'
import type { MonitoredIntent } from '../../../../src/core/intent/exit-policy.js'
import type { Candidate } from '../../../../src/core/runtime/finder.js'
import type { RuntimeStrategyConfig } from '../../../../src/core/strategies/registry.js'
import { selectSignedAny, strategy6Geometry } from '../../../../src/core/strategies/strategy-6.js'

function candidate(ratePercent: number): Candidate {
  return { symbol: 'BTC', ratePercent, settleTs: 8 * 3_600_000, observedTs: 0 }
}

function config(overrides: Partial<RuntimeStrategyConfig> = {}): RuntimeStrategyConfig {
  return {
    id: 's6',
    thresholdPercent: 0.1,
    direction: 'positive',
    entryOffsetSeconds: 3,
    fundingFeeTimeoutSeconds: 10,
    tpMultiplier: 1.5,
    slMultiplier: 1.5,
    deadlineSeconds: 1800,
    amountUsd: 10,
    leverage: 5,
    ...overrides,
  }
}

/** A MONITORING projection carrying the settled rate the geometry keys off. */
function monitored(entrySide: 'long' | 'short', settledRatePercent: number, ratePercent = 0.05): MonitoredIntent {
  return {
    intentId: 'BTC-1',
    symbol: 'BTC',
    entrySide,
    entryQty: 0.01,
    entryFillPx: 60_000,
    enteredAtMs: 0,
    ratePercent,
    settledRatePercent,
  }
}

describe('selectSignedAny (07 §1)', () => {
  it('positive threshold triggers on funding ≥ threshold, declines below', () => {
    const c = config({ thresholdPercent: 0.1 })
    expect(selectSignedAny(candidate(0.1), c)).toEqual({ symbol: 'BTC', settleTs: 8 * 3_600_000 })
    expect(selectSignedAny(candidate(0.2), c)).not.toBeUndefined()
    expect(selectSignedAny(candidate(0.05), c)).toBeUndefined()
  })

  it('negative threshold triggers on funding ≤ threshold, declines above', () => {
    const c = config({ thresholdPercent: -0.1, direction: 'negative' })
    expect(selectSignedAny(candidate(-0.1), c)).not.toBeUndefined()
    expect(selectSignedAny(candidate(-0.4), c)).not.toBeUndefined()
    expect(selectSignedAny(candidate(-0.05), c)).toBeUndefined()
  })

  it('threshold 0 is always-on (any rate triggers)', () => {
    const c = config({ thresholdPercent: 0 })
    expect(selectSignedAny(candidate(5), c)).not.toBeUndefined()
    expect(selectSignedAny(candidate(-5), c)).not.toBeUndefined()
    expect(selectSignedAny(candidate(0), c)).not.toBeUndefined()
  })
})

describe('strategy6Geometry (07 §2 step 4 — settled |F|)', () => {
  // Settled 0.2 ≠ predicted 0.05, so the geometry derives from the settled rate (verification step 6):
  // |F| = 0.2; TP distance = 0.2 × 1.5 / 100 = 0.003; SL distance = 0.2 × 1.5 / 100 = 0.003.
  const SETTLED = 0.2

  it('LONG main: TP above entry, SL below entry, both from settled |F|', () => {
    const intent = monitored('long', SETTLED)
    const c = config()
    expect(strategy6Geometry.tpPrice(intent, c)).toBeCloseTo(60_000 * (1 + 0.003), 6) // 60 180
    expect(strategy6Geometry.slPrice(intent, c)).toBeCloseTo(60_000 * (1 - 0.003), 6) // 59 820
  })

  it('SHORT main: TP below entry, SL above entry (mirror), both from settled |F|', () => {
    const intent = monitored('short', SETTLED)
    const c = config()
    expect(strategy6Geometry.tpPrice(intent, c)).toBeCloseTo(60_000 * (1 - 0.003), 6) // 59 820
    expect(strategy6Geometry.slPrice(intent, c)).toBeCloseTo(60_000 * (1 + 0.003), 6) // 60 180
  })

  it('uses the settled rate, not the predicted rate (settled ≠ predicted)', () => {
    // Predicted 0.05 would give TP 60 000×(1+0.05×1.5/100)=60 045; settled 0.2 gives 60 180.
    const intent = monitored('long', SETTLED, 0.05)
    expect(strategy6Geometry.tpPrice(intent, config())).toBeCloseTo(60_180, 3)
  })

  it('a negative settled rate uses |F| (magnitude), same geometry', () => {
    const intent = monitored('long', -SETTLED)
    expect(strategy6Geometry.tpPrice(intent, config())).toBeCloseTo(60_180, 3)
  })

  it('fails loud when the settled/predicted rate and threshold are all absent for |F| — falls back to threshold', () => {
    const intent: MonitoredIntent = { ...monitored('long', 0), settledRatePercent: undefined, ratePercent: undefined }
    // |F| falls back to the config threshold (0.1): TP = 60 000×(1+0.1×1.5/100) = 60 090.
    expect(strategy6Geometry.tpPrice(intent, config({ thresholdPercent: 0.1 }))).toBeCloseTo(60_090, 3)
  })
})
