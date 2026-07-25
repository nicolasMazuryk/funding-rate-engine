/**
 * Unit: Bybit order transport (`ws-orders.ts`). Offline against fake WS-API / REST clients.
 * Focus on the venue-quirk mappings the manager depends on: a WS-API rejection arrives as the
 * **raw reply object** carrying `retCode` (not an `Error`), which must classify as
 * `OrderRejected`/`InsufficientBalance` rather than a retryable `NetworkError`; a WS ack that
 * never resolves must surface `WsTimeout` via the injected clock; submit records
 * `clientOrderId → venueSymbol` before the ack; and the payload carries `category: 'linear'`,
 * `orderLinkId`, `positionIdx: 0`, with `'stop'` becoming a conditional market order.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { mapBybitError } from '../../../../../src/adapters/exchanges/bybit/error-map.js'
import {
  type BybitOrderTransportDeps,
  type BybitRestOrderClient,
  type BybitWsOrderClient,
  createBybitOrderTransport,
} from '../../../../../src/adapters/exchanges/bybit/ws-orders.js'
import { NotFoundError } from '../../../../../src/adapters/shared/errors.js'
import type { Order, OrderRequest } from '../../../../../src/core/ports/exchange-adapter.js'

const req: OrderRequest = {
  symbol: 'BTC',
  side: 'long',
  type: 'limit',
  qty: 0.003,
  price: 20_000,
  clientOrderId: 'BTC-1-entry-1',
}

const wsOk = { retCode: 0, data: { orderId: 'ff-1', orderLinkId: req.clientOrderId } }
const restOk = { retCode: 0, result: { orderId: 'ff-2', orderLinkId: req.clientOrderId } }

/** Build the transport over supplied fake clients + a map-on-throw `callOrder` (mirrors the adapter). */
function build(over: Partial<BybitOrderTransportDeps> = {}) {
  const clock = createVirtualClock(0)
  const venueMap = new Map<string, string>()
  const submitted: unknown[] = []
  const cancelled: unknown[] = []
  const wsApi: BybitWsOrderClient = {
    submitNewOrder: (params) => {
      submitted.push(params)
      return Promise.resolve(wsOk)
    },
    cancelOrder: (params) => {
      cancelled.push(params)
      return Promise.resolve(wsOk)
    },
  }
  const rest: BybitRestOrderClient = {
    submitOrder: (params) => {
      submitted.push(params)
      return Promise.resolve(restOk)
    },
  }
  const transport = createBybitOrderTransport({
    wsApi,
    rest,
    clock,
    resolveVenue: () => 'BTCUSDT',
    recordVenue: (cid, venue) => venueMap.set(cid, venue),
    venueForClientId: (cid) => venueMap.get(cid) ?? 'BTCUSDT',
    getOrder: (cid): Promise<Order> =>
      Promise.resolve({ clientOrderId: cid, symbol: 'BTC', side: 'long', type: 'limit', status: 'OPEN' }),
    // The adapter's callOrder maps any throw through mapBybitError.
    callOrder: async (_weight, fn) => {
      try {
        return await fn()
      } catch (err) {
        throw mapBybitError(err)
      }
    },
    ...over,
  })
  return { transport, clock, venueMap, submitted, cancelled }
}

describe('bybit order transport', () => {
  it('records clientOrderId → venueSymbol before the ack (adoption/getOrder need it)', async () => {
    const { transport, venueMap } = build()
    await transport.submit(req)
    expect(venueMap.get('BTC-1-entry-1')).toBe('BTCUSDT')
  })

  it('builds a linear one-way limit payload keyed on orderLinkId', async () => {
    const { transport, submitted } = build()
    const ack = await transport.submit(req)
    expect(submitted[0]).toEqual({
      category: 'linear',
      symbol: 'BTCUSDT',
      side: 'Buy',
      orderType: 'Limit',
      qty: '0.003',
      price: '20000',
      timeInForce: 'GTC',
      orderLinkId: 'BTC-1-entry-1',
      positionIdx: 0,
    })
    expect(ack).toEqual({ clientOrderId: 'BTC-1-entry-1', accepted: true, venueOrderId: 'ff-1' })
  })

  it('a reduce-only market close carries reduceOnly and no price', async () => {
    const { transport, submitted } = build()
    await transport.submit({ ...req, type: 'market', price: undefined, reduceOnly: true })
    expect(submitted[0]).toMatchObject({ orderType: 'Market', reduceOnly: true })
    expect(submitted[0]).not.toHaveProperty('price')
  })

  it("maps 'stop' to a conditional market order (triggerPrice + direction, no native stop type)", async () => {
    const { transport, submitted } = build()
    await transport.submit({ ...req, type: 'stop', price: 19_000 })
    expect(submitted[0]).toMatchObject({ orderType: 'Market', triggerPrice: '19000', triggerDirection: 1 })
    await transport.submit({ ...req, side: 'short', type: 'stop', price: 21_000 })
    expect(submitted[1]).toMatchObject({ side: 'Sell', triggerDirection: 2 })
  })

  it('classifies a raw WS-API reject (retCode 110007) as InsufficientBalance, not NetworkError', async () => {
    const { transport } = build({
      wsApi: {
        submitNewOrder: () => Promise.reject({ wsKey: 'v5PrivateTrade', retCode: 110007, retMsg: 'ab not enough' }),
        cancelOrder: () => Promise.resolve(wsOk),
      },
    })
    await expect(transport.submit(req)).rejects.toMatchObject({ kind: 'InsufficientBalance', rawCode: 110007 })
  })

  it('classifies a raw WS-API reject (retCode 110017) as OrderRejected', async () => {
    const { transport } = build({
      wsApi: {
        submitNewOrder: () => Promise.reject({ retCode: 110017, retMsg: 'reduce-only rule not satisfied' }),
        cancelOrder: () => Promise.resolve(wsOk),
      },
    })
    await expect(transport.submit(req)).rejects.toMatchObject({
      kind: 'OrderRejected',
      reason: 'reduce-only rule not satisfied',
    })
  })

  it('imposes a WsTimeout when the WS ack never resolves', async () => {
    const { transport, clock } = build({
      wsApi: {
        submitNewOrder: () => new Promise<never>(() => {}), // never settles
        cancelOrder: () => Promise.resolve(wsOk),
      },
      wsAckTimeoutMs: 1_000,
    })
    const pending = transport.submit(req)
    clock.advanceBy(1_000)
    await expect(pending).rejects.toMatchObject({ kind: 'WsTimeout' })
  })

  it('REST fallback submits the same clientOrderId (idempotent) and acks the venue order id', async () => {
    const { transport, submitted } = build()
    const ack = await transport.submitRest(req)
    expect(submitted[0]).toMatchObject({ orderLinkId: 'BTC-1-entry-1', category: 'linear' })
    expect(ack).toEqual({ clientOrderId: 'BTC-1-entry-1', accepted: true, venueOrderId: 'ff-2' })
  })

  it('cancel resolves the symbol from the submit-time map and cancels by orderLinkId', async () => {
    const { transport, cancelled } = build()
    await transport.submit(req)
    await transport.cancel(req.clientOrderId)
    expect(cancelled[0]).toEqual({ category: 'linear', symbol: 'BTCUSDT', orderLinkId: 'BTC-1-entry-1' })
  })

  it('cancel of an unseen clientOrderId rejects NotFound (the manager reconciles via getOrder)', async () => {
    const { transport } = build({
      venueForClientId: () => {
        throw new NotFoundError('no known symbol')
      },
    })
    await expect(transport.cancel('nope')).rejects.toMatchObject({ kind: 'NotFound' })
  })
})
