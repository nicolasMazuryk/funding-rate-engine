import { describe, expect, it } from 'vitest'
import { STRATEGY_IDS } from '../../../src/config/canonical.js'
import { ConfigParseError } from '../../../src/config/errors.js'
import { parseStrategyConfig } from '../../../src/config/parse-strategy-config.js'
import { SIZING_SCHEMAS, STRATEGY_PARAMS_SCHEMAS } from '../../../src/config/schema.js'
import { strategyYaml, VALID_PARAMS } from './fixtures.js'

describe('schema derivation', () => {
  it('builds one params + sizing schema per strategy', () => {
    for (const id of STRATEGY_IDS) {
      expect(STRATEGY_PARAMS_SCHEMAS[id]).toBeDefined()
      expect(SIZING_SCHEMAS[id]).toBeDefined()
    }
  })

  it('accepts each strategy valid preset', () => {
    for (const id of STRATEGY_IDS) {
      expect(() => parseStrategyConfig(strategyYaml({ strategy: id }), id)).not.toThrow()
    }
  })

  it('applies schema defaults for omitted fields', () => {
    // s1-ws omits entry_offset_seconds → default 5 (00_globals §8.2)
    const params = { negative_funding_threshold_percent: -0.4, funding_fee_timeout_seconds: 10 }
    const parsed = parseStrategyConfig(strategyYaml({ strategy: 's1-ws', params }), 's1-ws')
    expect(parsed.strategyParams.entryOffsetSeconds).toBe(5)
  })

  it('rejects an unknown key on strategy_params (.strict)', () => {
    const params = { ...VALID_PARAMS.s1, bogus_key: 1 }
    try {
      parseStrategyConfig(strategyYaml({ strategy: 's1', params }), 's1')
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
      expect((e as ConfigParseError).code).toBe('unrecognized_keys')
    }
  })

  it('rejects a strategy mismatch between id and YAML', () => {
    const yaml = strategyYaml({ strategy: 's1' })
    expect(() => parseStrategyConfig(yaml, 's2')).toThrow(ConfigParseError)
  })

  it('rejects YAML syntax errors as ConfigParseError', () => {
    try {
      parseStrategyConfig('instance: [unterminated', 's1')
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
      expect((e as ConfigParseError).code).toBe('yaml_syntax')
    }
  })
})
