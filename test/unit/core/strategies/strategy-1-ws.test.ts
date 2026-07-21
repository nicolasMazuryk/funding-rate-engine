/**
 * Strategy 1-WS selection unit tests (task 0300; `02_strategy_1_ws.md` §1). S1-WS
 * selects **identically** to S1 — both apply the shared §G-L most-negative rule
 * (`group-l-selection.ts`), differing only in exit policy. These assert the boundary
 * (`-0.4 ≤ -0.4` selects, `-0.39` does not) and, crucially, that S1 and S1-WS return
 * the *same* trigger for the same candidate — proving the shared helper, not a copy.
 */

import { describe, expect, it } from 'vitest'
import type { Candidate } from '../../../../src/core/runtime/finder.js'
import { selectGroupL } from '../../../../src/core/strategies/group-l-selection.js'
import type { RuntimeStrategyConfig } from '../../../../src/core/strategies/registry.js'
import { createStrategy1 } from '../../../../src/core/strategies/strategy-1.js'
import { createStrategy1Ws } from '../../../../src/core/strategies/strategy-1-ws.js'

const RUNTIME: RuntimeStrategyConfig = {
  id: 's1-ws',
  thresholdPercent: -0.4,
  direction: 'negative',
  entryOffsetSeconds: 3,
  fundingFeeTimeoutSeconds: 10,
  amountUsd: 10,
  leverage: 5,
}

function candidate(ratePercent: number): Candidate {
  return { symbol: 'BTC', ratePercent, settleTs: 8 * 3_600_000, observedTs: 0 }
}

describe('createStrategy1Ws', () => {
  const module = createStrategy1Ws()

  it('registers as a funding_fee_event module under id s1-ws', () => {
    expect(module.id).toBe('s1-ws')
    expect(module.exitPolicyKind).toBe('funding_fee_event')
  })

  it('selects a rate exactly at the threshold (≤, inclusive)', () => {
    expect(module.select(candidate(-0.4), RUNTIME)).toEqual({ symbol: 'BTC', settleTs: 8 * 3_600_000 })
  })

  it('declines a rate just above the threshold (-0.39)', () => {
    expect(module.select(candidate(-0.39), RUNTIME)).toBeUndefined()
  })

  it('shares the §G-L helper with S1 (identical trigger for the same candidate)', () => {
    const c = candidate(-0.55)
    const s1 = createStrategy1().select(c, { ...RUNTIME, id: 's1' })
    const s1ws = module.select(c, RUNTIME)
    expect(s1ws).toEqual(s1)
    expect(s1ws).toEqual(selectGroupL(c, RUNTIME))
  })
})
