/**
 * Unit: venue-agnostic order manager (`11` §3/§5/§6, `00_globals` §6). Driven against a
 * scriptable fake {@link OrderTransport} + the real event bus + virtual clock, so every
 * path is offline and deterministic. Covers: precision pre-check, stagger spacing,
 * WS-timeout → REST fallback (adopt-or-resubmit, no duplicate), WS-timeout → bounded
 * retry → leg abort, the fill-poll safety net, duplicate-OrderUpdate idempotency, and
 * cancel-of-a-filled order resolving to truth.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../../src/adapters/clock/virtual-clock.js'
import {
  createConsecutiveFailureCounter,
  NetworkError,
  NotFoundError,
  OrderRejectedError,
  WsTimeoutError,
} from '../../../src/adapters/shared/errors.js'
import { createEventBus } from '../../../src/core/events/bus.js'
import type { EngineEvent, OrderUpdate } from '../../../src/core/events/types.js'
import type { Instrument, Order, OrderAck, OrderRequest } from '../../../src/core/ports/exchange-adapter.js'
import { createOrderManager, type OrderManager, type OrderTransport } from '../../../src/execution/order-manager.js'

const BTC: Instrument = {
  normalized: 'BTC',
  venueSymbol: 'BTCUSDT',
  contractSize: 1,
  pricePrecision: 0.1,
  amountPrecision: 0.001,
  minNotional: 5,
  minQty: 0.001,
  fundingIntervalHours: 8,
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/** A market order request for BTC; overridable per test. */
function req(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return { symbol: 'BTC', side: 'long', type: 'market', qty: 0.01, clientOrderId: 'BTC-1-entry-1', ...overrides }
}

interface Harness {
  readonly manager: OrderManager
  readonly clock: VirtualClock
  readonly events: readonly EngineEvent[]
  readonly orderUpdates: () => OrderUpdate[]
}

/** Wire the manager against a supplied transport; collect every published event. */
function harness(transport: OrderTransport, opts: { staggerMs?: number; wsOrderRestFallback?: boolean } = {}): Harness {
  const clock = createVirtualClock(0)
  const bus = createEventBus()
  const events: EngineEvent[] = []
  bus.subscribe((e) => events.push(e))
  const manager = createOrderManager({
    transport,
    clock,
    bus,
    resolveInstrument: () => BTC,
    staggerMs: opts.staggerMs ?? 0,
    wsOrderRestFallback: opts.wsOrderRestFallback ?? false,
    failures: createConsecutiveFailureCounter(),
  })
  return {
    manager,
    clock,
    events,
    orderUpdates: () => events.filter((e): e is OrderUpdate => e.type === 'OrderUpdate'),
  }
}

/** A filled ground-truth order for the fill-poll / adoption reads. */
function filledOrder(clientOrderId: string): Order {
  return { clientOrderId, symbol: 'BTC', side: 'long', type: 'market', status: 'FILLED', fillPx: 60_000, qty: 0.01 }
}

const ack = (clientOrderId: string): OrderAck => ({ clientOrderId, accepted: true, venueOrderId: `v-${clientOrderId}` })
const notImpl = (): never => {
  throw new Error('unexpected transport call')
}

describe('order manager — precision (`11` §3, before submit)', () => {
  it('rejects a sub-min-notional priced order without ever calling the transport', async () => {
    let submits = 0
    const transport: OrderTransport = {
      submit: () => {
        submits++
        return Promise.resolve(ack('x'))
      },
      submitRest: notImpl,
      getOrder: notImpl,
      cancel: notImpl,
    }
    const h = harness(transport)
    // 0.001 @ 1 = 0.001 notional < minNotional 5 → infeasible.
    const result = await h.manager.placeOrder(req({ type: 'limit', price: 1, qty: 0.001 }))
    expect(result.accepted).toBe(false)
    expect(submits).toBe(0)
    const rejected = h.orderUpdates().find((u) => u.status === 'REJECTED')
    expect(rejected?.reason).toBe('min_notional')
  })

  it('rounds a limit price to the venue tick before submit', async () => {
    let submitted: OrderRequest | undefined
    const transport: OrderTransport = {
      submit: (r) => {
        submitted = r
        return Promise.resolve(ack(r.clientOrderId))
      },
      submitRest: notImpl,
      getOrder: notImpl,
      cancel: notImpl,
    }
    const h = harness(transport)
    await h.manager.placeOrder(req({ type: 'limit', price: 60_000.07, qty: 0.01 }))
    expect(submitted?.price).toBeCloseTo(60_000.1, 6) // rounded to tick 0.1 (binary-float safe)
  })
})

