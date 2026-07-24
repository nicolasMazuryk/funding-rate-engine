/**
 * Unit: **breaker escalation** (`13` §3, task 0380). A breaker still open at the escalation bound
 * escalates the kill switch to `flatten`; a breaker that recovers (half_open/closed) before the
 * bound cancels the pending escalation. Clock-only, deterministic.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../src/adapters/clock/virtual-clock.js'
import type { KillSwitchState } from '../../../src/config/env.js'
import { createCircuitBreaker } from '../../../src/risk/breaker.js'
import { createBreakerEscalation } from '../../../src/risk/breaker-escalation.js'

const NET = { kind: 'NetworkError' } as const

/** A kill-switch stub recording only the transitions the escalation fires. */
function fakeKillSwitch() {
  const calls: Array<{ to: KillSwitchState; reason?: string }> = []
  return { transition: (to: KillSwitchState, reason?: string) => calls.push({ to, reason }), calls }
}

describe('breaker escalation (13 §3)', () => {
  it('escalates to flatten when a breaker is still open at the escalation bound', () => {
    const clock = createVirtualClock(0)
    const ks = fakeKillSwitch()
    // cooldown > escalation → the breaker is still `open` when the escalation timer fires.
    const breaker = createCircuitBreaker({ clock, threshold: 1, cooldownMs: 600_000 })
    const escalation = createBreakerEscalation({ breakers: [breaker], killSwitch: ks, clock, escalationMs: 300_000 })

    breaker.record(NET)
    expect(breaker.state()).toBe('open')
    expect(ks.calls).toEqual([]) // not yet at the bound

    clock.advanceBy(300_000)
    expect(ks.calls).toEqual([{ to: 'flatten', reason: 'breaker_open_timeout' }])
    escalation.dispose()
  })

  it('cancels the escalation when the breaker recovers before the bound', () => {
    const clock = createVirtualClock(0)
    const ks = fakeKillSwitch()
    const breaker = createCircuitBreaker({ clock, threshold: 1, cooldownMs: 30_000 })
    const escalation = createBreakerEscalation({ breakers: [breaker], killSwitch: ks, clock, escalationMs: 300_000 })

    breaker.record(NET)
    clock.advanceBy(30_000) // → half_open, cancelling the pending escalation
    breaker.recordSuccess() // → closed
    clock.advanceBy(300_000) // past the original bound

    expect(ks.calls).toEqual([]) // recovered in time → no escalation
    escalation.dispose()
  })
})
