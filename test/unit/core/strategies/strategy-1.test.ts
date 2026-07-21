/**
 * Strategy 1 selection unit tests (task 0280; `01_strategy_1.md` §1). The module
 * is a pure selector — it applies only its §G-L most-negative threshold rule to a
 * guarded candidate. Boundary matters: `-0.4 ≤ -0.4` selects, `-0.39` does not.
 */

import { describe, expect, it } from 'vitest'
import type { Candidate } from '../../../../src/core/runtime/finder.js'
import type { RuntimeStrategyConfig } from '../../../../src/core/strategies/registry.js'
import { createStrategy1 } from '../../../../src/core/strategies/strategy-1.js'

const RUNTIME: RuntimeStrategyConfig = {
  id: 's1',
  thresholdPercent: -0.4,
  direction: 'negative',
  entryOffsetSeconds: 5,
  exitOffsetSeconds: 6,
  amountUsd: 20,
  leverage: 4,
}

function candidate(ratePercent: number): Candidate {
  return { symbol: 'BTC', ratePercent, settleTs: 8 * 3_600_000, observedTs: 0 }
}

describe('createStrategy1', () => {
  const module = createStrategy1()

  it('registers as a timed module under id s1', () => {
    expect(module.id).toBe('s1')
    expect(module.exitPolicyKind).toBe('timed')
  })

  it('selects a rate more negative than the threshold, returning the trigger', () => {
    expect(module.select(candidate(-0.55), RUNTIME)).toEqual({ symbol: 'BTC', settleTs: 8 * 3_600_000 })
  })

  it('selects a rate exactly at the threshold (≤, inclusive)', () => {
    expect(module.select(candidate(-0.4), RUNTIME)).toEqual({ symbol: 'BTC', settleTs: 8 * 3_600_000 })
  })

  it('declines a rate just above the threshold (-0.39)', () => {
    expect(module.select(candidate(-0.39), RUNTIME)).toBeUndefined()
  })

  it('declines a positive rate', () => {
    expect(module.select(candidate(0.01), RUNTIME)).toBeUndefined()
  })
})
