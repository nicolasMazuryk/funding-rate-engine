/**
 * Strategy 2 selection unit tests (task 0310; `03_strategy_2.md` §1). S2 selects
 * **identically** to S1/S1-WS — all three apply the shared §G-L most-negative rule
 * (`group-l-selection.ts`), differing only in exit policy. These assert the id/kind, the
 * boundary (`-0.4 ≤ -0.4` selects, `-0.39` does not), and that S2 returns the *same*
 * trigger as the shared helper (proving reuse, not a copy).
 */

import { describe, expect, it } from 'vitest'
import type { Candidate } from '../../../../src/core/runtime/finder.js'
import { selectGroupL } from '../../../../src/core/strategies/group-l-selection.js'
import type { RuntimeStrategyConfig } from '../../../../src/core/strategies/registry.js'
import { createStrategy1Ws } from '../../../../src/core/strategies/strategy-1-ws.js'
import { createStrategy2 } from '../../../../src/core/strategies/strategy-2.js'

const RUNTIME: RuntimeStrategyConfig = {
  id: 's2',
  thresholdPercent: -0.4,
  direction: 'negative',
  entryOffsetSeconds: 3,
  fundingFeeTimeoutSeconds: 30,
  retracementPct: 1.0,
  slMultiplier: 2.0,
  deadlineSeconds: 900,
  amountUsd: 10,
  leverage: 5,
}

function candidate(ratePercent: number): Candidate {
  return { symbol: 'BTC', ratePercent, settleTs: 8 * 3_600_000, observedTs: 0 }
}

describe('createStrategy2', () => {
  const module = createStrategy2()

  it('registers as a retracement module under id s2', () => {
    expect(module.id).toBe('s2')
    expect(module.exitPolicyKind).toBe('sl_tp_deadline_retracement_funding_event')
  })

  it('selects a rate exactly at the threshold (≤, inclusive)', () => {
    expect(module.select(candidate(-0.4), RUNTIME)).toEqual({ symbol: 'BTC', settleTs: 8 * 3_600_000 })
  })

  it('declines a rate just above the threshold (-0.39)', () => {
    expect(module.select(candidate(-0.39), RUNTIME)).toBeUndefined()
  })

  it('shares the §G-L helper with S1-WS (identical trigger for the same candidate)', () => {
    const c = candidate(-0.55)
    const s1ws = createStrategy1Ws().select(c, { ...RUNTIME, id: 's1-ws' })
    const s2 = module.select(c, RUNTIME)
    expect(s2).toEqual(s1ws)
    expect(s2).toEqual(selectGroupL(c, RUNTIME))
  })
})
