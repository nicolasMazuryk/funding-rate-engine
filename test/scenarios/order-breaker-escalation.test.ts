/**
 * Scenario: **order-breaker escalation** (`13` §3, task 0380). A run of `OrderUpdate` REJECTED while
 * a live intent exists opens the order breaker → the kill switch escalates to `paused` (with a WAL
 * row). Left open past the escalation bound, it escalates further to `flatten`. DoD #8.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../src/adapters/clock/virtual-clock.js'
import { createCircuitBreaker } from '../../src/risk/breaker.js'
import { createBreakerEscalation } from '../../src/risk/breaker-escalation.js'
import { KILL_SWITCH_INTENT_ID } from '../../src/risk/kill-switch.js'
import { wireOrderBreakerFeed } from '../../src/risk/order-breaker-feed.js'
import { buildSkeletonEngine } from '../helpers/build-skeleton-engine.js'
import { driveToEntry, START_MS } from '../helpers/skeleton-scenario.js'
import { tempDir } from '../helpers/temp-dir.js'

/** Publish a REJECTED order update for an id the engine does not track (feeds only the order breaker). */
function reject(bus: { publish: (e: import('../../src/core/events/types.js').EngineEvent) => void }, id: string): void {
  bus.publish({ type: 'OrderUpdate', clientOrderId: id, status: 'REJECTED', errorKind: 'OrderRejected' })
}

describe('scenario: order-breaker escalation', () => {
  it('order rejects during a live intent → paused (WAL row), then open-too-long → flatten', () => {
    const tmp = tempDir('order-breaker-escalation-')
    try {
      const clock = createVirtualClock(START_MS)
      const h = buildSkeletonEngine({ walPath: tmp.walPath, clock })
      const orderBreaker = createCircuitBreaker({
        clock,
        threshold: 3,
        cooldownMs: 10_000_000, // stays open long enough to escalate
        counts: (e) => e.kind === 'OrderRejected',
      })
      const unwire = wireOrderBreakerFeed({
        bus: h.bus,
        breaker: orderBreaker,
        killSwitch: h.killSwitch,
        hasLiveIntent: () => h.engine.liveIntentCount() > 0,
      })
      const escalation = createBreakerEscalation({
        breakers: [orderBreaker],
        killSwitch: h.killSwitch,
        clock,
        escalationMs: 300_000,
      })

      driveToEntry(h) // a live MONITORING intent
      expect(h.engine.liveIntentCount()).toBe(1)

      // Threshold consecutive rejects → order breaker opens → paused (live intent present).
      reject(h.bus, 'x1')
      reject(h.bus, 'x2')
      reject(h.bus, 'x3')
      expect(orderBreaker.state()).toBe('open')
      expect(h.killSwitch.state()).toBe('paused')
      const pausedRow = h.wal.readAll().find((r) => r.intentId === KILL_SWITCH_INTENT_ID && r.toState === 'paused')
      expect(pausedRow).toBeDefined()

      // Still open at the escalation bound → escalate to flatten.
      clock.advanceBy(300_000)
      expect(h.killSwitch.state()).toBe('flatten')

      unwire()
      escalation.dispose()
      orderBreaker.dispose()
    } finally {
      tmp.dispose()
    }
  })
})
