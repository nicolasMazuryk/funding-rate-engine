/**
 * Unit: KuCoin order transport (`ws-orders.ts`), the venue write path behind the order manager
 * (`11` §5). Offline against fake WS-API / REST clients and the virtual clock. Mirrors the Bitget
 * sibling and pins the KuCoin-only hazards — each is a place where a plausible-looking payload or
 * reply would silently do the wrong thing live:
 *  - **`size` is an integer contract count that nothing may divide again.** `computeQty` is
 *    `amountUsd / price / contractSize` and KuCoin's `contractSize` *is* its `multiplier`, so the
 *    core's output is already the venue's unit; a second `toVenueUnits` would under-size by up to
 *    1000× (`./contract-size-chain.test.ts` walks the whole chain).
 *  - **one payload shape and one success envelope** across both surfaces (`200000`) — no casing
 *    fork, unlike Bitget's two spellings and two codes. Anything but `200000` is a rejection that
 *    must surface as a MAPPED error, never a fake ack.
 *  - **`marginMode: 'ISOLATED'` on every order** (upper case here), stated per order so a refused
 *    account-setup switch fails loud at the venue instead of quietly filling cross-margined.
 *  - **`leverage` rides the order**, because KuCoin publishes no isolated-leverage endpoint at all
 *    (`./account-setup.test.ts`); it is present only when the account-setup cache resolved one.
 *  - **`'stop'` is a market order plus the venue's trigger triplet**, with the direction derived
 *    from the side — a `sell` stop (exiting a long) triggers on the way down.
 *  - **cancel demands the symbol** (OKX's shape, not Bitget's client-id-alone), so an id this
 *    process never submitted cannot be cancelled at all and must not cost a venue round-trip.
 *  - the lib has no per-request timer, so the `Clock`-based race is what produces `WsTimeout`.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { mapKucoinError } from '../../../../../src/adapters/exchanges/kucoin/error-map.js'
import {
  createKucoinOrderTransport,
  type KucoinOrderTransportDeps,
  type KucoinRestOrderClient,
  type KucoinWsOrderClient,
  toOrderParams,
} from '../../../../../src/adapters/exchanges/kucoin/ws-orders.js'
import type { Order, OrderRequest } from '../../../../../src/core/ports/exchange-adapter.js'

const VENUE_SYMBOL = 'XBTUSDTM'

const req: OrderRequest = {
  symbol: 'BTC',
  side: 'long',
  type: 'limit',
  qty: 5,
  price: 62_800,
  clientOrderId: 'BTC-1785080220000-entry-1',
}

/** The one success envelope, on the WS trade API and on REST alike. */
const wsOk = { code: '200000', data: { orderId: 'ws-1', clientOid: req.clientOrderId } }
const restOk = { code: '200000', data: { orderId: 'rest-1', clientOid: req.clientOrderId } }

/** Build the transport over supplied fakes + a map-on-throw `callOrder` (mirrors the adapter). */
function build(over: Partial<KucoinOrderTransportDeps> = {}) {
  const clock = createVirtualClock(0)
  const venueMap = new Map<string, string>()
  const submitted: unknown[] = []
  const cancelled: unknown[] = []
  let wsCalls = 0
  const wsApi: KucoinWsOrderClient = {
    submitFuturesOrder: (params) => {
      wsCalls++
      submitted.push(params)
      return Promise.resolve(wsOk)
    },
    cancelFuturesOrder: (params) => {
      wsCalls++
      cancelled.push(params)
      return Promise.resolve(wsOk)
    },
  }
  const rest: KucoinRestOrderClient = {
    submitOrder: (params) => {
      submitted.push(params)
      return Promise.resolve(restOk)
    },
  }
  const transport = createKucoinOrderTransport({
    wsApi,
    rest,
    clock,
    resolveVenue: () => VENUE_SYMBOL,
    recordVenue: (cid, venue) => venueMap.set(cid, venue),
    lookupVenue: (cid) => venueMap.get(cid),
    getOrder: (cid): Promise<Order> =>
      Promise.resolve({ clientOrderId: cid, symbol: 'BTC', side: 'long', type: 'limit', status: 'OPEN' }),
    // The adapter's callOrder maps any throw through mapKucoinError.
    callOrder: async (_weight, fn) => {
      try {
        return await fn()
      } catch (err) {
        throw mapKucoinError(err)
      }
    },
    ...over,
  })
  return { transport, clock, venueMap, submitted, cancelled, wsCalls: () => wsCalls }
}

