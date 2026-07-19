import { describe, expect, it } from 'vitest'
import { createStubStrategy, type StubStrategyConfig } from '../../../../src/core/strategies/stub.js'

const CONFIG: StubStrategyConfig = {
  id: 's1',
  negativeFundingThresholdPercent: -0.3,
  entryOffsetMs: 90_000,
  holdMs: 300_000,
  entryQty: 0.01,
}

describe('createStubStrategy.selects', () => {
  const strategy = createStubStrategy(CONFIG)

  it('selects a rate more negative than the threshold', () => {
    expect(strategy.selects(-0.5)).toBe(true)
  })

  it('selects a rate exactly at the threshold (≤, inclusive)', () => {
    expect(strategy.selects(-0.3)).toBe(true)
  })

  it('rejects a rate above the threshold', () => {
    expect(strategy.selects(-0.29)).toBe(false)
  })

  it('rejects a positive rate', () => {
    expect(strategy.selects(0.01)).toBe(false)
  })

  it('exposes its config unchanged', () => {
    expect(strategy.config).toEqual(CONFIG)
  })
})
