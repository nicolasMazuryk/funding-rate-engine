/**
 * Unit: KuCoin private account stream (`11` §7). Offline against a fake credentialed
 * `WebsocketClient` + fake bus, on the virtual clock, driving the hand-authored frames
 * (`./ws-fixtures.ts` → `test/fixtures/kucoin/private-ws/frames.jsonl`; that dir's `manifest.json`
 * records why they could not be captured — KuCoin has no futures sandbox, so the siblings' recipe
 * would place a real order with real money). Venue-specific focus:
 *  - **the venue splits "status" across two fields**: `type` is the event (`open` / `match` /
 *    `filled` / `canceled` / `update`) and `status` is the coarse book state. A terminal event is
 *    only terminal when `status: 'done'` confirms it, and an unknown `type` is dropped rather than
 *    read as a terminal state;
 *  - **`currentQty` is signed** (OKX's shape, not Bybit/Bitget's absolute-plus-`posSide`);
 *  - **funding is an explicit per-settlement amount**, the cleanest of the five venues:
 *    `position.settlement` carries its own `fundingFee`, already attributed to a symbol. There is
 *    no baseline, no delta and nothing to reset across a reconnect — so what this file pins is
 *    that the frame's own number is what reaches the bus, unscaled and unnegated;
 *  - `walletBalance.change` gives an exact `availableBalance`/`holdBalance` split;
 *  - a frame whose symbol does not resolve, or whose `clientOid` falls outside the engine charset,
 *    is **dropped** — never routed into some other intent's FSM.
 */

import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import {
  createKucoinPrivateStream,
  type KucoinOrderData,
  type KucoinPositionData,
  type KucoinPrivateFrame,
  type KucoinPrivateWsClient,
  type KucoinSettlementData,
  type KucoinWalletData,
  orderDataToOrderUpdate,
  positionDataToPositionUpdate,
  settlementDataToFundingFee,
  walletDataToBalanceUpdate,
} from '../../../../../src/adapters/exchanges/kucoin/private-stream.js'
import type { EngineEvent } from '../../../../../src/core/events/types.js'
import type { EventBus } from '../../../../../src/core/ports/bus.js'
import type { Balance, Order, Position } from '../../../../../src/core/ports/exchange-adapter.js'
import { ORDER_FRAMES, POSITION_FRAME, SETTLEMENT_FRAME, WALLET_FRAME } from './ws-fixtures.js'

/** The lib's connection key for the private futures socket, as the factory passes it. */
const WS_KEY = 'futuresPrivateV1'

const VENUE_TO_CANONICAL: Record<string, string> = { XBTUSDTM: 'BTC', '1000BONKUSDTM': 'BONK' }
const resolveAny = (venue: string): string | undefined => VENUE_TO_CANONICAL[venue]
const now = (): number => 999

/** The engine id the fixture order legs carry — KuCoin takes it verbatim (40-char ceiling). */
const ENTRY_ID = 'BTC-1785080220000-entry-1'
const EXIT_ID = 'BTC-1785080220000-exit-1'

/** One of the four fixture order frames (`open` → `match` → `filled`, plus the cancelled exit). */
function orderFrameAt(index: number): KucoinPrivateFrame<KucoinOrderData> {
  const frame = ORDER_FRAMES[index]
  if (frame === undefined) throw new Error(`ws-fixtures: no private order frame #${index}`)
  return frame
}

/** One order payload off the fixture, with overrides spread on top. */
function orderData(index: number, over: Partial<KucoinOrderData> = {}): KucoinOrderData {
  return { ...orderFrameAt(index).data, ...over }
}

const positionData = (over: Partial<KucoinPositionData> = {}): KucoinPositionData => ({
  ...POSITION_FRAME.data,
  ...over,
})
const settlementData = (over: Partial<KucoinSettlementData> = {}): KucoinSettlementData => ({
  ...SETTLEMENT_FRAME.data,
  ...over,
})
const walletData = (over: Partial<KucoinWalletData> = {}): KucoinWalletData => ({ ...WALLET_FRAME.data, ...over })

