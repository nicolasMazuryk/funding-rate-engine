/**
 * Scenario: **limit never fills** (`13` §6 — order FSM expiry → `limit_expired`). A
 * resting limit whose price never crosses sits `OPEN` until its `expireAt` timer fires,
 * at which point the sim marks it `EXPIRED` with no position ever opened. This is the
 * venue mechanic; the strategy `limit_expired`/`ladder_no_fills` terminal mapping is
 * added by the owning strategy tasks.
 */

import { describe, expect, it } from 'vitest'
import type { OrderUpdate } from '../../src/core/events/types.js'
import { simHarness } from './sim-harness.js'

describe('scenario: limit never fills', () => {
  it('expires an un-crossed resting limit at expireAt (OPEN → EXPIRED, no position)', async () => {
    const { clock, sim, events } = simHarness(0)

    // Buy limit @ 60_000 fills only when price ≤ 60_000; keep the mark above it forever.
    await sim.placeOrder({
      symbol: 'BTC',
      side: 'long',
      type: 'limit',
      qty: 0.001,
      price: 60_000,
      clientOrderId: 'lim',
      expireAt: 5_000,
    })
    sim.setPrice('BTC', 70_000) // moves, but never crosses the limit

    expect(events.some((e) => e.type === 'OrderUpdate' && e.status === 'FILLED')).toBe(false)

    clock.advanceTo(5_000) // expiry timer fires

    const updates = events.filter((e): e is OrderUpdate => e.type === 'OrderUpdate' && e.clientOrderId === 'lim')
    expect(updates.map((u) => u.status)).toEqual(['OPEN', 'EXPIRED'])
    expect(await sim.getPositions()).toEqual([])
  })
})
