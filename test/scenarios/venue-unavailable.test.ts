/**
 * Scenario: **venue unavailable streak** (`13` §6 — 5xx / maintenance → circuit-open).
 * Same call-counting plumbing as rate-limit, generalized to the `VenueUnavailable`
 * kind: a streak of consecutive failing ordinals models a venue outage the circuit
 * breaker (`13` §3) will later trip on. The breaker itself is not wired here — this
 * task only proves the sim can produce the streak deterministically.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../src/adapters/clock/virtual-clock.js'
import { SimVenueError } from '../../src/adapters/sim/sim-venue-error.js'
import { createCircuitBreaker } from '../../src/risk/breaker.js'
import { buildSkeletonEngine } from '../helpers/build-skeleton-engine.js'
import { driveToDeadline, driveToEntry, ENTRY_TS, INTENT_ID, START_MS } from '../helpers/skeleton-scenario.js'
import { tempDir } from '../helpers/temp-dir.js'
import { simHarness } from './sim-harness.js'

const VU = { kind: 'VenueUnavailable' } as const

describe('scenario: venue unavailable streak', () => {
  it('throws VenueUnavailable for a run of getPositions calls, then recovers', async () => {
    const { sim } = simHarness()
    sim.scriptRateLimit('getPositions', 'VenueUnavailable', [1, 2, 3])

    for (let i = 0; i < 3; i++) {
      try {
        sim.getPositions()
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(SimVenueError)
        expect((err as SimVenueError).kind).toBe('VenueUnavailable')
      }
    }
    expect(await sim.getPositions()).toEqual([]) // streak over, call passes through
  })
})

describe('scenario: venue-io breaker protects an open position', () => {
  it('rejects a new entry risk_breaker_open while a MONITORING exit still submits and fills', async () => {
    const tmp = tempDir('venue-unavailable-breaker-')
    try {
      const clock = createVirtualClock(START_MS)
      // Cooldown far past the deadline → the breaker stays open across the whole window.
      const breaker = createCircuitBreaker({ clock, threshold: 3, cooldownMs: 10_000_000 })
      const h = buildSkeletonEngine({ walPath: tmp.walPath, clock, breakerOpen: () => breaker.isOpen() })

      driveToEntry(h) // BTC → MONITORING (breaker still closed)
      expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')

      // A VenueUnavailable streak trips the venue-io breaker.
      breaker.record(VU)
      breaker.record(VU)
      breaker.record(VU)
      expect(breaker.isOpen()).toBe(true)

      // A NEW entry candidate (ETH, priced in driveToEntry) is rejected risk_breaker_open...
      const ethTs = ENTRY_TS + 60_000
      const ethIntent = `ETH-${ethTs}`
      h.bus.publish({ type: 'Timer', kind: 'entry', ts: ethTs, symbol: 'ETH' })
      expect(h.engine.intentState(ethIntent)).toBe('ABORTED')
      const aborted = h.wal.readAll().find((r) => r.intentId === ethIntent && r.toState === 'ABORTED')
      expect((aborted?.payload as { errorCode?: string } | undefined)?.errorCode).toBe('risk_breaker_open')

      // ...while the open BTC position's deadline exit still submits and fills (never abandoned).
      driveToDeadline(h)
      expect(h.engine.intentState(INTENT_ID)).toBe('CLOSED')
      expect(await h.exchange.getPositions()).toEqual([])
    } finally {
      tmp.dispose()
    }
  })
})