describe('pure mappers — orders (type is the event, status is the book state)', () => {
  it('maps the fixture lifecycle open → match → filled → canceled onto the engine FSM', () => {
    expect(orderDataToOrderUpdate(orderData(0))).toEqual({
      type: 'OrderUpdate',
      clientOrderId: ENTRY_ID,
      status: 'OPEN',
    })
    // `matchPrice` is the price of THIS match, not a cumulative average; `filledSize` is cumulative.
    expect(orderDataToOrderUpdate(orderData(1))).toEqual({
      type: 'OrderUpdate',
      clientOrderId: ENTRY_ID,
      status: 'PARTIAL',
      fillPx: 62_800,
      qty: 2,
    })
    expect(orderDataToOrderUpdate(orderData(2))).toEqual({
      type: 'OrderUpdate',
      clientOrderId: ENTRY_ID,
      status: 'FILLED',
      fillPx: 62_800.5,
      qty: 5,
    })
    expect(orderDataToOrderUpdate(orderData(3))).toEqual({
      type: 'OrderUpdate',
      clientOrderId: EXIT_ID,
      status: 'CANCELLED',
    })
  })

  it("reads an amend acknowledgement ('update') as still resting", () => {
    expect(orderDataToOrderUpdate(orderData(0, { type: 'update' }))?.status).toBe('OPEN')
  })

  it('a terminal type is only terminal when status confirms it with `done`', () => {
    // Both fields carry state on this venue; trusting `type` alone would publish a terminal status
    // off a frame the venue has not finished with.
    expect(orderDataToOrderUpdate(orderData(2, { status: 'match' }))).toBeNull()
    expect(orderDataToOrderUpdate(orderData(3, { status: 'open' }))).toBeNull()
  })

  it('drops an unknown type rather than inventing a terminal state', () => {
    // There is no rejected state on this stream: a rejected order never enters the book, it comes
    // back as a non-zero code on the submit reply (`./ws-orders.test.ts`).
    expect(orderDataToOrderUpdate(orderData(0, { type: 'nonsense' }))).toBeNull()
    expect(orderDataToOrderUpdate(orderData(0, { type: undefined }))).toBeNull()
  })

  it('omits zero fill fields rather than publishing qty 0 / fillPx 0', () => {
    expect(orderDataToOrderUpdate(orderData(1, { filledSize: '0', matchPrice: '0' }))).toEqual({
      type: 'OrderUpdate',
      clientOrderId: ENTRY_ID,
      status: 'PARTIAL',
    })
  })

  it("drops another bot's order: an id this engine could not have produced never drives our FSM", () => {
    expect(orderDataToOrderUpdate(orderData(0, { clientOid: '' }))).toBeNull()
    expect(orderDataToOrderUpdate(orderData(0, { clientOid: undefined }))).toBeNull()
    expect(orderDataToOrderUpdate(orderData(0, { clientOid: 'not*our*charset' }))).toBeNull()
    // 41 chars — one over KuCoin's 40 ceiling, so this engine could never have submitted it.
    expect(orderDataToOrderUpdate(orderData(0, { clientOid: 'x'.repeat(41) }))).toBeNull()
  })
})

describe('pure mappers — positions / wallet', () => {
  it('reads the SIGNED currentQty into an absolute qty plus a side', () => {
    expect(positionDataToPositionUpdate(positionData(), resolveAny)).toEqual({
      type: 'PositionUpdate',
      symbol: 'BTC',
      qty: 5,
      side: 'long',
    })
    // Negative is short — there is no `posSide` field to fall back on here.
    expect(positionDataToPositionUpdate(positionData({ currentQty: -5 }), resolveAny)).toMatchObject({
      qty: 5,
      side: 'short',
    })
  })

  it('a flat position reads as long qty 0', () => {
    expect(positionDataToPositionUpdate(positionData({ currentQty: 0 }), resolveAny)).toEqual({
      type: 'PositionUpdate',
      symbol: 'BTC',
      qty: 0,
      side: 'long',
    })
  })

  it('drops a position for an unresolvable symbol', () => {
    expect(positionDataToPositionUpdate(positionData({ symbol: 'DOGEUSDTM' }), resolveAny)).toBeNull()
    expect(positionDataToPositionUpdate(positionData({ symbol: undefined }), resolveAny)).toBeNull()
  })

  it('maps the wallet frame with an exact free/used split (no Binance-style approximation)', () => {
    expect(walletDataToBalanceUpdate(walletData())).toEqual({
      type: 'BalanceUpdate',
      asset: 'USDT',
      free: 9_935.0797,
      used: 64.9203,
    })
  })

  it('falls back holdBalance → orderMargin → total − free (the deprecated subjects are a subset)', () => {
    expect(walletDataToBalanceUpdate(walletData({ holdBalance: undefined, orderMargin: 12 }))).toMatchObject({
      used: 12,
    })
    expect(walletDataToBalanceUpdate({ currency: 'USDT', totalBalance: 10, availableBalance: 4 })).toEqual({
      type: 'BalanceUpdate',
      asset: 'USDT',
      free: 4,
      used: 6,
    })
  })

  it('drops a wallet frame with no currency name', () => {
    expect(walletDataToBalanceUpdate(walletData({ currency: undefined }))).toBeNull()
    expect(walletDataToBalanceUpdate(walletData({ currency: '' }))).toBeNull()
  })
})

