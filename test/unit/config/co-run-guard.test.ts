import { describe, expect, it } from 'vitest'
import { checkCoRunGuard } from '../../../src/config/co-run-guard.js'
import { ConfigParseError } from '../../../src/config/errors.js'

describe('checkCoRunGuard (00_globals §9.1)', () => {
  it('rejects s3a enabled alongside an enabled LONG strategy', () => {
    try {
      checkCoRunGuard([
        { strategyId: 's3a', enabled: true },
        { strategyId: 's1', enabled: true },
      ])
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
      expect((e as ConfigParseError).code).toBe('s3a_co_run')
    }
  })

  it('accepts s3a alongside s6 (direction-configurable, exempt)', () => {
    expect(() =>
      checkCoRunGuard([
        { strategyId: 's3a', enabled: true },
        { strategyId: 's6', enabled: true },
      ]),
    ).not.toThrow()
  })

  it('accepts s3a alone', () => {
    expect(() => checkCoRunGuard([{ strategyId: 's3a', enabled: true }])).not.toThrow()
  })

  it('ignores disabled instances', () => {
    expect(() =>
      checkCoRunGuard([
        { strategyId: 's3a', enabled: true },
        { strategyId: 's1', enabled: false },
      ]),
    ).not.toThrow()
    expect(() =>
      checkCoRunGuard([
        { strategyId: 's3a', enabled: false },
        { strategyId: 's1', enabled: true },
      ]),
    ).not.toThrow()
  })
})
