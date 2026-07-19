/**
 * Scenario: **venue unavailable streak** (`13` §6 — 5xx / maintenance → circuit-open).
 * Same call-counting plumbing as rate-limit, generalized to the `VenueUnavailable`
 * kind: a streak of consecutive failing ordinals models a venue outage the circuit
 * breaker (`13` §3) will later trip on. The breaker itself is not wired here — this
 * task only proves the sim can produce the streak deterministically.
 */

import { describe, expect, it } from 'vitest'
import { SimVenueError } from '../../src/adapters/sim/sim-venue-error.js'
import { simHarness } from './sim-harness.js'

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