describe('order manager — happy path + FSM', () => {
  it('publishes SUBMITTING then OPEN on an accepted submit', async () => {
    const transport: OrderTransport = {
      submit: (r) => Promise.resolve(ack(r.clientOrderId)),
      submitRest: notImpl,
      getOrder: () => Promise.resolve(filledOrder('BTC-1-entry-1')),
      cancel: notImpl,
    }
    const h = harness(transport)
    const result = await h.manager.placeOrder(req())
    expect(result.accepted).toBe(true)
    expect(h.orderUpdates().map((u) => u.status)).toEqual(['SUBMITTING', 'OPEN'])
  })
})

describe('order manager — stagger (`00_globals` §6)', () => {
  it('serializes a 3-order batch ≥100 ms apart on the virtual clock', async () => {
    const submitTimes: number[] = []
    let now = () => 0
    const transport: OrderTransport = {
      submit: (r) => {
        submitTimes.push(now())
        return Promise.resolve(ack(r.clientOrderId))
      },
      submitRest: notImpl,
      getOrder: () => Promise.reject(new NotFoundError()),
      cancel: notImpl,
    }
    const h = harness(transport, { staggerMs: 100 })
    now = () => h.clock.now()

    const ps = [
      h.manager.placeOrder(req({ clientOrderId: 'BTC-1-entry-1' })),
      h.manager.placeOrder(req({ clientOrderId: 'BTC-2-entry-1' })),
      h.manager.placeOrder(req({ clientOrderId: 'BTC-3-entry-1' })),
    ]
    await flush()
    h.clock.advanceBy(100)
    await flush()
    h.clock.advanceBy(100)
    await flush()
    await Promise.all(ps)

    expect(submitTimes).toEqual([0, 100, 200])
  })
})

