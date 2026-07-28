/**
 * Unit: **`createTeardown`** — the live tier's always-end-flat guarantee (task 0470 phase 3).
 *
 * Driven against the sim venue on a virtual clock (the flatten ladder's backoffs are clock
 * timers). The load-bearing assertions: the three steps are independent (a sweep that throws
 * still flattens), `verifiedFlat` comes from a REST read and never from "no error", and a
 * second/concurrent `run()` shares one report instead of racing a second flatten ladder.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../../src/adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../../../src/adapters/sim/sim-exchange.js'
import { createEventBus } from '../../../src/core/events/bus.js'
import type { EventBus } from '../../../src/core/ports/bus.js'
import type { Order, Position } from '../../../src/core/ports/exchange-adapter.js'
import { createTeardown, type TeardownDeps } from '../../../src/live/teardown.js'

const BTC_PRICE = 100_000

/** Drive an in-flight promise to resolution on the virtual clock (the ladder's backoffs). */
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

interface Harness {
  readonly clock: VirtualClock
  readonly bus: EventBus
  readonly sim: SimExchange
  /** How many times the (venue-native) cancel sweep ran. */
  sweepCalls(): number
}

function harness(): Harness {
  const clock = createVirtualClock(1_700_000_000_000)
  const bus = createEventBus()
  const sim = createSimExchange(clock, bus)
  sim.setPrice('BTC', BTC_PRICE)
  return { clock, bus, sim, sweepCalls: () => 0 }
}

/** Teardown deps over the sim, with a counting cancel sweep the test can script to throw. */
function deps(h: Harness, sweep?: () => Promise<readonly string[]>): TeardownDeps & { calls: () => number } {
  let calls = 0
  return {
    exchange: h.sim,
    cancelSweep: () => {
      calls += 1
      return sweep ? sweep() : Promise.resolve(['BTCUSDT#1'])
    },
    clock: h.clock,
    bus: h.bus,
    calls: () => calls,
  }
}

