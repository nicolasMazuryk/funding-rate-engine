/**
 * Exit-policy dispatch unit tests (task 0270/0280; `12` §5). Covers the registry
 * (duplicate-kind fail-loud + lookup) and the engine resolving its handler by kind
 * (an unregistered kind fails loud at `createEngine`, proving registry-driven
 * dispatch with no name branching — DoD #3). The `timed` handler's own arm/fire
 * behaviour lives in `intent/exit-policies/timed.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { TIMED_HANDLER } from '../../../src/core/intent/exit-policies/timed.js'
import { createExitPolicyRegistry, type ExitPolicyHandler } from '../../../src/core/intent/exit-policy.js'
import { createStrategyRegistry, type StrategyModule } from '../../../src/core/strategies/registry.js'
import { buildSkeletonEngine } from '../../helpers/build-skeleton-engine.js'
import { tempDir } from '../../helpers/temp-dir.js'

describe('createExitPolicyRegistry', () => {
  it('indexes handlers by kind', () => {
    const registry = createExitPolicyRegistry([TIMED_HANDLER])
    expect(registry.get('timed')).toBe(TIMED_HANDLER)
    expect(registry.get('funding_fee_event')).toBeUndefined()
  })

  it('throws on a duplicate kind (fail-loud)', () => {
    const other: ExitPolicyHandler = { ...TIMED_HANDLER }
    expect(() => createExitPolicyRegistry([TIMED_HANDLER, other])).toThrow(/duplicate exit-policy kind 'timed'/)
  })
})

describe('engine exit-policy resolution (DoD #3)', () => {
  it('fails loud when the active module declares an unregistered exit-policy kind', () => {
    const tmp = tempDir('exit-policy-test-')
    // Module declares `funding_fee_event`; the default registry only knows `timed`.
    const module: StrategyModule = { id: 's1', exitPolicyKind: 'funding_fee_event', select: () => undefined }
    try {
      expect(() => buildSkeletonEngine({ walPath: tmp.walPath, registry: createStrategyRegistry([module]) })).toThrow(
        /no exit-policy handler registered for kind 'funding_fee_event'/,
      )
    } finally {
      tmp.dispose()
    }
  })
})