describe('kucoin order transport — the one payload shape', () => {
  it('records clientOrderId → venue symbol before the ack (cancel and adoption need it)', async () => {
    const { transport, venueMap } = build()
    await transport.submit(req)
    expect(venueMap.get(req.clientOrderId)).toBe(VENUE_SYMBOL)
  })

  it('passes the integer contract count straight through as `size`, with isolated margin', async () => {
    const { transport, submitted } = build()
    const ack = await transport.submit(req)
    expect(submitted[0]).toEqual({
      symbol: VENUE_SYMBOL,
      side: 'buy',
      type: 'limit',
      size: 5, // a NUMBER of contracts, not a stringified base-unit amount
      price: '62800',
      clientOid: 'BTC-1785080220000-entry-1', // verbatim — the venue ceiling is above the core's
      marginMode: 'ISOLATED',
    })
    expect(ack).toEqual({ clientOrderId: req.clientOrderId, accepted: true, venueOrderId: 'ws-1' })
  })

  it('the REST fallback sends the SAME payload — one shape, no casing fork (unlike Bitget)', async () => {
    const { transport, submitted } = build()
    const ack = await transport.submitRest(req)
    expect(submitted[0]).toEqual(toOrderParams(req, VENUE_SYMBOL))
    // Idempotent resubmit: the same clientOid, so the venue rejects a duplicate rather than
    // opening a second live order for the leg (`11` §4).
    expect(submitted[0]).toMatchObject({ clientOid: req.clientOrderId, marginMode: 'ISOLATED' })
    expect(ack).toEqual({ clientOrderId: req.clientOrderId, accepted: true, venueOrderId: 'rest-1' })
  })

  it('carries `leverage` only when the account-setup cache resolved one', () => {
    // KuCoin has no isolated-leverage endpoint, so this field IS the setting; absent, the venue
    // applies the symbol's current value rather than a guessed one.
    expect(toOrderParams(req, VENUE_SYMBOL, 3)).toMatchObject({ leverage: 3 })
    expect(toOrderParams(req, VENUE_SYMBOL)).not.toHaveProperty('leverage')
  })

  it('reads the leverage per submit off the injected resolver', async () => {
    const { transport, submitted } = build({ resolveLeverage: (symbol) => (symbol === 'BTC' ? 5 : undefined) })
    await transport.submit(req)
    expect(submitted[0]).toMatchObject({ leverage: 5 })
  })

  it('states marginMode ISOLATED on EVERY order type and never sends positionSide (one-way mode)', () => {
    for (const type of ['market', 'limit', 'stop'] as const) {
      const params = toOrderParams({ ...req, type }, VENUE_SYMBOL)
      expect(params.marginMode).toBe('ISOLATED') // upper case on this venue
      expect(params).not.toHaveProperty('positionSide')
    }
  })

  it("maps 'stop' to a market order with the venue's trigger triplet off the mark price", () => {
    const params = toOrderParams({ ...req, side: 'short', type: 'stop', price: 60_000 }, VENUE_SYMBOL)
    expect(params).toMatchObject({ type: 'market', stop: 'down', stopPrice: '60000', stopPriceType: 'MP' })
    expect(params).not.toHaveProperty('price') // the trigger is the stop, not a limit price
  })

  it('derives the stop direction from the side — a sell stop triggers down, a buy stop up', () => {
    // A `sell` stop closes a long, so the mark must cross downward; a `buy` stop closes a short.
    expect(toOrderParams({ ...req, side: 'short', type: 'stop', price: 60_000 }, VENUE_SYMBOL).stop).toBe('down')
    expect(toOrderParams({ ...req, side: 'long', type: 'stop', price: 70_000 }, VENUE_SYMBOL).stop).toBe('up')
  })

  it('sends no trigger triplet at all when a stop request carries no price', () => {
    // Half a trigger is worse than none: the venue would take it as a plain market order, so the
    // three fields travel together or not at all.
    const params = toOrderParams({ ...req, type: 'stop', price: undefined }, VENUE_SYMBOL)
    expect(params).toMatchObject({ type: 'market' })
    expect(params).not.toHaveProperty('stop')
    expect(params).not.toHaveProperty('stopPrice')
  })

  it('a market order carries no price at all, and a short becomes side sell', () => {
    const params = toOrderParams({ ...req, type: 'market', price: undefined, side: 'short' }, VENUE_SYMBOL)
    expect(params).toMatchObject({ type: 'market', side: 'sell' })
    expect(params).not.toHaveProperty('price')
  })

  it('carries reduceOnly only when the request sets it (no NO/false sentinel is sent)', () => {
    expect(toOrderParams({ ...req, reduceOnly: true }, VENUE_SYMBOL)).toMatchObject({ reduceOnly: true })
    expect(toOrderParams(req, VENUE_SYMBOL)).not.toHaveProperty('reduceOnly')
  })

  /**
   * Carried forward from task 0440 Phase 2 (live Bitget): the core's tick rounding
   * (`Math.round(p / 0.1) * 0.1`) lands on `62785.700000000004`, and shipping all 15 digits gets
   * the order rejected by a venue that validates the tick grid. Prices reach the wire on-grid.
   */
  it('serializes a tick-rounded price off the float grid', () => {
    expect(toOrderParams({ ...req, price: Math.round(62_785.674_999 / 0.1) * 0.1 }, VENUE_SYMBOL).price).toBe('62785.7')
    // …while a value that is already exact is left untouched.
    expect(toOrderParams({ ...req, price: 0.000_012_345 }, VENUE_SYMBOL).price).toBe('0.000012345')
  })
})

