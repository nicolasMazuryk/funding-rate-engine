import { describe, expect, it } from 'vitest'
import type { Candidate } from '../../../../src/core/runtime/finder.js'
import type { RuntimeStrategyConfig } from '../../../../src/core/strategies/registry.js'
import { createStubStrategy, type StubStrategyConfig } from '../../../../src/core/strategies/stub.js'

const CONFIG: StubStrategyConfig = {
  id: 's1',
  negativeFundingThresholdPercent: -0.3,
  entryOffsetSeconds: 90,
  holdMs: 300_000,
  entryQty: 0.01,
}

const RUNTIME: RuntimeStrategyConfig = {
  id: 's1',
  thresholdPercent: -0.3,
  direction: 'negative',
  entryOffsetSeconds: 90,
  holdMs: 300_000,
  entryQty: 0.01,
  amountUsd: 50,
  leverage: 1,
}

function candidate(ratePercent: number): Candidate {
  return { symbol: 'BTC', ratePercent, settleTs: 8 * 3_600_000, observedTs: 0 }
}

describe('createStubStrategy', () => {
  const module = createStubStrategy(CONFIG)

  it('registers as a timed module under the configured id', () => {
    expect(module.id).toBe('s1')
    expect(module.exitPolicyKind).toBe('timed')
  })

  it('selects a rate more negative than the threshold, returning the trigger', () => {
    expect(module.select(candidate(-0.5), RUNTIME)).toEqual({ symbol: 'BTC', settleTs: 8 * 3_600_000 })
  })

  it('selects a rate exactly at the threshold (≤, inclusive)', () => {
    expect(module.select(candidate(-0.3), RUNTIME)).toEqual({ symbol: 'BTC', settleTs: 8 * 3_600_000 })
  })

  it('declines a rate above the threshold', () => {
    expect(module.select(candidate(-0.29), RUNTIME)).toBeUndefined()
  })

  it('declines a positive rate', () => {
    expect(module.select(candidate(0.01), RUNTIME)).toBeUndefined()
  })
})
