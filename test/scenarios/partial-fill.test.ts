/**
 * Scenario: **partial fill** (`13` §6 — resting order fills across several crossings).
 * A resting limit buy with a scripted partial queue consumes one slice per price
 * crossing: PARTIAL → PARTIAL → FILLED, each with the cumulative filled qty.
 *
 * PEPE is used so the qtys are whole numbers (`amountPrecision 1`), keeping the
 * cumulative fill assertions free of float rounding.
 */

import { describe, expect, it } from 'vitest'
import type { OrderUpdate } from '../../src/core/events/types.js'
import { simHarness } from './sim-harness.js'

describe('scenario: partial fill', () => {
  it('fills a resting limit across three crossings (PARTIAL, PARTIAL, FILLED)', async () => {
    const { sim, events } = simHarness()

    // PEPE limit buy, qty 3 @ 0.01 (notional 3*0.01*1000 = 30 ≥ minNotional 5).
    await sim.placeOrder({ symbol: 'PEPE', side: 'long', type: 'limit', qty: 3, price: 0.01, clientOrderId: 'lim' })
    sim.scriptPartialFills('lim', [1, 1, 1])

    sim.setPrice('PEPE', 0.01) // crossing 1 → PARTIAL 1
    sim.setPrice('PEPE', 0.01) // crossing 2 → PARTIAL 2
    sim.setPrice('PEPE', 0.01) // crossing 3 → FILLED 3

    const updates = events.filter((e): e is OrderUpdate => e.type === 'OrderUpdate' && e.clientOrderId === 'lim')
    expect(updates.map((u) => [u.status, u.qty])).toEqual([
      ['OPEN', undefined], // OPEN carries no fill qty yet
      ['PARTIAL', 1],
      ['PARTIAL', 2],
      ['FILLED', 3],
    ])
    expect(await sim.getPositions()).toEqual([{ symbol: 'PEPE', side: 'long', qty: 3, entryPrice: 0.01 }])
  })

  it('fills the full remainder on the first crossing when no partial script is set', async () => {
    const { sim, events } = simHarness()
    await sim.placeOrder({ symbol: 'PEPE', side: 'long', type: 'limit', qty: 3, price: 0.01, clientOrderId: 'lim' })

    sim.setPrice('PEPE', 0.01)

    const updates = events.filter((e): e is OrderUpdate => e.type === 'OrderUpdate' && e.clientOrderId === 'lim')
    expect(updates.map((u) => u.status)).toEqual(['OPEN', 'FILLED'])
  })
})
