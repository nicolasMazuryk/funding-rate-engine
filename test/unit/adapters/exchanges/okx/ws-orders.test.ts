/**
 * Unit: OKX order transport (`ws-orders.ts`). Offline against fake WS-API / REST clients.
 * Focus on the venue-quirk mappings the manager depends on:
 *  - **a resolved reply can still be a rejection.** OKX's third reject shape is `code: '1'`
 *    with the real reason at `data[0].sCode`/`sMsg`, so the transport must inspect what it
 *    *resolved* — a fake ack here would let the FSM believe a rejected order is live.
 *  - **the client id is re-spelled** through `./client-order-id.ts`, alphanumeric-only.
 *  - `tdMode: 'isolated'` per order (`11` §1) with no `posSide` (net mode).
 *  - a WS ack that never resolves surfaces `WsTimeout` via the injected clock.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { toVenueClOrdId } from '../../../../../src/adapters/exchanges/okx/client-order-id.js'
import { mapOkxError } from '../../../../../src/adapters/exchanges/okx/error-map.js'
import {
  createOkxOrderTransport,
  type OkxOrderTransportDeps,
  type OkxRestOrderClient,
  type OkxWsOrderClient,
} from '../../../../../src/adapters/exchanges/okx/ws-orders.js'
import { NotFoundError } from '../../../../../src/adapters/shared/errors.js'
import type { Order, OrderRequest } from '../../../../../src/core/ports/exchange-adapter.js'

const req: OrderRequest = {
  symbol: 'BTC',
  side: 'long',
  type: 'limit',
  qty: 0.03,
  price: 20_000,
  clientOrderId: 'BTC-28710000-entry-1',
}

/** The engine id as OKX sees it (`-` is not in the venue's charset). */
const VENUE_CLORDID = toVenueClOrdId(req.clientOrderId)

/** A successful reply: envelope `code: '0'` and a per-order `sCode: '0'`. */
const wsOk = { code: '0', msg: '', data: [{ ordId: 'ok-1', clOrdId: VENUE_CLORDID, sCode: '0', sMsg: '' }] }
const restOk = [{ ordId: 'ok-2', clOrdId: VENUE_CLORDID, sCode: '0', sMsg: '' }]

/** Build the transport over supplied fake clients + a map-on-throw `callOrder` (mirrors the adapter). */
function build(over: Partial<OkxOrderTransportDeps> = {}) {
  const clock = createVirtualClock(0)
  const venueMap = new Map<string, string>()
  const submitted: unknown[] = []
  const cancelled: unknown[] = []
  const wsApi: OkxWsOrderClient = {
    submitNewOrder: (params) => {
      submitted.push(params)
      return Promise.resolve(wsOk)
    },
    cancelOrder: (params) => {
      cancelled.push(params)
      return Promise.resolve(wsOk)
    },
  }
  const rest: OkxRestOrderClient = {
    submitOrder: (params) => {
      submitted.push(params)
      return Promise.resolve(restOk)
    },
  }
  const transport = createOkxOrderTransport({
    wsApi,
    rest,
    clock,
    resolveVenue: () => 'BTC-USDT-SWAP',
    recordVenue: (cid, venue) => venueMap.set(cid, venue),
    venueForClientId: (cid) => venueMap.get(cid) ?? 'BTC-USDT-SWAP',
    getOrder: (cid): Promise<Order> =>
      Promise.resolve({ clientOrderId: cid, symbol: 'BTC', side: 'long', type: 'limit', status: 'OPEN' }),
    // The adapter's callOrder maps any throw through mapOkxError.
    callOrder: async (_weight, fn) => {
      try {
        return await fn()
      } catch (err) {
        throw mapOkxError(err)
      }
    },
    ...over,
  })
  return { transport, clock, venueMap, submitted, cancelled }
}

describe('okx order transport — payload', () => {
  it('records clientOrderId → instId before the ack (adoption/getOrder need it)', async () => {
    const { transport, venueMap } = build()
    await transport.submit(req)
    expect(venueMap.get(req.clientOrderId)).toBe('BTC-USDT-SWAP')
  })

  it('builds an isolated one-way limit payload keyed on the re-spelled clOrdId', async () => {
    const { transport, submitted } = build()
    const ack = await transport.submit(req)
    expect(submitted[0]).toEqual({
      instId: 'BTC-USDT-SWAP',
      tdMode: 'isolated',
      side: 'buy',
      ordType: 'limit',
      sz: '0.03',
      px: '20000',
      clOrdId: 'BTCxd28710000xdentryxd1',
    })
    expect(ack).toEqual({ clientOrderId: req.clientOrderId, accepted: true, venueOrderId: 'ok-1' })
  })

  it('sends the numeric instIdCode alongside instId — the WS trade API rejects the id alone (50014)', async () => {
    const { transport, submitted, cancelled } = build({ resolveInstIdCode: () => 2_021_032_601_102_993 })
    await transport.submit(req)
    expect(submitted[0]).toMatchObject({ instId: 'BTC-USDT-SWAP', instIdCode: 2_021_032_601_102_993 })
    await transport.cancel(req.clientOrderId)
    expect(cancelled[0]).toMatchObject({ instIdCode: 2_021_032_601_102_993 })
  })

  it('omits instIdCode when the registry has no code for the symbol (REST still takes instId)', async () => {
    const { transport, submitted } = build()
    await transport.submit(req)
    expect(submitted[0]).not.toHaveProperty('instIdCode')
  })

  it('sends no posSide — it is only accepted in long/short mode (11 §1 is one-way)', async () => {
    const { transport, submitted } = build()
    await transport.submit(req)
    expect(submitted[0]).not.toHaveProperty('posSide')
  })

  it('a reduce-only market close carries reduceOnly and no price', async () => {
    const { transport, submitted } = build()
    await transport.submit({ ...req, type: 'market', price: undefined, reduceOnly: true })
    expect(submitted[0]).toMatchObject({ ordType: 'market', reduceOnly: true })
    expect(submitted[0]).not.toHaveProperty('px')
  })

  it("maps 'stop' to a market order with an attached stop trigger (no standalone stop type)", async () => {
    const { transport, submitted } = build()
    await transport.submit({ ...req, type: 'stop', price: 19_000 })
    expect(submitted[0]).toMatchObject({ ordType: 'market', slTriggerPx: '19000', slOrdPx: '-1' })
  })
})

