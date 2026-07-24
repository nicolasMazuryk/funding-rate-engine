/**
 * Scenario: **pre-entry stale reduce-only sweep** (`13`, task 0380). A resting reduce-only order
 * left by a crashed prior intent sits on the venue; when a fresh entry fires for that symbol the
 * engine sweeps it (cancels it) so it cannot fight the new position. Driven through the engine +
 * sim; the sweep is fire-and-forget, so we flush microtasks before asserting the cancel landed.
 */

import { describe, expect, it } from 'vitest'
import type { EngineEvent } from '../../src/core/events/types.js'
import { buildSkeletonEngine } from '../helpers/build-skeleton-engine.js'
import { driveToEntry, INTENT_ID, START_MS } from '../helpers/skeleton-scenario.js'
import { tempDir } from '../helpers/temp-dir.js'

/** Flush the fire-and-forget sweep's microtask chain (getOpenOrders → cancelOrder). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('scenario: stale reduce-only sweep before entry', () => {
  it('cancels a resting reduce-only leftover before the fresh entry places', async () => {
    const tmp = tempDir('stale-sweep-')
    try {
      const h = buildSkeletonEngine({ walPath: tmp.walPath, startMs: START_MS })
      const events: EngineEvent[] = []
      h.bus.subscribe((e) => events.push(e))

      // A crashed prior intent left a resting reduce-only SHORT limit on BTC (a leftover exit leg).
      // Seed the opposite (long) position so the reduce-only order is valid, and price it away from
      // its limit so it rests rather than crossing.
      h.exchange.setPosition('BTC', 'long', 0.001, 60_000)
      h.exchange.setPrice('BTC', 60_000)
      await h.exchange.placeOrder({
        symbol: 'BTC',
        side: 'short',
        type: 'limit',
        qty: 0.001,
        price: 70_000,
        clientOrderId: 'stale-reduce',
        reduceOnly: true,
      })
      const before = await h.exchange.getOpenOrders('BTC')
      expect(before.some((o) => o.clientOrderId === 'stale-reduce' && o.reduceOnly === true)).toBe(true)

      driveToEntry(h) // fires the BTC entry → onEntry sweeps the stale reduce-only order
      await flush()

      // The leftover was cancelled; the fresh entry still reached MONITORING.
      expect(
        events.some((e) => e.type === 'OrderUpdate' && e.status === 'CANCELLED' && e.clientOrderId === 'stale-reduce'),
      ).toBe(true)
      expect(await h.exchange.getOpenOrders('BTC')).toEqual([])
      expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')
    } finally {
      tmp.dispose()
    }
  })
})