describe('order manager — WS-timeout REST fallback (`11` §5)', () => {
  it('with the fallback flag: falls back to REST once with the same clientOrderId (no duplicate)', async () => {
    let submits = 0
    let restSubmits = 0
    let restReq: OrderRequest | undefined
    const transport: OrderTransport = {
      submit: () => {
        submits++
        return Promise.reject(new WsTimeoutError())
      },
      submitRest: (r) => {
        restSubmits++
        restReq = r
        return Promise.resolve(ack(r.clientOrderId))
      },
      getOrder: () => Promise.reject(new NotFoundError()), // adopt: venue never saw it → resubmit via REST
      cancel: notImpl,
    }
    const h = harness(transport, { wsOrderRestFallback: true })
    const result = await h.manager.placeOrder(req())

    expect(submits).toBe(1)
    expect(restSubmits).toBe(1)
    expect(restReq?.clientOrderId).toBe('BTC-1-entry-1')
    expect(result.accepted).toBe(true)
    expect(h.orderUpdates().some((u) => u.status === 'OPEN')).toBe(true)
  })

  it('with the fallback flag: adopts an already-accepted order instead of resubmitting', async () => {
    let restSubmits = 0
    const transport: OrderTransport = {
      submit: () => Promise.reject(new WsTimeoutError()),
      submitRest: () => {
        restSubmits++
        return Promise.resolve(ack('x'))
      },
      getOrder: (id) => Promise.resolve({ ...filledOrder(id), status: 'OPEN' }), // venue already accepted it
      cancel: notImpl,
    }
    const h = harness(transport, { wsOrderRestFallback: true })
    const result = await h.manager.placeOrder(req())

    expect(restSubmits).toBe(0) // adopted, not resubmitted
    expect(result.accepted).toBe(true)
  })

  it('forces REST fallback for a reduce-only leg even with the fallback flag OFF (`02` §3, task 0300)', async () => {
    // Protecting an open position outranks the fallback-flag gate: a WS-transport failure
    // on a reduce-only exit falls back to REST even when wsOrderRestFallback is false.
    let submits = 0
    let restSubmits = 0
    const transport: OrderTransport = {
      submit: () => {
        submits++
        return Promise.reject(new WsTimeoutError())
      },
      submitRest: (r) => {
        restSubmits++
        return Promise.resolve(ack(r.clientOrderId))
      },
      getOrder: () => Promise.reject(new NotFoundError()), // venue never saw it → resubmit via REST
      cancel: notImpl,
    }
    const h = harness(transport, { wsOrderRestFallback: false })
    const result = await h.manager.placeOrder(req({ clientOrderId: 'BTC-1-exit-1', reduceOnly: true }))

    expect(submits).toBe(1) // no bounded WS retry — went straight to REST
    expect(restSubmits).toBe(1)
    expect(result.accepted).toBe(true)
    expect(h.orderUpdates().some((u) => u.status === 'OPEN')).toBe(true)
  })

  it('a NON-reduce-only leg with the flag OFF still uses bounded WS retry, not REST (task 0300)', async () => {
    // The reduce-only override must not leak to entry legs — they keep the bounded-retry policy.
    let submits = 0
    let restSubmits = 0
    const transport: OrderTransport = {
      submit: () => {
        submits++
        return Promise.reject(new WsTimeoutError())
      },
      submitRest: () => {
        restSubmits++
        return Promise.resolve(ack('x'))
      },
      getOrder: notImpl,
      cancel: notImpl,
    }
    const h = harness(transport, { wsOrderRestFallback: false })
    const result = await h.manager.placeOrder(req({ reduceOnly: false }))

    expect(submits).toBe(3) // initial + MAX_WS_RETRIES(2)
    expect(restSubmits).toBe(0)
    expect(result.accepted).toBe(false)
  })
})

describe('order manager — WS-timeout without fallback (bounded retry → abort)', () => {
  it('retries the WS submit a bounded number of times then aborts the leg as FAILED', async () => {
    let submits = 0
    const transport: OrderTransport = {
      submit: () => {
        submits++
        return Promise.reject(new WsTimeoutError())
      },
      submitRest: notImpl,
      getOrder: notImpl,
      cancel: notImpl,
    }
    const h = harness(transport, { wsOrderRestFallback: false })
    const result = await h.manager.placeOrder(req())

    expect(submits).toBe(3) // initial + MAX_WS_RETRIES(2)
    expect(result.accepted).toBe(false)
    const last = h.orderUpdates().at(-1)
    expect(last?.status).toBe('FAILED')
    expect(last?.errorKind).toBe('WsTimeout')
  })

  it('a venue reject (not a transport failure) does not retry — it maps to REJECTED', async () => {
    let submits = 0
    const transport: OrderTransport = {
      submit: () => {
        submits++
        return Promise.reject(new OrderRejectedError('min notional', { reason: 'min_notional' }))
      },
      submitRest: notImpl,
      getOrder: notImpl,
      cancel: notImpl,
    }
    const h = harness(transport)
    const result = await h.manager.placeOrder(req())

    expect(submits).toBe(1) // no retry on a venue verdict
    expect(result.accepted).toBe(false)
    expect(h.orderUpdates().at(-1)?.status).toBe('REJECTED')
  })
})

