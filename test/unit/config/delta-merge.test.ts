import { describe, expect, it } from 'vitest'
import { applyExchangeDeltas } from '../../../src/config/delta-merge.js'
import { ConfigParseError } from '../../../src/config/errors.js'
import type { ExchangeDelta, ExchangeProfile } from '../../../src/config/exchange-schema.js'
import { parseStrategyConfig } from '../../../src/config/parse-strategy-config.js'
import { strategyYaml } from './fixtures.js'

/** Minimal profile with the given deltas; other fields are inert here. */
function profileWith(deltas: ExchangeDelta): ExchangeProfile {
  return {
    takerFeePct: 0.05,
    makerFeePct: 0.02,
    submissionStaggerMs: 100,
    rateLimitReservePct: 10,
    wsOrderAdapter: true,
    ws: { publicUrl: 'wss://x', privateUrl: 'wss://x' },
    deltas,
  }
}

describe('applyExchangeDeltas (09_configuration §4, 00_globals §6)', () => {
  it('lands a funding_fee_timeout_seconds delta in effective config (DoD #2 case 1)', () => {
    const parsed = parseStrategyConfig(strategyYaml({ strategy: 's2' }), 's2')
    const merged = applyExchangeDeltas(parsed, profileWith({ fundingFeeTimeoutSeconds: 45 }), 's2')
    expect(merged.strategyParams.fundingFeeTimeoutSeconds).toBe(45)
  })

  it('throws delta_out_of_bounds on an out-of-range delta (DoD #2 case 2)', () => {
    const parsed = parseStrategyConfig(strategyYaml({ strategy: 's2' }), 's2')
    try {
      applyExchangeDeltas(parsed, profileWith({ fundingFeeTimeoutSeconds: 999 }), 's2') // bound max 120
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
      expect((e as ConfigParseError).code).toBe('delta_out_of_bounds')
    }
  })

  it('applies a nested leverage delta for the matching strategy', () => {
    const parsed = parseStrategyConfig(strategyYaml({ strategy: 's1' }), 's1')
    const merged = applyExchangeDeltas(parsed, profileWith({ leverage: { s1: 4 } }), 's1')
    expect(merged.sizing.leverage).toBe(4)
  })

  it('treats a delta on an irrelevant field as a no-op', () => {
    // s1 has no funding_fee_timeout_seconds; delta must be silently ignored.
    const parsed = parseStrategyConfig(strategyYaml({ strategy: 's1' }), 's1')
    const merged = applyExchangeDeltas(parsed, profileWith({ fundingFeeTimeoutSeconds: 45 }), 's1')
    expect(merged.strategyParams.fundingFeeTimeoutSeconds).toBeUndefined()
    // leverage delta for a different strategy is also a no-op for s1
    const merged2 = applyExchangeDeltas(parsed, profileWith({ leverage: { s2: 4 } }), 's1')
    expect(merged2.sizing.leverage).toBe(parsed.sizing.leverage)
  })

  it('surfaces ws_order_rest_fallback', () => {
    const parsed = parseStrategyConfig(strategyYaml({ strategy: 's2' }), 's2')
    expect(applyExchangeDeltas(parsed, profileWith({ wsOrderRestFallback: true }), 's2').wsOrderRestFallback).toBe(true)
    expect(applyExchangeDeltas(parsed, profileWith({}), 's2').wsOrderRestFallback).toBe(false)
  })
})
