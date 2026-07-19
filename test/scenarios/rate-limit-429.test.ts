/**
 * Scenario: **rate-limit 429** (`13` §6 — rate-limit exhaustion). `scriptRateLimit`
 * makes selected call ordinals of a call class throw a typed `SimVenueError{kind:
 * 'RateLimited'}` instead of running. No token bucket (that is 0200's rate limiter) —
 * just deterministic per-ordinal failure. Exercised via direct `sim.*()` calls (plan
 * §3 ASSUMPTION): the engine's fire-and-forget `placeOrder` is not wired to raise
 * these to the order FSM until 0200.
 */

import { describe, expect, it } from 'vitest'
import { SimVenueError } from '../../src/adapters/sim/sim-venue-error.js'
import { simHarness } from './sim-harness.js'

describe('scenario: rate-limit 429', () => {
  it('throws RateLimited on the first placeOrder, then succeeds on retry', async () => {
    const { sim } = simHarness()
    sim.setPrice('BTC', 60_000)
    sim.scriptRateLimit('placeOrder', 'RateLimited', [1])

    const req = { symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: 'o' } as const
    expect(() => sim.placeOrder(req)).toThrow(SimVenueError)
    try {
      sim.placeOrder(req)
    } catch (err) {
      expect((err as SimVenueError).kind).toBe('RateLimited')
      expect((err as SimVenueError).callClass).toBe('placeOrder')
    }

    // Second attempt (call ordinal 3) passes through and fills.
    const ack = await sim.placeOrder({ ...req, clientOrderId: 'o2' })
    expect(ack.accepted).toBe(true)
  })

  it('sustains rate-limit exhaustion across a run of calls, then recovers', async () => {
    const { sim } = simHarness()
    sim.scriptRateLimit('getBalance', 'RateLimited', [1, 2, 3])

    expect(() => sim.getBalance()).toThrow(/RateLimited/)
    expect(() => sim.getBalance()).toThrow(/RateLimited/)
    expect(() => sim.getBalance()).toThrow(/RateLimited/)
    expect((await sim.getBalance()).free).toBe(10_000) // 4th call recovers
  })
})
