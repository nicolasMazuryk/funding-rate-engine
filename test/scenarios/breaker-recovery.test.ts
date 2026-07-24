/**
 * Scenario: **half-open recovery** (`13` §3, task 0380). The venue-io breaker opens on a failure
 * streak; once the cooldown elapses it goes half_open (admitting a probe / a new intent), so a fresh
 * entry passes preflight and reaches MONITORING, and the next success closes the breaker. DoD #4.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../src/adapters/clock/virtual-clock.js'
import { createCircuitBreaker } from '../../src/risk/breaker.js'
import { buildSkeletonEngine } from '../helpers/build-skeleton-engine.js'
import { driveToEntry, INTENT_ID, START_MS } from '../helpers/skeleton-scenario.js'
import { tempDir } from '../helpers/temp-dir.js'

const VU = { kind: 'VenueUnavailable' } as const

describe('scenario: breaker half-open recovery', () => {
  it('a recovered (half_open) breaker admits a new intent, and the next success closes it', () => {
    const tmp = tempDir('breaker-recovery-')
    try {
      // Cooldown (1 s) elapses well before the scan (58 min later), so by entry the breaker is half_open.
      const clock = createVirtualClock(START_MS)
      const breaker = createCircuitBreaker({ clock, threshold: 3, cooldownMs: 1000 })
      const h = buildSkeletonEngine({ walPath: tmp.walPath, clock, breakerOpen: () => breaker.isOpen() })

      breaker.record(VU)
      breaker.record(VU)
      breaker.record(VU)
      expect(breaker.state()).toBe('open')

      driveToEntry(h) // clock advances past the cooldown → half_open → the BTC entry is admitted

      expect(breaker.state()).toBe('half_open')
      expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')

      breaker.recordSuccess() // the probe (ambient success) closes the breaker
      expect(breaker.state()).toBe('closed')
    } finally {
      tmp.dispose()
    }
  })
})
