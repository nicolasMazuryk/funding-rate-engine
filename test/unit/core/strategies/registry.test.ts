import { describe, expect, it } from 'vitest'
import { createStrategyRegistry, type StrategyModule } from '../../../../src/core/strategies/registry.js'

function module(id: StrategyModule['id']): StrategyModule {
  return { id, exitPolicyKind: 'timed', select: () => undefined }
}

describe('createStrategyRegistry', () => {
  it('indexes modules by id', () => {
    const s1 = module('s1')
    const s6 = module('s6')
    const registry = createStrategyRegistry([s1, s6])

    expect(registry.get('s1')).toBe(s1)
    expect(registry.get('s6')).toBe(s6)
    expect(registry.get('s2')).toBeUndefined()
  })

  it('throws on a duplicate id (fail-loud)', () => {
    expect(() => createStrategyRegistry([module('s1'), module('s1')])).toThrow(/duplicate strategy id 's1'/)
  })
})
