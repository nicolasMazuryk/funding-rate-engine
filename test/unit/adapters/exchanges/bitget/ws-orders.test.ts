/**
 * Unit: Bitget order transport (`ws-orders.ts`), the venue write path behind the order manager
 * (`11_execution_and_account_state.md` §5). Offline against fake WS-API / REST clients and the
 * virtual clock. Mirrors the OKX sibling and pins the Bitget-only hazards — each one is a place
 * where a plausible-looking payload or reply would silently do the wrong thing live:
 *  - **two spellings of the same product.** The WS trade API takes `category: 'usdt-futures'`
 *    and `reduceOnly: 'YES'|'NO'`; REST takes `category: 'USDT-FUTURES'` and `'yes'|'no'`. The
 *    casing is not interchangeable, so each surface's exact payload is asserted rather than
 *    matched loosely — a reduce-only close sent in the wrong spelling could *open* a position.
 *  - **two success codes.** WS acceptance is `code: '0'`, REST acceptance is `'00000'`; anything
 *    else is a rejection that must surface as a MAPPED error, never a fake ack.
 *  - **the accepted WS row lives under `args`, not `data`** (an SDK quirk) — reading `data`
 *    would drop `venueOrderId` on every WS submit.
 *  - **`marginMode: 'isolated'` on every order** (`11` §1): stated per order so a refused
 *    account-level switch (`./account-setup.ts`) fails loud at the venue instead of quietly
 *    filling cross-margined. `posSide` is omitted — it exists only in hedge mode.
 *  - **`clientOid` goes out verbatim** (Bitget's charset accepts the engine id, unlike OKX);
 *    the only guard is the 32-char ceiling, and an over-long id *throws* rather than being
 *    truncated — a truncated key is not idempotent.
 *  - **cancel needs no instrument** (unlike OKX): `clientOid` alone.
 *  - the lib has no per-request timer, so the `Clock`-based race is what produces `WsTimeout`.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { mapBitgetError } from '../../../../../src/adapters/exchanges/bitget/error-map.js'
import {
  type BitgetOrderTransportDeps,
  type BitgetRestOrderClient,
  type BitgetWsOrderClient,
  createBitgetOrderTransport,
  REST_CATEGORY,
  toRestOrderParams,
  toWsOrderParams,
  WS_CATEGORY,
} from '../../../../../src/adapters/exchanges/bitget/ws-orders.js'
import type { Order, OrderRequest } from '../../../../../src/core/ports/exchange-adapter.js'

const VENUE_SYMBOL = 'BTCUSDT'

const req: OrderRequest = {
  symbol: 'BTC',
  side: 'long',
  type: 'limit',
  qty: 0.03,
  price: 20_000,
  clientOrderId: 'BTC-28710000-entry-1',
}

/** WS acceptance: envelope `code: '0'`, and the accepted row under `args` (not `data`). */
const wsOk = { code: '0', msg: 'success', args: [{ orderId: 'ws-1', clientOid: req.clientOrderId }] }
/** REST acceptance: envelope `code: '00000'`, and the accepted row under `data`. */
const restOk = { code: '00000', msg: 'success', data: { orderId: 'rest-1', clientOid: req.clientOrderId } }

