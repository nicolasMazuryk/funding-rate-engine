import { describe, expect, it } from 'vitest'
import type { FundingPredicted } from '../../../../src/core/events/types.js'
import { findCandidates } from '../../../../src/core/runtime/finder.js'
import { createStubStrategy, type StubStrategyConfig } from '../../../../src/core/strategies/stub.js'

const CONFIG: StubStrategyConfig = {
  id: 's1',
  negativeFundingThresholdPercent: -0.3,
  entryOffsetMs: 90_000,
  holdMs: 300_000,
  entryQty: 0.01,
}
const strategy = createStubStrategy(CONFIG)

const predicted = (symbol: string, rate: number): FundingPredicted => ({
  type: 'FundingPredicted',
  symbol,
  rate,
  ts: 0,
})

describe('findCandidates', () => {
  it('keeps only symbols that clear the threshold (filters non-triggering ones)', () => {
    const result = findCandidates([predicted('BTC', -0.5), predicted('ETH', 0.01)], strategy)
    expect(result).toEqual([{ symbol: 'BTC', rate: -0.5 }])
  })

  it('orders most-negative first', () => {
    const result = findCandidates([predicted('BTC', -0.4), predicted('SOL', -0.9), predicted('ETH', -0.6)], strategy)
    expect(result.map((c) => c.symbol)).toEqual(['SOL', 'ETH', 'BTC'])
  })

  it('breaks ties on symbol for deterministic ordering, independent of input order', () => {
    const a = findCandidates([predicted('ETH', -0.5), predicted('BTC', -0.5)], strategy)
    const b = findCandidates([predicted('BTC', -0.5), predicted('ETH', -0.5)], strategy)
    expect(a.map((c) => c.symbol)).toEqual(['BTC', 'ETH'])
    expect(a).toEqual(b)
  })

  it('returns nothing when no symbol triggers', () => {
    expect(findCandidates([predicted('ETH', 0.2)], strategy)).toEqual([])
  })
})
