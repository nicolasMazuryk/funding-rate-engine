/**
 * Scenario: **reduce-only violation** (`13` §6 / `10` §2). A resting reduce-only order
 * with no position — or one on the *same* side as the open position — cannot reduce
 * anything, so the sim rejects it (`reason: 'reduce_only_violation'`). This is the
 * resting-order path only; a market reduce-only order keeps 0060's cap-to-open-qty
 * behaviour (it flattens rather than violating) and is covered in the sim unit tests.
 */

import { describe, expect, it } from 'vitest'
import type { OrderUpdate } from '../../src/core/events/types.js'
import type { OrderRequest } from '../../src/core/ports/exchange-adapter.js'
import { simHarness } from './sim-harness.js'

const reduceLimit = (over: Partial<OrderRequest>): OrderRequest => ({
  symbol: 'BTC',
  side: 'short',
  type: 'limit',
  qty: 0.001,
  price: 60_000,
  reduceOnly: true,
  clientOrderId: 'r',
  ...over,
})

describe('scenario: reduce-only violation', () => {
  it('rejects a reduce-only resting order when flat', async () => {
    const { sim, events } = simHarness()
    const ack = await sim.placeOrder(reduceLimit({}))
    expect(ack.accepted).toBe(false)
    const update = events.find((e): e is OrderUpdate => e.type === 'OrderUpdate')
    expect(update?.status).toBe('REJECTED')
    expect(update?.reason).toBe('reduce_only_violation')
    expect(update?.errorKind).toBe('OrderRejected')
  })

  it('rejects a reduce-only resting order on the same side as the open position', async () => {
    const { sim, events } = simHarness()
    sim.setPrice('BTC', 60_000)
    await sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: 'entry' })

    // Long position open; a reduce-only LONG order cannot reduce it — violation.
    const ack = await sim.placeOrder(reduceLimit({ side: 'long', clientOrderId: 'r2' }))
    expect(ack.accepted).toBe(false)
    const update = events.find((e): e is OrderUpdate => e.type === 'OrderUpdate' && e.clientOrderId === 'r2')
    expect(update?.reason).toBe('reduce_only_violation')
  })

  it('accepts a reduce-only resting order that opposes the open position', async () => {
    const { sim, events } = simHarness()
    sim.setPrice('BTC', 60_000)
    await sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: 'entry' })

    const ack = await sim.placeOrder(reduceLimit({ clientOrderId: 'r3' })) // short reduce vs long position
    expect(ack.accepted).toBe(true)
    const update = events.find((e): e is OrderUpdate => e.type === 'OrderUpdate' && e.clientOrderId === 'r3')
    expect(update?.status).toBe('OPEN')
  })
})