describe('order manager — fill-poll safety net (`00_globals` §6)', () => {
  it('recovers a fill by polling getOrder when the WS stream is silent', async () => {
    let polls = 0
    const transport: OrderTransport = {
      submit: (r) => Promise.resolve(ack(r.clientOrderId)),
      submitRest: notImpl,
      getOrder: (id) => {
        polls++
        return Promise.resolve(filledOrder(id))
      },
      cancel: notImpl,
    }
    const h = harness(transport)
    await h.manager.placeOrder(req())
    expect(h.orderUpdates().some((u) => u.status === 'FILLED')).toBe(false) // not filled yet

    h.clock.advanceBy(700) // past the ~667 ms cadence → first poll fires
    await flush()

    expect(polls).toBe(1)
    const filled = h.orderUpdates().find((u) => u.status === 'FILLED')
    expect(filled?.qty).toBe(0.01)
  })

  it('stops polling and records a breaker failure when getOrder errors', async () => {
    const failures = createConsecutiveFailureCounter()
    let polls = 0
    const transport: OrderTransport = {
      submit: (r) => Promise.resolve(ack(r.clientOrderId)),
      submitRest: notImpl,
      getOrder: () => {
        polls++
        return Promise.reject(new NetworkError())
      },
      cancel: notImpl,
    }
    const clock = createVirtualClock(0)
    const bus = createEventBus()
    const manager = createOrderManager({
      transport,
      clock,
      bus,
      resolveInstrument: () => BTC,
      staggerMs: 0,
      wsOrderRestFallback: false,
      failures,
    })
    await manager.placeOrder(req())
    clock.advanceBy(700)
    await flush()
    clock.advanceBy(2_000) // no further polls scheduled — circuit-open
    await flush()

    expect(polls).toBe(1)
    expect(failures.count()).toBe(1)
  })
})

describe('order manager — duplicate OrderUpdate idempotency (`13` §6)', () => {
  it('absorbs a duplicated venue update without a double transition', async () => {
    const bus = createEventBus()
    const clock = createVirtualClock(0)
    const events: OrderUpdate[] = []
    bus.subscribe((e) => {
      if (e.type === 'OrderUpdate') events.push(e)
    })
    const transport: OrderTransport = {
      submit: (r) => Promise.resolve(ack(r.clientOrderId)),
      submitRest: notImpl,
      getOrder: () => Promise.reject(new NotFoundError()), // fill-poll never fires (clock not advanced)
      cancel: notImpl,
    }
    const manager = createOrderManager({
      transport,
      clock,
      bus,
      resolveInstrument: () => BTC,
      staggerMs: 0,
      wsOrderRestFallback: false,
    })
    await manager.placeOrder(req()) // manager now tracks the order at OPEN

    const cid = 'BTC-1-entry-1'
    // A venue FILLED, then a duplicate FILLED (venue re-send). The first advances the
    // FSM + drops the order; the duplicate hits an IllegalTransition that is caught.
    expect(() => {
      bus.publish({ type: 'OrderUpdate', clientOrderId: cid, status: 'FILLED', fillPx: 60_000, qty: 0.01 })
      bus.publish({ type: 'OrderUpdate', clientOrderId: cid, status: 'FILLED', fillPx: 60_000, qty: 0.01 })
    }).not.toThrow()

    // Both FILLEDs are on the bus (the manager does not re-publish), but neither threw.
    expect(events.filter((u) => u.status === 'FILLED')).toHaveLength(2)
  })
})

describe('order manager — cancel a filled order (`11` §6)', () => {
  it('resolves NotFound-on-cancel to ground truth via getOrder, not an error', async () => {
    let getOrders = 0
    const transport: OrderTransport = {
      submit: notImpl,
      submitRest: notImpl,
      getOrder: (id) => {
        getOrders++
        return Promise.resolve(filledOrder(id))
      },
      cancel: () => Promise.reject(new NotFoundError('already filled')),
    }
    const h = harness(transport)
    await expect(h.manager.cancelOrder('BTC-1-entry-1')).resolves.toBeUndefined()
    expect(getOrders).toBe(1)
    expect(h.orderUpdates().at(-1)?.status).toBe('FILLED')
  })
})