describe('okx order transport — the third reject shape', () => {
  it('a RESOLVED reply with code 1 + nested sCode is a rejection, not an ack', async () => {
    const { transport } = build({
      wsApi: {
        submitNewOrder: () =>
          Promise.resolve({
            code: '1',
            msg: 'Operation failed.',
            data: [{ clOrdId: VENUE_CLORDID, sCode: '51008', sMsg: 'Order failed. Insufficient USDT balance' }],
          }),
        cancelOrder: () => Promise.resolve(wsOk),
      },
    })
    await expect(transport.submit(req)).rejects.toMatchObject({
      kind: 'InsufficientBalance',
      rawCode: 51008,
      reason: 'Order failed. Insufficient USDT balance',
    })
  })

  it('a nested sCode 51020 (below minSz) classifies as OrderRejected, never a retryable NetworkError', async () => {
    const { transport } = build({
      wsApi: {
        submitNewOrder: () =>
          Promise.resolve({ code: '1', data: [{ sCode: '51020', sMsg: 'Order amount too small' }] }),
        cancelOrder: () => Promise.resolve(wsOk),
      },
    })
    await expect(transport.submit(req)).rejects.toMatchObject({ kind: 'OrderRejected', rawCode: 51020 })
  })

  it('a REJECTED raw reply payload (not an Error) is lifted and classified the same way', async () => {
    const { transport } = build({
      wsApi: {
        submitNewOrder: () => Promise.reject({ code: '1', data: [{ sCode: '51008', sMsg: 'no funds' }] }),
        cancelOrder: () => Promise.resolve(wsOk),
      },
    })
    await expect(transport.submit(req)).rejects.toMatchObject({ kind: 'InsufficientBalance', rawCode: 51008 })
  })

  it('a top-level transport code (50011) classifies as RateLimited', async () => {
    const { transport } = build({
      wsApi: {
        submitNewOrder: () => Promise.resolve({ code: '50011', msg: 'Rate limit reached', data: [] }),
        cancelOrder: () => Promise.resolve(wsOk),
      },
    })
    await expect(transport.submit(req)).rejects.toMatchObject({ kind: 'RateLimited', rawCode: 50011 })
  })

  it('the REST fallback applies the same sCode check — a 200 response is not an acceptance', async () => {
    const { transport } = build({
      rest: { submitOrder: () => Promise.resolve([{ sCode: '51000', sMsg: 'Parameter clOrdId error' }]) },
    })
    await expect(transport.submitRest(req)).rejects.toMatchObject({ kind: 'OrderRejected', rawCode: 51000 })
  })
})

describe('okx order transport — timeout, REST fallback, cancel', () => {
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

  it('REST fallback submits the same clOrdId (idempotent) and acks the venue order id', async () => {
    const { transport, submitted } = build()
    const ack = await transport.submitRest(req)
    expect(submitted[0]).toMatchObject({ clOrdId: VENUE_CLORDID, tdMode: 'isolated' })
    expect(ack).toEqual({ clientOrderId: req.clientOrderId, accepted: true, venueOrderId: 'ok-2' })
  })

  it('cancel resolves the instId from the submit-time map and cancels by the re-spelled clOrdId', async () => {
    const { transport, cancelled } = build()
    await transport.submit(req)
    await transport.cancel(req.clientOrderId)
    expect(cancelled[0]).toEqual({ instId: 'BTC-USDT-SWAP', clOrdId: VENUE_CLORDID })
  })

  it('cancel of an already-gone order surfaces the nested 51400 as NotFound', async () => {
    const { transport } = build({
      wsApi: {
        submitNewOrder: () => Promise.resolve(wsOk),
        cancelOrder: () => Promise.resolve({ code: '1', data: [{ sCode: '51400', sMsg: 'Order does not exist' }] }),
      },
    })
    await expect(transport.cancel(req.clientOrderId)).rejects.toMatchObject({ kind: 'NotFound', rawCode: 51400 })
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
