/**
 * Scenario: **out-of-order OrderUpdate** (`13` §6 — account events arrive reordered).
 * `reorderNextOrderUpdate(n)` holds the next `OrderUpdate` until `n` later emits have
 * passed, so it is delivered *after* a subsequent order's update — genuine reordering
 * (unlike a pure delay, which can still preserve order). Consumers must not assume
 * stream order matches causal order.
 */

import { describe, expect, it } from 'vitest'
import type { OrderUpdate } from '../../src/core/events/types.js'
import { simHarness } from './sim-harness.js'

describe('scenario: out-of-order OrderUpdate', () => {
  it('delivers the first order`s update after the second order`s update', async () => {
    const { sim, events } = simHarness()
    sim.setPrice('BTC', 60_000)

    sim.reorderNextOrderUpdate(2) // hold order a's update past order b's emits
    await sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: 'a' })
    await sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: 'b' })

    const order = events.filter((e): e is OrderUpdate => e.type === 'OrderUpdate').map((u) => u.clientOrderId)
    // Both delivered, but 'a' arrives after 'b'.
    expect(order.indexOf('a')).toBeGreaterThan(order.indexOf('b'))
    expect(order).toContain('a')
  })
})