/**
 * The funding-fee mapping — KuCoin's one genuine simplification over its four siblings. Binance
 * and OKX infer the amount from a balance delta and Bitget from a cumulative-total delta; here the
 * venue states it. So the assertions are about *not* transforming it: no baseline, no negation, no
 * rate-derived arithmetic.
 */
describe('pure mappers — funding fee (position.settlement carries an explicit amount)', () => {
  it("publishes the frame's own fundingFee, at its own fundingTime, on the first frame seen", () => {
    expect(settlementDataToFundingFee(settlementData(), resolveAny, now)).toEqual({
      type: 'FundingFeeAccrued',
      symbol: 'BTC',
      amount: -0.1213,
      fundingTime: 1_785_081_600_000,
    })
  })

  it('needs no baseline — unlike Bitget, a single settlement frame is already complete', () => {
    // Two settlements in a row are two independent amounts, not two points of a running total.
    const first = settlementDataToFundingFee(settlementData({ fundingFee: -0.1213 }), resolveAny, now)
    const second = settlementDataToFundingFee(settlementData({ fundingFee: -0.2 }), resolveAny, now)
    expect(first?.amount).toBe(-0.1213)
    expect(second?.amount).toBe(-0.2)
  })

  it('passes the sign through verbatim (credit-positive, and never derived from fundingRate)', () => {
    const credited = settlementDataToFundingFee(settlementData({ fundingFee: 0.1213 }), resolveAny, now)
    expect(credited?.amount).toBe(0.1213)
    // The row also carries a rate; recomputing the amount from it would be a second source of
    // truth for money, which `15` §4 gives to the REST income read instead.
    expect(settlementData().fundingRate).toBe(0.000375)
  })

  it('publishes nothing without an amount or a resolvable symbol', () => {
    expect(settlementDataToFundingFee(settlementData({ fundingFee: undefined }), resolveAny, now)).toBeNull()
    expect(settlementDataToFundingFee(settlementData({ symbol: 'DOGEUSDTM' }), resolveAny, now)).toBeNull()
    expect(settlementDataToFundingFee(settlementData({ symbol: undefined }), resolveAny, now)).toBeNull()
  })

  it('falls back fundingTime → ts (NANOSECONDS, scaled) → the clock', () => {
    expect(settlementDataToFundingFee(settlementData({ fundingTime: undefined }), resolveAny, now)).toMatchObject({
      fundingTime: 1_785_081_600_123, // 1785081600123000000 ns
    })
    expect(
      settlementDataToFundingFee(settlementData({ fundingTime: undefined, ts: undefined }), resolveAny, now),
    ).toMatchObject({ fundingTime: 999 })
  })
})

// ── Wired-stream harness ──────────────────────────────────────────────────────

interface FakeWs extends KucoinPrivateWsClient {
  emit(event: string, arg: unknown): void
  subscribed: string[][]
  wsKeys: string[]
  closed: number
}

