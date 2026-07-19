/**
 * Scenario: **WS disconnect mid-order / WS silence** (`13` §6). A private-stream
 * disconnect window swallows the account-lane events (`OrderUpdate`, `PositionUpdate`)
 * for a fill that still happens at the venue — the client goes silent mid-order while
 * position state advances underneath. A public-stream disconnect swallows market-data
 * ticks (WS silence) without touching the private lane.
 *
 * Determinism: the disconnect window keys off `clock.now()` only.
 */

import { describe, expect, it } from 'vitest'
import { simHarness } from './sim-harness.js'

describe('scenario: ws disconnect mid-order (private lane)', () => {
  it('drops the OrderUpdate/PositionUpdate for a fill inside the window, yet the position still moves', async () => {
    const { clock, sim, events } = simHarness(0)
    sim.setPrice('BTC', 60_000) // delivered — before the window

    sim.disconnectPrivate(1_000, 2_000)
    clock.advanceTo(1_500) // inside the private-disconnect window
    await sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: 'o' })

    // Private-lane fill events were dropped by the disconnect...
    expect(events.some((e) => e.type === 'OrderUpdate')).toBe(false)
    expect(events.some((e) => e.type === 'PositionUpdate')).toBe(false)
    // ...but the venue-side position advanced regardless (REST ground truth still shows it).
    expect(await sim.getPositions()).toEqual([{ symbol: 'BTC', side: 'long', qty: 0.001, entryPrice: 60_000 }])
  })

  it('reconnecting (past the window) delivers events again', async () => {
    const { clock, sim, events } = simHarness(0)
    sim.disconnectPrivate(1_000, 2_000)
    sim.setPrice('BTC', 60_000)

    clock.advanceTo(3_000) // past the window
    await sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: 'o' })

    expect(events.some((e) => e.type === 'OrderUpdate' && e.status === 'FILLED')).toBe(true)
  })
})

describe('scenario: ws silence (public lane)', () => {
  it('drops MarketTick emitted inside a public-disconnect window', async () => {
    const { clock, sim, events } = simHarness(0)
    sim.disconnectPublic(1_000, 2_000)

    clock.advanceTo(1_500)
    sim.setPrice('BTC', 60_000) // MarketTick is public-lane → dropped

    expect(events.some((e) => e.type === 'MarketTick')).toBe(false)
  })
})
