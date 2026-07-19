import { describe, expect, it } from 'vitest'
import type { StrategyId } from '../../../src/config/canonical.js'
import { ConfigParseError } from '../../../src/config/errors.js'
import { parseStrategyConfig } from '../../../src/config/parse-strategy-config.js'
import { strategyYaml, VALID_PARAMS } from './fixtures.js'

/**
 * The take-profit unit guard (`00_globals.md` §9.2 item 3 / §11-R4): a value below
 * 0.05 is the classic fraction-mistaken-for-percent defect and must fail with the
 * identifiable `unit_suspect_fraction` code, not a generic bound message.
 */
function parseTp(strategy: StrategyId, value: number): void {
  const params = { ...VALID_PARAMS[strategy], take_profit_pct: value }
  parseStrategyConfig(strategyYaml({ strategy, params }), strategy)
}

describe('take_profit_pct unit guard', () => {
  for (const strategy of ['s4-1a', 's4-2a'] as const) {
    it(`${strategy}: 0.003 → unit_suspect_fraction`, () => {
      try {
        parseTp(strategy, 0.003)
        throw new Error('expected throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigParseError)
        expect((e as ConfigParseError).code).toBe('unit_suspect_fraction')
      }
    })

    it(`${strategy}: 0.04 (just under 0.05) → unit_suspect_fraction`, () => {
      try {
        parseTp(strategy, 0.04)
        throw new Error('expected throw')
      } catch (e) {
        expect((e as ConfigParseError).code).toBe('unit_suspect_fraction')
      }
    })

    it(`${strategy}: 0.05 boundary accepted`, () => {
      expect(() => parseTp(strategy, 0.05)).not.toThrow()
    })

    it(`${strategy}: 6.0 → generic too_big, NOT unit guard`, () => {
      try {
        parseTp(strategy, 6.0)
        throw new Error('expected throw')
      } catch (e) {
        expect((e as ConfigParseError).code).not.toBe('unit_suspect_fraction')
      }
    })
  }
})