/** Build the transport over supplied fakes + a map-on-throw `callOrder` (mirrors the adapter). */
function build(over: Partial<BitgetOrderTransportDeps> = {}) {
  const clock = createVirtualClock(0)
  const venueMap = new Map<string, string>()
  const submitted: unknown[] = []
  const cancelled: unknown[] = []
  /** Every `category` argument either surface was handed, in call order. */
  const categories: string[] = []
  let venueLookups = 0
  const wsApi: BitgetWsOrderClient = {
    submitNewOrder: (category, params) => {
      categories.push(category)
      submitted.push(params)
      return Promise.resolve(wsOk)
    },
    cancelOrder: (category, params) => {
      categories.push(category)
      cancelled.push(params)
      return Promise.resolve(wsOk)
    },
  }
  const rest: BitgetRestOrderClient = {
    submitNewOrder: (params) => {
      categories.push(params.category)
      submitted.push(params)
      return Promise.resolve(restOk)
    },
  }
  const transport = createBitgetOrderTransport({
    wsApi,
    rest,
    clock,
    resolveVenue: () => {
      venueLookups++
      return VENUE_SYMBOL
    },
    recordVenue: (cid, venue) => venueMap.set(cid, venue),
    getOrder: (cid): Promise<Order> =>
      Promise.resolve({ clientOrderId: cid, symbol: 'BTC', side: 'long', type: 'limit', status: 'OPEN' }),
    // The adapter's callOrder maps any throw through mapBitgetError.
    callOrder: async (_weight, fn) => {
      try {
        return await fn()
      } catch (err) {
        throw mapBitgetError(err)
      }
    },
    ...over,
  })
  return { transport, clock, venueMap, submitted, cancelled, categories, venueLookups: () => venueLookups }
}

describe('bitget order transport — the two payload spellings', () => {
  it('records clientOrderId → venue symbol before the ack (adoption/getOrder need it)', async () => {
    const { transport, venueMap } = build()
    await transport.submit(req)
    expect(venueMap.get(req.clientOrderId)).toBe(VENUE_SYMBOL)
  })

  it('builds the WS payload: lower-case category, isolated margin, verbatim clientOid', async () => {
    const { transport, submitted, categories } = build()
    const ack = await transport.submit(req)
    expect(categories[0]).toBe('usdt-futures') // the literal, not just the exported constant
    expect(submitted[0]).toEqual({
      symbol: VENUE_SYMBOL,
      side: 'buy',
      orderType: 'limit',
      qty: '0.03',
      price: '20000',
      clientOid: 'BTC-28710000-entry-1', // verbatim — Bitget's charset accepts the engine id
      marginMode: 'isolated',
    })
    // The venue order id comes off `orderId` on the accepted row.
    expect(ack).toEqual({ clientOrderId: req.clientOrderId, accepted: true, venueOrderId: 'ws-1' })
  })

  it('builds the REST payload: UPPER-case category in the body, same core fields', async () => {
    const { transport, submitted, categories } = build()
    const ack = await transport.submitRest(req)
    expect(categories[0]).toBe('USDT-FUTURES')
    expect(submitted[0]).toEqual({
      category: 'USDT-FUTURES',
      symbol: VENUE_SYMBOL,
      side: 'buy',
      orderType: 'limit',
      qty: '0.03',
      price: '20000',
      clientOid: 'BTC-28710000-entry-1',
      marginMode: 'isolated',
    })
    // REST's accepted row is under `data`, not `args`.
    expect(ack).toEqual({ clientOrderId: req.clientOrderId, accepted: true, venueOrderId: 'rest-1' })
  })

  it('spells reduceOnly differently per surface — YES on WS, yes on REST (not interchangeable)', () => {
    const close = { ...req, type: 'market' as const, price: undefined, reduceOnly: true }
    expect(toWsOrderParams(close, VENUE_SYMBOL)).toMatchObject({ reduceOnly: 'YES' })
    expect(toRestOrderParams(close, VENUE_SYMBOL)).toMatchObject({ category: REST_CATEGORY, reduceOnly: 'yes' })
    expect(WS_CATEGORY).toBe('usdt-futures')
    expect(REST_CATEGORY).toBe('USDT-FUTURES')
  })

  it('omits reduceOnly entirely on an opening order (no NO/no sentinel is sent)', () => {
    expect(toWsOrderParams(req, VENUE_SYMBOL)).not.toHaveProperty('reduceOnly')
    expect(toRestOrderParams(req, VENUE_SYMBOL)).not.toHaveProperty('reduceOnly')
  })

  it('states marginMode isolated on EVERY order and never sends posSide (one-way mode)', () => {
    for (const type of ['market', 'limit', 'stop'] as const) {
      for (const params of [
        toWsOrderParams({ ...req, type }, VENUE_SYMBOL),
        toRestOrderParams({ ...req, type }, VENUE_SYMBOL),
      ]) {
        // Per order, not assumed from the account-level switch: a refused switch must reject
        // the submit at the venue rather than fill it cross-margined (`11` §1).
        expect(params.marginMode).toBe('isolated')
        expect(params).not.toHaveProperty('posSide')
      }
    }
  })

  it("maps 'stop' to a market order with an attached stopLoss off the mark (no native stop type)", async () => {
    const { transport, submitted } = build()
    await transport.submit({ ...req, type: 'stop', price: 19_000 })
    expect(submitted[0]).toMatchObject({ orderType: 'market', stopLoss: '19000', slTriggerBy: 'mark' })
    expect(submitted[0]).not.toHaveProperty('price') // the trigger is the stop, not a limit price
  })

  it('a market order carries no price at all', async () => {
    const { transport, submitted } = build()
    await transport.submit({ ...req, type: 'market', price: undefined })
    expect(submitted[0]).toMatchObject({ orderType: 'market' })
    expect(submitted[0]).not.toHaveProperty('price')
  })

  it('a short becomes side sell', () => {
    expect(toWsOrderParams({ ...req, side: 'short' }, VENUE_SYMBOL).side).toBe('sell')
  })

  /**
   * Regression, task 0440 Phase 2 (live demo): the core's tick rounding
   * (`Math.round(p / 0.1) * 0.1`) lands on `62785.700000000004`, and shipping that verbatim
   * gets the order rejected with `43028` "Please enter an integer multiple of 0.1 for price".
   * Both price and qty must reach the wire on the grid.
   */
  it('serializes a tick-rounded price off the float grid (43028 regression)', () => {
    const params = toWsOrderParams(
      { ...req, price: Math.round(62_785.674_999 / 0.1) * 0.1, qty: 0.3 - 0.1 },
      VENUE_SYMBOL,
    )
    expect(params.price).toBe('62785.7')
    expect(params.qty).toBe('0.2')
  })

  it('keeps a value that is already exact untouched (no rounding of real precision)', () => {
    expect(toWsOrderParams({ ...req, price: 0.000_012_345, qty: 1234.5678 }, VENUE_SYMBOL)).toMatchObject({
      price: '0.000012345',
      qty: '1234.5678',
    })
  })
})

