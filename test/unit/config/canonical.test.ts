import { describe, expect, it } from 'vitest'
import { CANONICAL_PARAMS, paramsFor, STRATEGY_IDS } from '../../../src/config/canonical.js'

/**
 * Invariants of the canonical table itself — the source of truth every schema is
 * derived from. A broken table is a systemic defect, so these guard its shape.
 */
describe('CANONICAL_PARAMS table', () => {
  it('has unique live keys', () => {
    const keys = CANONICAL_PARAMS.map((p) => p.liveKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('references only known strategies, with defaults ⊆ strategies', () => {
    const ids = new Set<string>(STRATEGY_IDS)
    for (const p of CANONICAL_PARAMS) {
      expect(p.strategies.length).toBeGreaterThan(0)
      for (const s of p.strategies) expect(ids.has(s)).toBe(true)
      for (const s of Object.keys(p.schemaDefaults)) expect(p.strategies).toContain(s)
      for (const s of Object.keys(p.boundsByStrategy ?? {})) expect(p.strategies).toContain(s)
    }
  })

  it('gives enum params an enumValues list', () => {
    for (const p of CANONICAL_PARAMS) {
      if (p.zodType === 'enum') expect(p.enumValues?.length).toBeGreaterThan(0)
    }
  })

  it('models amountUsd/mainAmountUsd as two rows sharing one on-disk key, disjoint strategies covering all', () => {
    const amount = CANONICAL_PARAMS.filter((p) => p.yamlKey === 'amount_usd')
    expect(amount.map((p) => p.liveKey).sort()).toEqual(['amountUsd', 'mainAmountUsd'])
    for (const p of amount) expect(p.container).toBe('sizing')
    const [a, b] = amount
    // disjoint
    for (const s of a?.strategies ?? []) expect(b?.strategies).not.toContain(s)
    // union = all strategies
    const union = new Set([...(a?.strategies ?? []), ...(b?.strategies ?? [])])
    expect(union.size).toBe(STRATEGY_IDS.length)
  })

  it('resolves exactly one amount_usd + one leverage sizing row per strategy', () => {
    for (const id of STRATEGY_IDS) {
      const sizing = paramsFor(id, 'sizing')
      expect(sizing.map((p) => p.yamlKey).sort()).toEqual(['amount_usd', 'leverage'])
    }
  })
})
