import { describe, expect, it } from 'vitest'
import type { StrategyId } from '../../../src/config/canonical.js'
import { ConfigParseError } from '../../../src/config/errors.js'
import { parseStrategyConfig } from '../../../src/config/parse-strategy-config.js'
import { strategyYaml, VALID_PARAMS } from './fixtures.js'

/** Each case overrides one param on a valid preset and expects a ConfigParseError. */
const CASES: ReadonlyArray<{ name: string; strategy: StrategyId; override: Record<string, number>; code?: string }> = [
  { name: 'entry_offset_seconds < 2', strategy: 's1', override: { entry_offset_seconds: 1 }, code: 'too_small' },
  {
    name: 'exit_offset_seconds = 5 (must be > 5)',
    strategy: 's1',
    override: { exit_offset_seconds: 5 },
    code: 'too_small',
  },
  { name: 'deadline_seconds < 10', strategy: 's2', override: { deadline_seconds: 5 }, code: 'too_small' },
  { name: 'deadline_seconds > 3600', strategy: 's2', override: { deadline_seconds: 4000 }, code: 'too_big' },
  {
    name: 'funding_fee_timeout_seconds < 5',
    strategy: 's1-ws',
    override: { funding_fee_timeout_seconds: 3 },
    code: 'too_small',
  },
  {
    name: 'funding_fee_timeout_seconds > 120',
    strategy: 's1-ws',
    override: { funding_fee_timeout_seconds: 200 },
    code: 'too_big',
  },
  { name: 'ladder_count < 2', strategy: 's4-1a', override: { ladder_count: 1 }, code: 'too_small' },
  { name: 'ladder_count > 20', strategy: 's4-1a', override: { ladder_count: 25 }, code: 'too_big' },
  { name: 'retracement_pct = 0 (exclusive min)', strategy: 's2', override: { retracement_pct: 0 }, code: 'too_small' },
  { name: 'retracement_pct = 50', strategy: 's2', override: { retracement_pct: 50 }, code: 'too_big' },
  {
    name: 'negative_funding_threshold = 0 (exclusive max)',
    strategy: 's1',
    override: { negative_funding_threshold_percent: 0 },
    code: 'too_big',
  },
  {
    name: 'negative_funding_threshold < -5',
    strategy: 's1',
    override: { negative_funding_threshold_percent: -6 },
    code: 'too_small',
  },
  {
    name: 'funding_threshold_percent > 5',
    strategy: 's6',
    override: { funding_threshold_percent: 6 },
    code: 'too_big',
  },
  {
    name: 'funding_threshold_percent < -5',
    strategy: 's6',
    override: { funding_threshold_percent: -6 },
    code: 'too_small',
  },
  { name: 'stop_loss_percent < 0.2', strategy: 's3a', override: { stop_loss_percent: 0.1 }, code: 'too_small' },
  { name: 'stop_loss_percent > 5', strategy: 's3a', override: { stop_loss_percent: 6 }, code: 'too_big' },
  { name: 'sl_multiplier < 0.5 (S2 range)', strategy: 's2', override: { sl_multiplier: 0.4 }, code: 'too_small' },
  { name: 'sl_multiplier < 1.0 (S4.2a range)', strategy: 's4-2a', override: { sl_multiplier: 0.9 }, code: 'too_small' },
  {
    name: 'ladder_bottom_mult <= ladder_top_mult',
    strategy: 's4-1a',
    override: { ladder_bottom_mult: 0.3 },
    code: 'ladder_inverted',
  },
  {
    name: 'sl_multiplier <= limit_offset_mult (S4.2a)',
    strategy: 's4-2a',
    override: { limit_offset_mult: 2.0 },
    code: 'sl_below_entry',
  },
]

describe('parameter bounds (00_globals §9.1)', () => {
  for (const c of CASES) {
    it(`rejects ${c.name}`, () => {
      const params = { ...VALID_PARAMS[c.strategy], ...c.override }
      try {
        parseStrategyConfig(strategyYaml({ strategy: c.strategy, params }), c.strategy)
        throw new Error('expected throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigParseError)
        if (c.code) expect((e as ConfigParseError).code).toBe(c.code)
      }
    })
  }
})