describe('kucoin order transport — clientOid is a length guard, not a codec', () => {
  /** 41 chars — one over KuCoin's 40 ceiling, and five over what the core itself allows. */
  const overLong = 'A'.repeat(41)

  it('submit THROWS on an over-long id rather than truncating it (a truncated key is not idempotent)', async () => {
    const { transport, submitted } = build()
    await expect(transport.submit({ ...req, clientOrderId: overLong })).rejects.toThrow(/outside 1\.\.40/)
    expect(submitted).toHaveLength(0) // nothing reached the venue
  })

  it('cancel throws on an over-long id too, mapped like any other venue throw', async () => {
    const { transport, venueMap, cancelled } = build()
    venueMap.set(overLong, VENUE_SYMBOL) // pretend the symbol is known, to isolate the id guard
    await expect(transport.cancel(overLong)).rejects.toThrow(/outside 1\.\.40/)
    expect(cancelled).toHaveLength(0)
  })
})

describe('kucoin order transport — 200000 is the only acceptance', () => {
  it("accepts the envelope code '200000' on both surfaces and reads the row from `data`", async () => {
    const { transport } = build()
    await expect(transport.submit(req)).resolves.toMatchObject({ accepted: true, venueOrderId: 'ws-1' })
    await expect(transport.submitRest(req)).resolves.toMatchObject({ accepted: true, venueOrderId: 'rest-1' })
  })

  it('a RESOLVED reply with any other code is a rejection, mapped by its venue code', async () => {
    const { transport } = build({
      wsApi: {
        submitFuturesOrder: () => Promise.resolve({ code: '300003', msg: 'Balance not enough' }),
        cancelFuturesOrder: () => Promise.resolve(wsOk),
      },
    })
    // 300003 ⇒ InsufficientBalance, never a fake ack and never a retryable NetworkError.
    await expect(transport.submit(req)).rejects.toMatchObject({
      kind: 'InsufficientBalance',
      rawCode: '300003',
      reason: 'Balance not enough',
    })
  })

  it('a REJECTED flat reply frame (not an Error) is lifted and classified the same way', async () => {
    const { transport } = build({
      wsApi: {
        // The SDK rejects with the parsed frame, not an Error — unlifted, `err.message` would read
        // `[object Object]` and the venue code would be lost.
        submitFuturesOrder: () => Promise.reject({ code: '429000', op: 'futures.order', msg: 'Too many requests' }),
        cancelFuturesOrder: () => Promise.resolve(wsOk),
      },
    })
    await expect(transport.submit(req)).rejects.toMatchObject({ kind: 'RateLimited', rawCode: '429000' })
  })

  it('the REST fallback applies the same envelope check — a 200 response is not an acceptance', async () => {
    const { transport } = build({
      rest: { submitOrder: () => Promise.resolve({ code: '400100', msg: 'parameter error' }) },
    })
    await expect(transport.submitRest(req)).rejects.toMatchObject({ kind: 'OrderRejected', rawCode: '400100' })
  })

  it('an unlisted code stays retryable NetworkError rather than being guessed', async () => {
    const { transport } = build({
      wsApi: {
        submitFuturesOrder: () => Promise.resolve({ code: '999999', msg: 'mystery' }),
        cancelFuturesOrder: () => Promise.resolve(wsOk),
      },
    })
    await expect(transport.submit(req)).rejects.toMatchObject({ kind: 'NetworkError', rawCode: '999999' })
  })
})