function makeFakeWs(): FakeWs {
  const listeners = new Map<string, (arg: unknown) => void>()
  return {
    subscribed: [],
    wsKeys: [],
    closed: 0,
    subscribe(topics, wsKey) {
      // Synchronous on this SDK (returns void, unlike the Bybit/OKX/Bitget siblings).
      this.subscribed.push(topics)
      this.wsKeys.push(wsKey)
    },
    on(event, listener) {
      listeners.set(event, listener)
      return this
    },
    closeAll() {
      this.closed += 1
    },
    emit(event, arg) {
      listeners.get(event)?.(arg)
    },
  }
}

function makeBus(): { bus: EventBus; events: EngineEvent[] } {
  const events: EngineEvent[] = []
  const bus: EventBus = {
    publish(event) {
      events.push(event)
    },
    subscribe() {
      return () => {}
    },
  }
  return { bus, events }
}

const POSITIONS: Position[] = [{ symbol: 'BTC', side: 'long', qty: 5, entryPrice: 62_800.3 }]
const BALANCE: Balance = { asset: 'USDT', free: 9_935.0797, used: 64.9203 }
const OPEN_ORDERS: Order[] = [{ clientOrderId: ENTRY_ID, symbol: 'BTC', side: 'long', type: 'limit', status: 'OPEN' }]

function build(over?: {
  restPositions?: () => Promise<Position[]>
  restBalance?: () => Promise<Balance>
  restOpenOrders?: () => Promise<Order[]>
}) {
  const clock = createVirtualClock(0)
  const ws = makeFakeWs()
  const { bus, events } = makeBus()
  const venueMap = new Map<string, string>()
  const stream = createKucoinPrivateStream({
    ws,
    bus,
    clock,
    wsKey: WS_KEY,
    resolveCanonical: resolveAny,
    restPositions: over?.restPositions ?? (() => Promise.resolve(POSITIONS)),
    restBalance: over?.restBalance ?? (() => Promise.resolve(BALANCE)),
    restOpenOrders: over?.restOpenOrders ?? (() => Promise.resolve(OPEN_ORDERS)),
    recordOrderSymbol: (cid, venue) => venueMap.set(cid, venue),
  })
  return { clock, ws, bus, events, stream, venueMap }
}

/** A private push frame in the venue's own envelope, around one payload. */
function frame(topic: string, subject: string, data: unknown): unknown {
  return { topic, subject, type: 'message', data }
}

