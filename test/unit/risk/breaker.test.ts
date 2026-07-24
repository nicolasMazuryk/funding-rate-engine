/**
 * Unit: **circuit-breaker FSM** (`13_risk_and_failure_modes.md` §3, task 0380). Drives the three
 * states against a virtual clock (the cooldown is a clock timer): closed → open at threshold;
 * advance past cooldown → half_open; `recordSuccess` → closed; a counted error in half_open →
 * re-open. Also proves the counted-kind predicate (io vs order breaker) and success-resets-run.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../src/adapters/clock/virtual-clock.js'
import { createCircuitBreaker } from '../../../src/risk/breaker.js'

const NET = { kind: 'NetworkError' } as const
const REJECT = { kind: 'OrderRejected' } as const

describe('circuit breaker FSM (13 §3)', () => {
  it('closed → open at threshold → half_open after cooldown → closed on success → re-open on half_open failure', () => {
    const clock = createVirtualClock(0)
    const b = createCircuitBreaker({ clock, threshold: 3, cooldownMs: 30_000 })
    expect(b.state()).toBe('closed')

    b.record(NET)
    b.record(NET)
    expect(b.isOpen()).toBe(false) // below threshold
    b.record(NET)
    expect(b.state()).toBe('open')
    expect(b.isOpen()).toBe(true)
    expect(b.openSinceMs()).toBe(0)

    clock.advanceBy(30_000) // cooldown lifts to half_open (admits the probe)
    expect(b.state()).toBe('half_open')
    expect(b.isOpen()).toBe(false)

    b.recordSuccess() // probe succeeded → heal
    expect(b.state()).toBe('closed')
    expect(b.openSinceMs()).toBeUndefined()

    // Re-open, cooldown, then a counted error in half_open re-opens straight away.
    b.record(NET)
    b.record(NET)
    b.record(NET)
    expect(b.state()).toBe('open')
    clock.advanceBy(30_000)
    expect(b.state()).toBe('half_open')
    b.record(NET)
    expect(b.state()).toBe('open')
  })

  it('ignores non-counted kinds and lets a success interrupt a partial run', () => {
    const clock = createVirtualClock(0)
    const b = createCircuitBreaker({ clock, threshold: 2, cooldownMs: 1000 })
    b.record(NET)
    b.record(REJECT) // OrderRejected is not counted by the default (io) predicate
    expect(b.count()).toBe(1)
    b.recordSuccess()
    expect(b.count()).toBe(0)
    b.record(NET) // run restarted from zero → still one short of threshold
    expect(b.state()).toBe('closed')
  })

  it('a custom predicate (order breaker) counts only OrderRejected', () => {
    const clock = createVirtualClock(0)
    const b = createCircuitBreaker({ clock, threshold: 2, cooldownMs: 1000, counts: (e) => e.kind === 'OrderRejected' })
    b.record(NET) // ignored by the order predicate
    expect(b.count()).toBe(0)
    b.record(REJECT)
    b.record(REJECT)
    expect(b.state()).toBe('open')
  })

  it('a counted error while open is a no-op — admission stays blocked until cooldown', () => {
    const clock = createVirtualClock(0)
    const b = createCircuitBreaker({ clock, threshold: 1, cooldownMs: 10_000 })
    b.record(NET)
    expect(b.state()).toBe('open')
    b.record(NET) // no re-arming of the cooldown, no state change
    expect(b.state()).toBe('open')
    clock.advanceBy(10_000)
    expect(b.state()).toBe('half_open')
  })
})