describe('kucoin order transport — timeout, REST fallback, cancel', () => {
  it('imposes a WsTimeout when the WS ack never resolves (the lib has no per-request timer)', async () => {
    const { transport, clock } = build({
      wsApi: {
        submitFuturesOrder: () => new Promise<never>(() => {}), // never settles
        cancelFuturesOrder: () => Promise.resolve(wsOk),
      },
      wsAckTimeoutMs: 1_000,
    })
    const pending = transport.submit(req)
    clock.advanceBy(1_000) // virtual time only — no real timer is involved
    await expect(pending).rejects.toMatchObject({ kind: 'WsTimeout' })
  })

  it('a resolved ack cancels the timer, so a later advance cannot reject an already-settled submit', async () => {
    const { transport, clock } = build({ wsAckTimeoutMs: 1_000 })
    await expect(transport.submit(req)).resolves.toMatchObject({ accepted: true })
    clock.advanceBy(10_000)
    await expect(transport.submit(req)).resolves.toMatchObject({ accepted: true })
  })

  it('cancel goes out with clientOid AND the symbol recorded at submit (unlike Bitget)', async () => {
    const { transport, cancelled } = build()
    await transport.submit(req)
    await transport.cancel(req.clientOrderId)
    expect(cancelled[0]).toEqual({ clientOid: req.clientOrderId, symbol: VENUE_SYMBOL })
  })

  it('an id this process never submitted is a LOCAL NotFound — the venue is never called', async () => {
    // Cancelling by client id is impossible without the instrument on this venue, so there is
    // nothing to ask; `11` §6 already treats a NotFound cancel as "already gone, reconcile".
    const { transport, cancelled, wsCalls } = build()
    await expect(transport.cancel('BTC-1785080220000-exit-9')).rejects.toMatchObject({ kind: 'NotFound' })
    expect(cancelled).toHaveLength(0)
    expect(wsCalls()).toBe(0)
  })

  it('cancel of an already-gone order surfaces 100004 as NotFound (the manager reconciles)', async () => {
    const { transport } = build({
      wsApi: {
        submitFuturesOrder: () => Promise.resolve(wsOk),
        cancelFuturesOrder: () => Promise.resolve({ code: '100004', msg: 'order not exist' }),
      },
    })
    await transport.submit(req)
    await expect(transport.cancel(req.clientOrderId)).rejects.toMatchObject({ kind: 'NotFound', rawCode: '100004' })
  })

  it('getOrder delegates to the adapter read (already lane-wrapped — no double charge)', async () => {
    const { transport } = build()
    await expect(transport.getOrder('BTC-1-entry-1')).resolves.toMatchObject({ clientOrderId: 'BTC-1-entry-1' })
  })
})
