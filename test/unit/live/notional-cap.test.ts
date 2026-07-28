import { describe, expect, it } from 'vitest'
import { createEventBus } from '../../../src/core/events/bus.js'
import type { EngineEvent } from '../../../src/core/events/types.js'
import type { Clock } from '../../../src/core/ports/clock.js'
import type { ExchangeAdapter, Instrument, OrderAck, OrderRequest } from '../../../src/core/ports/exchange-adapter.js'
import { resolveCaps } from '../../../src/live/caps.js'
import { type CappedAdapter, withNotionalCap } from '../../../src/live/notional-cap.js'

/**
 * The live cap (task 0470). The load-bearing assertions are negative: an over-cap order
 * must be refused **and the adapter must never be called**, because "the order reached the
 * venue but we rejected the ack" is real money on a real book.
 *
 * Fixed clock, no wall-clock reads — `test/CLAUDE.md` determinism rule.
 */

const CLOCK: Clock = { now: () => 1_700_000_000_000, scheduleTimer: () => ({ cancel: () => {} }) }

function instrument(symbol: string, contractSize = 1): Instrument {
  return {
    normalized: symbol,
    venueSymbol: `${symbol}USDT`,
    contractSize,
    pricePrecision: 0.01,
    amountPrecision: 0.001,
    minNotional: 5,
    minQty: 0.001,
    fundingIntervalHours: 8,
  }
}

interface Harness {
  readonly capped: CappedAdapter
  readonly submitted: OrderRequest[]
  readonly events: EngineEvent[]
  /** Gate the stub's `placeOrder` so concurrent submits can be held in flight. */
  hold(): () => void
}

function harness(options: { contractSize?: number; knownSymbols?: readonly string[] } = {}): Harness {
  const submitted: OrderRequest[] = []
  const events: EngineEvent[] = []
  const known = options.knownSymbols ?? ['PEPE', 'BTC']
  const held: Array<() => void> = []
  let gated = false

  const adapter = {
    normalize(symbol: string): Instrument {
      if (!known.includes(symbol)) throw new Error(`unknown instrument '${symbol}'`)
      return instrument(symbol, options.contractSize ?? 1)
    },
    async placeOrder(req: OrderRequest): Promise<OrderAck> {
      submitted.push(req)
      if (gated) await new Promise<void>((resolve) => held.push(resolve))
      return { clientOrderId: req.clientOrderId, accepted: true }
    },
  } as unknown as ExchangeAdapter

  const bus = createEventBus()
  bus.subscribe((e) => events.push(e))

  return {
    capped: withNotionalCap(adapter, { caps: resolveCaps(), bus, clock: CLOCK }),
    submitted,
    events,
    hold() {
      gated = true
      return () => {
        gated = false
        for (const resolve of held.splice(0)) resolve()
      }
    },
  }
}

function order(over: Partial<OrderRequest> = {}): OrderRequest {
  return { symbol: 'PEPE', side: 'long', type: 'limit', qty: 1, price: 10, clientOrderId: 'c-1', ...over }
}

/** The `failSubmit` dialect: a REJECTED `OrderUpdate` carrying `errorKind: 'OrderRejected'`. */
function rejections(events: readonly EngineEvent[]): EngineEvent[] {
  return events.filter((e) => e.type === 'OrderUpdate' && e.status === 'REJECTED')
}

describe('withNotionalCap: per-order cap', () => {
  it('refuses an over-cap order without touching the adapter', async () => {
    const h = harness()
    const ack = await h.capped.placeOrder(order({ qty: 3, price: 10 })) // 30 USD > 25

    expect(ack).toEqual({ clientOrderId: 'c-1', accepted: false })
    expect(h.submitted).toEqual([])
    expect(rejections(h.events)).toHaveLength(1)
    expect(rejections(h.events)[0]).toMatchObject({ errorKind: 'OrderRejected' })
    expect(h.capped.cap.rejections[0]).toMatchObject({ kind: 'cap_order_notional', notionalUsd: 30 })
    expect(h.capped.cap.exposureUsd()).toBe(0)
  })

  it('passes an order exactly at the cap', async () => {
    const h = harness()
    const ack = await h.capped.placeOrder(order({ qty: 2.5, price: 10 })) // exactly 25 USD

    expect(ack.accepted).toBe(true)
    expect(h.submitted).toHaveLength(1)
    expect(h.capped.cap.exposureUsd()).toBe(25)
  })

  it('applies the conservative contractSize reading', async () => {
    // 1 * 10 = 10 USD on the plain reading, 100 USD with the multiplier — must reject.
    const h = harness({ contractSize: 10 })
    const ack = await h.capped.placeOrder(order({ qty: 1, price: 10 }))

    expect(ack.accepted).toBe(false)
    expect(h.submitted).toEqual([])
    expect(h.capped.cap.rejections[0]).toMatchObject({ kind: 'cap_order_notional', notionalUsd: 100 })
  })
})

