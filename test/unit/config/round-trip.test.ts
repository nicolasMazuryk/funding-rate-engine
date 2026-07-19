import { describe, expect, it } from 'vitest'
import {
  boundFor,
  type CanonicalParam,
  paramsFor,
  STRATEGY_IDS,
  type StrategyId,
} from '../../../src/config/canonical.js'
import { parseStrategyConfig } from '../../../src/config/parse-strategy-config.js'
import { strategyYaml } from './fixtures.js'

/**
 * Round-trip guard (`00_globals.md` §9.2 item 4): every canonical parameter is
 * emitted to the live schema, re-parsed, and compared numerically to its source —
 * catching any silent unit/scale drift between the table and the derived schema.
 * Required-no-default fields (deadline, mainSide, mainAmountUsd) are filled with a
 * documented in-bounds probe value.
 */
function probe(param: CanonicalParam, id: StrategyId): number | string {
  if (param.zodType === 'enum') return param.enumValues?.[0] ?? ''
  const b = boundFor(param, id)
  const step = param.zodType === 'int' ? 1 : 0.1
  if (b?.min !== undefined) return b.exclusiveMin ? b.min + step : b.min
  if (b?.max !== undefined) return b.exclusiveMax ? b.max - step : b.max
  return param.zodType === 'int' ? 1 : 1
}

function sourceValue(param: CanonicalParam, id: StrategyId): number | string {
  return param.schemaDefaults[id] ?? probe(param, id)
}

describe('canonical round-trip', () => {
  for (const id of STRATEGY_IDS) {
    it(`${id}: every parameter re-parses to its source value`, () => {
      const spRows = paramsFor(id, 'strategy_params')
      const szRows = paramsFor(id, 'sizing')
      const params: Record<string, number | string> = {}
      const sizing: Record<string, number> = {}
      for (const r of spRows) params[r.yamlKey] = sourceValue(r, id)
      for (const r of szRows) sizing[r.yamlKey] = sourceValue(r, id) as number

      const parsed = parseStrategyConfig(strategyYaml({ strategy: id, params, sizing }), id)

      for (const r of spRows) expect(parsed.strategyParams[r.liveKey]).toBe(sourceValue(r, id))
      for (const r of szRows) expect(parsed.sizing[r.liveKey]).toBe(sourceValue(r, id))
    })
  }
})
