/**
 * Unit: teardown **through the cap wrapper** (task 0470 phase 3) — the composition the live
 * context actually builds, since the raw adapter handle is never exposed.
 *
 * The danger this pins down: the cap's ceilings are far below what a position can grow to, so
 * a cap that applied to closes would leave the harness unable to flatten what it opened. A
 * 200 USD position — 8× the per-order cap — must flatten cleanly, while a same-sized *opening*
 * order through the very same wrapper is still refused.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../../src/adapters/clock/virtual-clock.js'
import { createSimExchange } from '../../../src/adapters/sim/sim-exchange.js'
import { createEventBus } from '../../../src/core/events/bus.js'
import { resolveCaps } from '../../../src/live/caps.js'
import { withNotionalCap } from '../../../src/live/notional-cap.js'
import { createTeardown } from '../../../src/live/teardown.js'

const BTC_PRICE = 100_000
/** 8× the 25 USD per-order cap — a position the cap could never have opened in one order. */
const BIG_QTY = 0.002

async function settle<T>(promise: Promise<T>, clock: VirtualClock): Promise<T> {
  let done = false
  void promise.then(() => {
    done = true
  })
  for (let i = 0; i < 40 && !done; i++) {
    await Promise.resolve()
    clock.advanceBy(3000)
  }
  return promise
}

function harness() {
  const clock = createVirtualClock(1_700_000_000_000)
  const bus = createEventBus()
  const sim = createSimExchange(clock, bus)
  sim.setPrice('BTC', BTC_PRICE)
  const capped = withNotionalCap(sim, { caps: resolveCaps(), bus, clock })
  return { clock, bus, sim, capped }
}

describe('teardown through the notional cap (0470 phase 3)', () => {
  it('flattens a 200 USD position through the cap — reduce-only is exempt', async () => {
    const h = harness()
    h.sim.setPosition('BTC', 'long', BIG_QTY, BTC_PRICE)

    const report = await settle(
      createTeardown({
        exchange: h.capped,
        cancelSweep: () => Promise.resolve([]),
        clock: h.clock,
        bus: h.bus,
      }).run('suite-end'),
      h.clock,
    )

    expect(report.flattened).toEqual(['BTC'])
    expect(report.verifiedFlat).toBe(true)
    expect(h.capped.cap.rejections).toEqual([])
    expect(await h.sim.getPositions()).toEqual([])
  })

  it('still refuses an opening order of the same size through the same wrapper', async () => {
    const h = harness()

    const ack = await h.capped.placeOrder({
      symbol: 'BTC',
      side: 'long',
      type: 'limit',
      qty: BIG_QTY,
      price: BTC_PRICE,
      clientOrderId: 'open-1',
    })

    expect(ack.accepted).toBe(false)
    expect(h.capped.cap.rejections.map((r) => r.kind)).toEqual(['cap_order_notional'])
    expect(await h.sim.getOpenOrders()).toEqual([]) // never reached the venue
  })
})
