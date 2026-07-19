/**
 * Scenario: **duplicate OrderUpdate** (`13` §6 — a venue re-sends the same account
 * event). `duplicateNextOrderUpdate` publishes the next `OrderUpdate` twice; downstream
 * consumers must be idempotent (the engine keys on `clientOrderId`). Generic: the fault
 * emitter can duplicate any event type; `OrderUpdate` is the catalog's named case.
 */

import { describe, expect, it } from 'vitest'
import type { OrderUpdate } from '../../src/core/events/types.js'
import { simHarness } from './sim-harness.js'

describe('scenario: duplicate OrderUpdate', () => {
  it('publishes the next OrderUpdate twice, byte-identical', async () => {
    const { sim, events } = simHarness()
    sim.setPrice('BTC', 60_000)

    sim.duplicateNextOrderUpdate()
    await sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: 'o' })

    const fills = events.filter((e): e is OrderUpdate => e.type === 'OrderUpdate' && e.status === 'FILLED')
    expect(fills).toHaveLength(2)
    expect(fills[0]).toEqual(fills[1])
  })
})
