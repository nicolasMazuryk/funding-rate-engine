/**
 * Risk-gate unit tests (task 0140; `13` §1). Concurrency, notional, breaker,
 * all-pass — checks run in that fixed order.
 */

import { describe, expect, it } from 'vitest'
import type { RiskContext, RiskIntent } from '../../../src/core/ports/risk-gate.js'
import { createRiskGate } from '../../../src/risk/gate.js'

const gate = createRiskGate({ maxConcurrentIntents: 3, maxNotionalUsd: 100 })

const intent = (amountUsd: number): RiskIntent => ({ symbol: 'BTC', amountUsd })
const ctx = (openIntentCount: number, breakerOpen = false): RiskContext => ({ openIntentCount, breakerOpen })

describe('createRiskGate', () => {
  it('allows an intent within every limit', () => {
    expect(gate.check(intent(50), ctx(2))).toEqual({ allowed: true })
  })

  it('rejects at the concurrency limit', () => {
    expect(gate.check(intent(50), ctx(3))).toEqual({ allowed: false, code: 'risk_max_concurrent_intents' })
  })

  it('rejects over the notional limit', () => {
    expect(gate.check(intent(101), ctx(0))).toEqual({ allowed: false, code: 'risk_max_notional_usd' })
  })

  it('rejects when a breaker is open', () => {
    expect(gate.check(intent(50), ctx(0, true))).toEqual({ allowed: false, code: 'risk_breaker_open' })
  })

  it('checks concurrency before notional', () => {
    // Both limits breached; concurrency is reported first.
    expect(gate.check(intent(200), ctx(3))).toEqual({ allowed: false, code: 'risk_max_concurrent_intents' })
  })
})
