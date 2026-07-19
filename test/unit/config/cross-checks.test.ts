import { describe, expect, it } from 'vitest'
import {
  checkDeadlineVsTimeout,
  checkSizingFeasibilityHint,
  checkWsMandatoryGuard,
} from '../../../src/config/cross-checks.js'
import { ConfigParseError } from '../../../src/config/errors.js'
import type { ExchangeProfile } from '../../../src/config/exchange-schema.js'

function profile(wsOrderAdapter: boolean): ExchangeProfile {
  return {
    takerFeePct: 0.05,
    makerFeePct: 0.02,
    submissionStaggerMs: 100,
    rateLimitReservePct: 10,
    wsOrderAdapter,
    ws: { publicUrl: 'wss://x', privateUrl: 'wss://x' },
    deltas: {},
  }
}

describe('checkWsMandatoryGuard (09_configuration §6)', () => {
  it('throws ws_order_adapter_required for s2 with no adapter and no fallback (DoD #2 case 3)', () => {
    try {
      checkWsMandatoryGuard('s2', profile(false), false)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
      expect((e as ConfigParseError).code).toBe('ws_order_adapter_required')
    }
  })

  it('passes with a WS adapter', () => {
    expect(() => checkWsMandatoryGuard('s2', profile(true), false)).not.toThrow()
  })

  it('passes with a REST fallback even without an adapter', () => {
    expect(() => checkWsMandatoryGuard('s6', profile(false), true)).not.toThrow()
  })

  it('never throws for a non-WS-mandatory strategy (s1)', () => {
    expect(() => checkWsMandatoryGuard('s1', profile(false), false)).not.toThrow()
  })
})

describe('checkDeadlineVsTimeout (09_configuration §6)', () => {
  it('throws deadline_lt_timeout when deadline < timeout for s6 (DoD #2 case 4)', () => {
    try {
      checkDeadlineVsTimeout({ deadlineSeconds: 20, fundingFeeTimeoutSeconds: 30 }, 's6')
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
      expect((e as ConfigParseError).code).toBe('deadline_lt_timeout')
    }
  })

  it('passes when deadline >= timeout', () => {
    expect(() => checkDeadlineVsTimeout({ deadlineSeconds: 30, fundingFeeTimeoutSeconds: 30 }, 's2')).not.toThrow()
    expect(() => checkDeadlineVsTimeout({ deadlineSeconds: 900, fundingFeeTimeoutSeconds: 30 }, 's2')).not.toThrow()
  })

  it('is a no-op for a strategy the check does not apply to (s1-ws)', () => {
    expect(() => checkDeadlineVsTimeout({ deadlineSeconds: 5, fundingFeeTimeoutSeconds: 30 }, 's1-ws')).not.toThrow()
  })
})

describe('checkSizingFeasibilityHint (09_configuration §6)', () => {
  it('warns below the floor', () => {
    expect(checkSizingFeasibilityHint({ amountUsd: 3 }, 's1')).toMatch(/feasibility hint/)
  })

  it('does not warn at or above the floor', () => {
    expect(checkSizingFeasibilityHint({ amountUsd: 10 }, 's1')).toBeUndefined()
    expect(checkSizingFeasibilityHint({ mainAmountUsd: 5 }, 's6')).toBeUndefined()
  })
})