describe('withNotionalCap: running exposure', () => {
  it('accumulates across orders and refuses the one that breaches the total', async () => {
    const h = harness()
    for (const i of [1, 2]) {
      expect((await h.capped.placeOrder(order({ clientOrderId: `c-${i}`, qty: 2, price: 10 }))).accepted).toBe(true)
    }
    expect(h.capped.cap.exposureUsd()).toBe(40)

    // 40 + 20 = 60 > 50, even though 20 is under the per-order cap.
    const ack = await h.capped.placeOrder(order({ clientOrderId: 'c-3', qty: 2, price: 10 }))
    expect(ack.accepted).toBe(false)
    expect(h.submitted).toHaveLength(2)
    expect(h.capped.cap.rejections[0]).toMatchObject({ kind: 'cap_total_notional' })
  })

  it('reserves synchronously, so concurrent submits cannot both see the pre-reservation exposure', async () => {
    const h = harness()
    const release = h.hold()

    // Fire five 20-USD orders in one turn without awaiting: only the first two fit under 50.
    const acks = Promise.all(
      [1, 2, 3, 4, 5].map((i) => h.capped.placeOrder(order({ clientOrderId: `c-${i}`, qty: 2, price: 10 }))),
    )
    expect(h.submitted).toHaveLength(2)
    release()

    expect((await acks).filter((a) => a.accepted)).toHaveLength(2)
    expect(h.capped.cap.exposureUsd()).toBe(40)
  })

  it('tracks exposure per symbol', async () => {
    const h = harness()
    await h.capped.placeOrder(order({ clientOrderId: 'c-1', symbol: 'PEPE', qty: 2, price: 10 }))
    await h.capped.placeOrder(order({ clientOrderId: 'c-2', symbol: 'BTC', qty: 1, price: 10 }))

    expect(h.capped.cap.exposureBySymbol()).toEqual(
      new Map([
        ['PEPE', 20],
        ['BTC', 10],
      ]),
    )
  })
})

describe('withNotionalCap: reduce-only', () => {
  it('exempts a 200 USD flatten close and releases the symbol exposure', async () => {
    const h = harness()
    await h.capped.placeOrder(order({ clientOrderId: 'c-1', qty: 2, price: 10 }))
    expect(h.capped.cap.exposureUsd()).toBe(20)

    // What `risk/flatten.ts` places: unpriced market, reduce-only, far over every cap.
    const close: OrderRequest = {
      symbol: 'PEPE',
      side: 'short',
      type: 'market',
      qty: 20,
      clientOrderId: 'flatten-1',
      reduceOnly: true,
    }
    expect((await h.capped.placeOrder(close)).accepted).toBe(true)
    expect(h.submitted.at(-1)).toEqual(close)
    expect(h.capped.cap.exposureUsd()).toBe(0)
    expect(h.capped.cap.rejections).toEqual([])
  })

  it('exempts a close on a symbol the adapter cannot even normalize', async () => {
    const h = harness({ knownSymbols: [] })
    const ack = await h.capped.placeOrder(order({ type: 'market', price: undefined, reduceOnly: true }))

    expect(ack.accepted).toBe(true)
    expect(h.submitted).toHaveLength(1)
  })
})

describe('withNotionalCap: unpriceable orders', () => {
  it('refuses an unpriced non-reduce-only order', async () => {
    const h = harness()
    const ack = await h.capped.placeOrder(order({ type: 'market', price: undefined }))

    expect(ack.accepted).toBe(false)
    expect(h.submitted).toEqual([])
    expect(h.capped.cap.rejections[0]).toMatchObject({
      kind: 'cap_unpriced_order',
      notionalUsd: Number.POSITIVE_INFINITY,
    })
  })

  it('refuses an order on an unknown instrument instead of propagating the throw', async () => {
    const h = harness({ knownSymbols: [] })
    const ack = await h.capped.placeOrder(order())

    expect(ack.accepted).toBe(false)
    expect(h.submitted).toEqual([])
    expect(h.capped.cap.rejections[0]).toMatchObject({ kind: 'cap_unknown_instrument' })
    expect(rejections(h.events)[0]).toMatchObject({ reason: expect.stringContaining("unknown instrument 'PEPE'") })
  })
})