describe('createKucoinPrivateStream — live WS flow', () => {
  it('subscribes exactly the three account-wide topics on the private wsKey', async () => {
    const { ws, stream } = build()
    await stream.subscribe()
    expect(ws.subscribed).toEqual([['/contractMarket/tradeOrders', '/contract/positionAll', '/contractAccount/wallet']])
    expect(ws.wsKeys).toEqual([WS_KEY])
  })

  it('subscribes positionAll, never the per-symbol position topic (subscribe() takes no symbols)', async () => {
    // A per-symbol topic would need a subscribe-on-submit / unsubscribe-on-flat lifecycle racing
    // the very fill that closes the position; `positionAll` costs one subscription instead.
    const { ws, stream } = build()
    await stream.subscribe()
    expect(ws.subscribed.flat()).toContain('/contract/positionAll')
    expect(ws.subscribed.flat().some((t) => t.startsWith('/contract/position:'))).toBe(false)
  })

  it('an order frame publishes OrderUpdate and records clientOrderId → venue symbol', async () => {
    const { ws, events, stream, venueMap } = build()
    await stream.subscribe()
    ws.emit('update', frame('/contractMarket/tradeOrders', 'symbolOrderChange', orderData(2)))
    expect(events).toEqual([
      { type: 'OrderUpdate', clientOrderId: ENTRY_ID, status: 'FILLED', fillPx: 62_800.5, qty: 5 },
    ])
    // `cancel` needs the symbol KuCoin's cancel demands; the stream keeps the map warm.
    expect(venueMap.get(ENTRY_ID)).toBe('XBTUSDTM')
  })

  it('a dropped order row records nothing — a foreign id must not pollute the symbol map', async () => {
    const { ws, events, stream, venueMap } = build()
    await stream.subscribe()
    ws.emit(
      'update',
      frame('/contractMarket/tradeOrders', 'symbolOrderChange', orderData(0, { clientOid: 'not*our*charset' })),
    )
    expect(events).toEqual([])
    expect(venueMap.size).toBe(0)
  })

  it('position.change → PositionUpdate, under the per-symbol topic the push frames use', async () => {
    // Subscribed as `positionAll`, pushed as `/contract/position:XBTUSDTM` — the matcher is a
    // prefix test for exactly that reason.
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', POSITION_FRAME)
    expect(events).toEqual([{ type: 'PositionUpdate', symbol: 'BTC', qty: 5, side: 'long' }])
  })

  it('position.settlement → FundingFeeAccrued carrying the frame’s explicit fundingFee', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', SETTLEMENT_FRAME)
    expect(events).toEqual([
      { type: 'FundingFeeAccrued', symbol: 'BTC', amount: -0.1213, fundingTime: 1_785_081_600_000 },
    ])
  })

  it('walletBalance.change → BalanceUpdate', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', WALLET_FRAME)
    expect(events).toEqual([{ type: 'BalanceUpdate', asset: 'USDT', free: 9_935.0797, used: 64.9203 }])
  })

  it('drops position and settlement frames for an unresolvable symbol', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', frame('/contract/position:DOGEUSDTM', 'position.change', positionData({ symbol: 'DOGEUSDTM' })))
    ws.emit(
      'update',
      frame('/contract/position:DOGEUSDTM', 'position.settlement', settlementData({ symbol: 'DOGEUSDTM' })),
    )
    expect(events).toEqual([])
  })

  it('never throws into the socket lib on a malformed frame', async () => {
    const { ws, stream } = build()
    await stream.subscribe()
    expect(() => ws.emit('update', undefined)).not.toThrow()
    expect(() => ws.emit('update', { topic: '/contractMarket/tradeOrders' })).not.toThrow() // no data
    expect(() => ws.emit('update', frame('/contractMarket/execution', 'match', {}))).not.toThrow() // unsubscribed
    expect(() => ws.emit('update', { type: 'ack', id: '1' })).not.toThrow()
  })

  it('close() closes the socket', async () => {
    const { ws, stream } = build()
    await stream.close()
    expect(ws.closed).toBe(1)
  })
})

describe('createKucoinPrivateStream — disconnect / fallback / reprime', () => {
  it('polls account REST while degraded, reprimes positions → balance → open orders on reconnect', async () => {
    const restPositions = vi.fn(() => Promise.resolve(POSITIONS))
    const restBalance = vi.fn(() => Promise.resolve(BALANCE))
    const restOpenOrders = vi.fn(() => Promise.resolve(OPEN_ORDERS))
    const { clock, ws, events, stream } = build({ restPositions, restBalance, restOpenOrders })
    await stream.subscribe()

    ws.emit('reconnect', {})
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(1)
    expect(restBalance).toHaveBeenCalledTimes(1)
    expect(restOpenOrders).not.toHaveBeenCalled() // no order poll while degraded
    expect(events).toContainEqual({ type: 'PositionUpdate', symbol: 'BTC', qty: 5, side: 'long' })

    clock.advanceBy(15_000)
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(2)

    ws.emit('reconnected', {})
    await flush()
    // The three reprime reads, in order, before the WS is trusted again.
    expect(restPositions).toHaveBeenCalledTimes(3)
    expect(restBalance).toHaveBeenCalledTimes(3)
    expect(restOpenOrders).toHaveBeenCalledTimes(1) // open orders only on reprime
    expect(events).toContainEqual({ type: 'OrderUpdate', clientOrderId: ENTRY_ID, status: 'OPEN' })

    const settled = restPositions.mock.calls.length
    clock.advanceBy(15_000 * 5)
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(settled)
  })

  it('carries no cross-outage funding state — the first settlement after a drop still publishes', async () => {
    // The Bitget sibling must clear a delta baseline on disconnect so no phantom credit spans the
    // outage. Here the amount is per settlement, so there is nothing to clear and nothing to lose.
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('reconnect', {})
    await flush()
    events.length = 0

    ws.emit('update', SETTLEMENT_FRAME)
    expect(events).toEqual([
      { type: 'FundingFeeAccrued', symbol: 'BTC', amount: -0.1213, fundingTime: 1_785_081_600_000 },
    ])
  })
})

/** Drain the microtask + resolved-promise chain the REST poll schedules. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