describe('bitget order transport — clientOid is a length guard, not a codec', () => {
  /** 33 chars — one over Bitget's ceiling, four over what the engine's own cap allows. */
  const overLong = 'A'.repeat(33)

  it('submit THROWS on an over-long id rather than truncating it (a truncated key is not idempotent)', async () => {
    const { transport, submitted } = build()
    await expect(transport.submit({ ...req, clientOrderId: overLong })).rejects.toThrow(/over the 32 limit/)
    expect(submitted).toHaveLength(0) // nothing reached the venue
  })

  it('cancel throws on an over-long id too, mapped like any other venue throw', async () => {
    const { transport, cancelled } = build()
    await expect(transport.cancel(overLong)).rejects.toThrow(/over the 32 limit/)
    expect(cancelled).toHaveLength(0)
  })
})

describe('bitget order transport — two success codes, everything else is a rejection', () => {
  it("accepts the WS envelope code '0' and reads the order row from args (not data)", async () => {
    const { transport } = build({
      wsApi: {
        // `data` is deliberately populated with a decoy: the SDK puts the accepted row on `args`.
        submitNewOrder: () =>
          Promise.resolve({ code: '0', args: [{ orderId: 'from-args' }], data: { orderId: 'decoy' } } as never),
        cancelOrder: () => Promise.resolve(wsOk),
      },
    })
    await expect(transport.submit(req)).resolves.toMatchObject({ venueOrderId: 'from-args' })
  })

  it("accepts the REST envelope code '00000' — the other success spelling", async () => {
    const { transport } = build({
      rest: { submitNewOrder: () => Promise.resolve({ code: '00000', data: { orderId: 'rest-2' } }) },
    })
    await expect(transport.submitRest(req)).resolves.toMatchObject({ accepted: true, venueOrderId: 'rest-2' })
  })

  it('a RESOLVED reply with a non-success code is a rejection, mapped by its venue code', async () => {
    const { transport } = build({
      wsApi: {
        submitNewOrder: () => Promise.resolve({ code: '43012', msg: 'Insufficient balance' }),
        cancelOrder: () => Promise.resolve(wsOk),
      },
    })
    // 43012 ⇒ InsufficientBalance, never a fake ack and never a retryable NetworkError.
    // Bitget codes are strings on the wire and stay strings on the mapped error.
    await expect(transport.submit(req)).rejects.toMatchObject({
      kind: 'InsufficientBalance',
      rawCode: '43012',
      reason: 'Insufficient balance',
    })
  })

  it('a REJECTED raw reply payload (not an Error) is lifted and classified the same way', async () => {
    const { transport } = build({
      wsApi: {
        // The SDK rejects with the parsed error frame, not an Error — unlifted, `err.message`
        // would read `[object Object]` and the code would be lost.
        submitNewOrder: () => Promise.reject({ code: '43012', msg: 'Insufficient balance' }),
        cancelOrder: () => Promise.resolve(wsOk),
      },
    })
    await expect(transport.submit(req)).rejects.toMatchObject({ kind: 'InsufficientBalance', rawCode: '43012' })
  })

  it('the REST fallback applies the same envelope check — a 200 response is not an acceptance', async () => {
    const { transport } = build({
      rest: { submitNewOrder: () => Promise.resolve({ code: '45110', msg: 'Order notional below minimum' }) },
    })
    await expect(transport.submitRest(req)).rejects.toMatchObject({ kind: 'OrderRejected', rawCode: '45110' })
  })

  it('an unlisted code stays retryable NetworkError rather than being guessed', async () => {
    const { transport } = build({
      wsApi: {
        submitNewOrder: () => Promise.resolve({ code: '99999', msg: 'mystery' }),
        cancelOrder: () => Promise.resolve(wsOk),
      },
    })
    await expect(transport.submit(req)).rejects.toMatchObject({ kind: 'NetworkError', rawCode: '99999' })
  })
})

