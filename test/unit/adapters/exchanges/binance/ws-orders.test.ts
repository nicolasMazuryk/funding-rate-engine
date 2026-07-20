/**
 * Unit: Binance order transport (`ws-orders.ts`). Offline against fake WS-API / REST
 * clients. Focus on the venue-quirk mappings the manager depends on: a WS-API rejection
 * nests its numeric code at `err.error.code`, which must classify as `OrderRejected`
 * (not a retryable `NetworkError`); a WS ack that never resolves must surface `WsTimeout`
 * via the injected clock; and submit records `clientOrderId → venueSymbol` before the ack.
 */

import type { WSAPIFuturesOrder, WSAPIResponse } from 'binance'
import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { mapBinanceError } from '../../../../../src/adapters/exchanges/binance/error-map.js'
import {
  type BinanceOrderTransportDeps,
  type BinanceRestOrderClient,
  type BinanceWsOrderClient,
  createBinanceOrderTransport,
} from '../../../../../src/adapters/exchanges/binance/ws-orders.js'
import type { Order, OrderRequest } from '../../../../../src/core/ports/exchange-adapter.js'

const req: OrderRequest = {
  symbol: 'BTC',
  side: 'long',
  type: 'limit',
  qty: 0.003,
  price: 20_000,
  clientOrderId: 'BTC-1-entry-1',
}

const okResponse = (orderId: number): WSAPIResponse<WSAPIFuturesOrder> =>
  ({ result: { orderId, clientOrderId: req.clientOrderId } }) as unknown as WSAPIResponse<WSAPIFuturesOrder>

/** Build the transport over supplied fake clients + a map-on-throw `callOrder` (mirrors the adapter). */
function build(over: Partial<BinanceOrderTransportDeps> = {}) {
  const clock = createVirtualClock(0)
  const venueMap = new Map<string, string>()
  const wsApi: BinanceWsOrderClient = {
    submitNewFuturesOrder: () => Promise.resolve(okResponse(1)),
    cancelFuturesOrder: () => Promise.resolve(okResponse(1)),
  }
  const rest: BinanceRestOrderClient = { submitNewOrder: () => Promise.resolve({ orderId: 2 } as never) }
  const transport = createBinanceOrderTransport({
    wsApi,
    rest,
    clock,
    resolveVenue: () => 'BTCUSDT',
    recordVenue: (cid, venue) => venueMap.set(cid, venue),
    venueForClientId: (cid) => venueMap.get(cid) ?? 'BTCUSDT',
    getOrder: (cid): Promise<Order> =>
      Promise.resolve({ clientOrderId: cid, symbol: 'BTC', side: 'long', type: 'limit', status: 'OPEN' }),
    // The adapter's callOrder maps any throw through mapBinanceError.
    callOrder: async (_weight, fn) => {
      try {
        return await fn()
      } catch (err) {
        throw mapBinanceError(err)
      }
    },
    ...over,
  })
  return { transport, clock, venueMap }
}

describe('binance order transport', () => {
  it('records clientOrderId → venueSymbol before the ack (adoption/getOrder need it)', async () => {
    const { transport, venueMap } = build()
    await transport.submit(req)
    expect(venueMap.get('BTC-1-entry-1')).toBe('BTCUSDT')
  })

  it('classifies a nested WS-API reject (err.error.code -4164) as OrderRejected, not NetworkError', async () => {
    const { transport } = build({
      wsApi: {
        submitNewFuturesOrder: () =>
          Promise.reject({ status: 400, error: { code: -4164, msg: 'Order notional below min' } }),
        cancelFuturesOrder: () => Promise.resolve(okResponse(1)),
      },
    })
    await expect(transport.submit(req)).rejects.toMatchObject({ kind: 'OrderRejected' })
  })

  it('imposes a WsTimeout when the WS ack never resolves', async () => {
    const { transport, clock } = build({
      wsApi: {
        submitNewFuturesOrder: () => new Promise<never>(() => {}), // never settles
        cancelFuturesOrder: () => Promise.resolve(okResponse(1)),
      },
      wsAckTimeoutMs: 1_000,
    })
    const pending = transport.submit(req)
    clock.advanceBy(1_000)
    await expect(pending).rejects.toMatchObject({ kind: 'WsTimeout' })
  })
})
