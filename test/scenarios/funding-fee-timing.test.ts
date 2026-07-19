/**
 * Scenario: **late / absent funding fee** (`13` §6 — "WS funding event miss"). The
 * private `funding_fee` event can arrive late (delivered `N` ms later on the virtual
 * clock) or never (dropped entirely). Both key off the fault emitter, not randomness.
 *
 * TODO(task ownership): the strategy-specific funding-timing catalog rows land with
 * their owning tasks, not here:
 *   - `funding_fee_timeout` (S1-WS / S2) — the PRE_FUNDING-adjacent timeout path — is
 *     owned by task 0320 (S3a) and the S1-WS strategy task; add its scenario there.
 *   - `funding_event_timeout` / `pre_funding_not_filled` (S6) — owned by task 0350 (S6).
 * This file covers only the venue-mechanic (late/absent emission); the strategy
 * timeout→abort reactions are added when those strategies exist.
 */

import { describe, expect, it } from 'vitest'
import { simHarness } from './sim-harness.js'

/** Open a 1-BTC long at 60k so funding has a position to accrue against. */
async function openLong(h: ReturnType<typeof simHarness>): Promise<void> {
  h.sim.setPrice('BTC', 60_000)
  await h.sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: 'entry' })
}

describe('scenario: late funding fee', () => {
  it('delays FundingFeeAccrued by N ms on the virtual clock', async () => {
    const h = simHarness(0)
    await openLong(h)

    h.sim.delayFundingFee(5_000)
    h.sim.settleFunding('BTC', -0.4, 1_000)

    // FundingSettled arrives at settle time; the funding fee does not yet.
    expect(h.events.some((e) => e.type === 'FundingSettled')).toBe(true)
    expect(h.events.some((e) => e.type === 'FundingFeeAccrued')).toBe(false)

    h.clock.advanceTo(6_000) // 1_000 + 5_000 delay
    expect(h.events.some((e) => e.type === 'FundingFeeAccrued')).toBe(true)
  })
})

describe('scenario: absent funding fee', () => {
  it('never emits FundingFeeAccrued when dropped', async () => {
    const h = simHarness(0)
    await openLong(h)

    h.sim.dropFundingFee()
    h.sim.settleFunding('BTC', -0.4, 1_000)
    h.clock.advanceTo(1_000_000) // no timer can resurrect a dropped event

    expect(h.events.some((e) => e.type === 'FundingSettled')).toBe(true)
    expect(h.events.some((e) => e.type === 'FundingFeeAccrued')).toBe(false)
  })
})