describe('createTeardown (0470 phase 3)', () => {
  it('sweeps, flattens, and REST-verifies the account flat', async () => {
    const h = harness()
    h.sim.setPosition('BTC', 'long', 0.001, BTC_PRICE)
    const d = deps(h)

    const report = await settle(createTeardown(d).run('suite-end'), h.clock)

    expect(report.reason).toBe('suite-end')
    expect(report.cancelled).toEqual(['BTCUSDT#1'])
    expect(report.flattened).toEqual(['BTC'])
    expect(report.residuals).toEqual([])
    expect(report.openPositions).toEqual([])
    expect(report.openOrders).toEqual([])
    expect(report.verifiedFlat).toBe(true)
    expect(report.errors).toEqual([])
    expect(await h.sim.getPositions()).toEqual([])
  })

  it('a resting order left by the sweep keeps verifiedFlat false', async () => {
    const h = harness()
    // Sweep is a no-op (models a venue-native cancel that missed a leftover); the order rests on.
    await h.sim.placeOrder({
      symbol: 'BTC',
      side: 'long',
      type: 'limit',
      qty: 0.001,
      price: BTC_PRICE - 1000,
      clientOrderId: 'leftover-1',
    })
    const d = deps(h, () => Promise.resolve([]))

    const report = await settle(createTeardown(d).run(), h.clock)

    expect(report.openOrders.map((o: Order) => o.clientOrderId)).toEqual(['leftover-1'])
    expect(report.verifiedFlat).toBe(false)
  })

  it('re-sweeps an order that landed between the sweep read and the verification read', async () => {
    const h = harness()
    // The 0470 §5 live race: a signal arrives while a check's `placeOrder` is already
    // travelling, so the order rests *after* the first sweep looked and *before* the first
    // verification did. Modelled here by a sweep that places the order on its first call
    // (venue-side arrival) and cancels on its second.
    const d = deps(h, async () => {
      const resting = await h.sim.getOpenOrders()
      if (resting.length === 0) {
        await h.sim.placeOrder({
          symbol: 'BTC',
          side: 'long',
          type: 'limit',
          qty: 0.001,
          price: BTC_PRICE - 1000,
          clientOrderId: 'in-flight-1',
        })
        return []
      }
      for (const o of resting) await h.sim.cancelOrder(o.clientOrderId)
      return resting.map((o) => o.clientOrderId)
    })

    const report = await settle(createTeardown(d).run('SIGINT'), h.clock)

    expect(d.calls()).toBe(2)
    expect(report.cancelled).toEqual(['in-flight-1'])
    expect(report.openOrders).toEqual([])
    expect(report.verifiedFlat).toBe(true)
  })

  it('still flattens when the cancel sweep throws, and records the failure', async () => {
    const h = harness()
    h.sim.setPosition('BTC', 'long', 0.001, BTC_PRICE)
    const d = deps(h, () => Promise.reject(new Error('cancel sweep: 1 of 1 orders could not be cancelled')))

    const report = await settle(createTeardown(d).run(), h.clock)

    expect(report.errors).toEqual(['cancel sweep: cancel sweep: 1 of 1 orders could not be cancelled'])
    expect(report.flattened).toEqual(['BTC'])
    expect(report.verifiedFlat).toBe(true)
  })

  it('reports verifiedFlat false with the residual when a position will not close', async () => {
    const h = harness()
    const stuck: Position = { symbol: 'BTC', side: 'long', qty: 0.001 }
    const d: TeardownDeps = {
      exchange: {
        getPositions: () => Promise.resolve([stuck]),
        placeOrder: (req) => Promise.resolve({ clientOrderId: req.clientOrderId, accepted: true }),
        normalize: h.sim.normalize,
        getOpenOrders: () => Promise.resolve([]),
      },
      cancelSweep: () => Promise.resolve([]),
      clock: h.clock,
      bus: h.bus,
    }

    const report = await settle(createTeardown(d).run(), h.clock)

    expect(report.residuals).toEqual([{ symbol: 'BTC', residualQty: 0.001, side: 'long' }])
    expect(report.openPositions).toEqual([stuck])
    expect(report.verifiedFlat).toBe(false)
  })

  it('cannot claim flat when the verification read itself fails', async () => {
    const h = harness()
    // Account is already flat, so each attempt reads positions twice: `flattenAll` (calls 1
    // and 3) then the verification (calls 2 and 4). Both verification reads fail, so neither
    // of the two attempts can see the account — an unreadable account is never claimed flat.
    h.sim.scriptRateLimit('getPositions', 'RateLimited', [2, 4])
    const d = deps(h)

    const report = await settle(createTeardown(d).run(), h.clock)

    expect(report.verifiedFlat).toBe(false)
    expect(report.errors.some((e) => e.startsWith('flat verification:'))).toBe(true)
  })

  it('is idempotent: a second run returns the first report without re-sweeping', async () => {
    const h = harness()
    h.sim.setPosition('BTC', 'long', 0.001, BTC_PRICE)
    const d = deps(h)
    const teardown = createTeardown(d)

    const first = await settle(teardown.run('SIGINT'), h.clock)
    const second = await settle(teardown.run('suite-end'), h.clock)

    expect(second).toBe(first)
    expect(second.reason).toBe('SIGINT') // the first caller's reason wins
    expect(d.calls()).toBe(1)
  })

  it('is re-entrant: concurrent runs share one report and one flatten ladder', async () => {
    const h = harness()
    h.sim.setPosition('BTC', 'long', 0.001, BTC_PRICE)
    const d = deps(h)
    const teardown = createTeardown(d)

    const both = settle(Promise.all([teardown.run('SIGTERM'), teardown.run('finally')]), h.clock)
    const [a, b] = await both

    expect(a).toBe(b)
    expect(d.calls()).toBe(1)
  })
})