describe('bitget order transport — timeout, REST fallback, cancel', () => {
  it('imposes a WsTimeout when the WS ack never resolves (the lib has no per-request timer)', async () => {
    const { transport, clock } = build({
      wsApi: {
        submitNewOrder: () => new Promise<never>(() => {}), // never settles
        cancelOrder: () => Promise.resolve(wsOk),
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

  it('REST fallback resubmits the same clientOid (idempotent) under the isolated margin mode', async () => {
    const { transport, submitted } = build()
    await transport.submitRest(req)
    expect(submitted[0]).toMatchObject({ clientOid: req.clientOrderId, marginMode: 'isolated' })
  })

  it('cancel needs NO instrument — it goes out on clientOid alone (unlike OKX)', async () => {
    const { transport, cancelled, categories, venueLookups } = build()
    // No prior submit: there is no symbol map to consult and none is needed.
    await transport.cancel(req.clientOrderId)
    expect(cancelled[0]).toEqual({ clientOid: req.clientOrderId })
    expect(categories[0]).toBe(WS_CATEGORY)
    expect(venueLookups()).toBe(0) // never resolved a venue symbol
  })

  it('cancel of an already-gone order surfaces 22001 as NotFound (the manager reconciles)', async () => {
    const { transport } = build({
      wsApi: {
        submitNewOrder: () => Promise.resolve(wsOk),
        cancelOrder: () => Promise.resolve({ code: '22001', msg: 'no order to cancel' }),
      },
    })
    await expect(transport.cancel(req.clientOrderId)).rejects.toMatchObject({ kind: 'NotFound', rawCode: '22001' })
  })

  it('getOrder delegates to the adapter read (already lane-wrapped — no double charge)', async () => {
    const { transport } = build()
    await expect(transport.getOrder('BTC-1-entry-1')).resolves.toMatchObject({ clientOrderId: 'BTC-1-entry-1' })
  })
})
