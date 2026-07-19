import { describe, expect, it } from 'vitest'
import { parseStrategyConfig } from '../../../src/config/parse-strategy-config.js'
import { strategyYaml, VALID_PARAMS } from './fixtures.js'

/**
 * S6 legacy alias (`00_globals.md` §11-R6): the deprecated on-disk key
 * `funding_threshold` is accepted for one migration cycle, mapped to
 * `fundingThresholdPercent`, and surfaces a warning (Zod has no warning channel,
 * so parseStrategyConfig carries it out-of-band).
 */
describe('S6 funding_threshold legacy alias', () => {
  it('accepts the legacy key, warns, and lands the value on fundingThresholdPercent', () => {
    const { funding_threshold_percent, ...rest } = VALID_PARAMS.s6 as Record<string, number | string>
    void funding_threshold_percent
    const params = { ...rest, funding_threshold: 0.1 }
    const parsed = parseStrategyConfig(strategyYaml({ strategy: 's6', params }), 's6')
    expect(parsed.strategyParams.fundingThresholdPercent).toBe(0.1)
    expect(parsed.warnings.length).toBeGreaterThan(0)
    expect(parsed.warnings[0]).toContain('funding_threshold')
  })

  it('emits no warning when the canonical key is used', () => {
    const parsed = parseStrategyConfig(strategyYaml({ strategy: 's6' }), 's6')
    expect(parsed.warnings).toEqual([])
    expect(parsed.strategyParams.fundingThresholdPercent).toBe(0.1)
  })

  it('canonical key wins when both are present, alias still dropped + warned', () => {
    const params = { ...VALID_PARAMS.s6, funding_threshold: -0.9 }
    const parsed = parseStrategyConfig(strategyYaml({ strategy: 's6', params }), 's6')
    expect(parsed.strategyParams.fundingThresholdPercent).toBe(0.1)
    expect(parsed.warnings.length).toBeGreaterThan(0)
  })
})
