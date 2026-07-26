/**
 * Unit: Bitget private account stream (`11` §7). Offline against a fake credentialed
 * `WebsocketClientV3` + fake bus, on the virtual clock. Venue-specific focus:
 *  - **three UTA topics, and deliberately not a fourth** — `fill` is not subscribed, because the
 *    `order` topic already carries the cumulative fill state the order FSM runs on; two sources
 *    of truth for one FSM is the bug this assertion exists to keep out;
 *  - `order` rows key on `clientOid`, which Bitget echoes **verbatim** (no codec, unlike OKX),
 *    so the only thing that can make an id foreign is length/charset — and a foreign id is
 *    dropped, never guessed;
 *  - `position` reports an **absolute** `size` plus a `posSide` (Bybit's shape, not OKX's signed
 *    `pos`);
 *  - `account` gives an exact `available`/`locked` split;
 *  - **funding fee is a `totalFundingFee` delta between position frames** — the highest-risk
 *    mapping on this venue. The invariants pinned here are the ones a wrong implementation
 *    silently violates: no publish without a baseline, the baseline advances on *every* frame
 *    (so two settlements are two deltas, not an accumulation), and a disconnect clears it so no
 *    phantom credit spans the outage.
 */

import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import {
  accountRowToBalanceUpdates,
  type BitgetAccountRow,
  type BitgetOrderRow,
  type BitgetPositionRow,
  type BitgetPrivateWsClient,
  createBitgetPrivateStream,
  orderRowToOrderUpdate,
  positionRowToFundingFee,
  positionRowToPositionUpdate,
} from '../../../../../src/adapters/exchanges/bitget/private-stream.js'
import type { BitgetTopicRequest } from '../../../../../src/adapters/exchanges/bitget/public-stream.js'
import type { EngineEvent } from '../../../../../src/core/events/types.js'
import type { EventBus } from '../../../../../src/core/ports/bus.js'
import type { Balance, Order, Position } from '../../../../../src/core/ports/exchange-adapter.js'

/** The lib's connection key for the private v3 socket, as the factory passes it. */
const WS_KEY = 'v3Private'

const VENUE_TO_CANONICAL: Record<string, string> = { BTCUSDT: 'BTC', '1000PEPEUSDT': 'PEPE' }
const resolveAny = (venue: string): string | undefined => VENUE_TO_CANONICAL[venue]
const now = (): number => 999

/** An engine id in the core's `${intentId}-${leg}-${attempt}` shape — Bitget takes it verbatim. */
const CLIENT_ORDER_ID = 'BTC-28710000-entry-1'

// ── Row factories (real venue shape: strings everywhere) ──────────────────────

function orderRow(over: Partial<BitgetOrderRow> = {}): BitgetOrderRow {
  return {
    symbol: 'BTCUSDT',
    clientOid: CLIENT_ORDER_ID,
    orderId: '1217143186968068096',
    orderStatus: 'live',
    cumExecQty: '0',
    avgPrice: '',
    ...over,
  }
}

function positionRow(over: Partial<BitgetPositionRow> = {}): BitgetPositionRow {
  return {
    symbol: 'BTCUSDT',
    size: '3',
    posSide: 'long',
    avgPrice: '60000',
    totalFundingFee: '1.5',
    updatedTime: '1700000000000',
    ...over,
  }
}

function accountRow(coin: BitgetAccountRow['coin']): BitgetAccountRow {
  return { coin }
}

describe('pure mappers — orders', () => {
  it('carries the clientOid through verbatim, with no fill fields before a fill', () => {
    expect(orderRowToOrderUpdate(orderRow())).toEqual({
      type: 'OrderUpdate',
      clientOrderId: CLIENT_ORDER_ID,
      status: 'OPEN',
    })
  })

  it('maps every known orderStatus onto the engine FSM', () => {
    const status = (s: string) => orderRowToOrderUpdate(orderRow({ orderStatus: s }))?.status
    expect(status('new')).toBe('OPEN')
    expect(status('live')).toBe('OPEN')
    expect(status('partially_filled')).toBe('PARTIAL')
    expect(status('filled')).toBe('FILLED')
    // The venue is inconsistent across surfaces: both spellings must land on CANCELLED.
    expect(status('cancelled')).toBe('CANCELLED')
    expect(status('canceled')).toBe('CANCELLED')
  })

  it('carries fillPx/qty once partly filled', () => {
    expect(
      orderRowToOrderUpdate(orderRow({ orderStatus: 'partially_filled', cumExecQty: '1', avgPrice: '60010' })),
    ).toEqual({
      type: 'OrderUpdate',
      clientOrderId: CLIENT_ORDER_ID,
      status: 'PARTIAL',
      fillPx: 60_010,
      qty: 1,
    })
  })

  it('a cancel keeps the fill it did get', () => {
    expect(
      orderRowToOrderUpdate(orderRow({ orderStatus: 'cancelled', cumExecQty: '2', avgPrice: '60005' })),
    ).toMatchObject({ status: 'CANCELLED', qty: 2, fillPx: 60_005 })
  })

  it('omits zero fill fields rather than publishing qty 0 / fillPx 0', () => {
    expect(orderRowToOrderUpdate(orderRow({ cumExecQty: '0', avgPrice: '0' }))).toEqual({
      type: 'OrderUpdate',
      clientOrderId: CLIENT_ORDER_ID,
      status: 'OPEN',
    })
  })

  it('drops an unknown status rather than inventing a terminal one', () => {
    // Bitget has no rejected state on the stream; anything unrecognized is a lib/venue change.
    expect(orderRowToOrderUpdate(orderRow({ orderStatus: 'nonsense' }))).toBeNull()
    expect(orderRowToOrderUpdate(orderRow({ orderStatus: undefined }))).toBeNull()
  })

  it("drops another bot's order: an id this engine could not have produced never drives our FSM", () => {
    expect(orderRowToOrderUpdate(orderRow({ clientOid: '' }))).toBeNull()
    expect(orderRowToOrderUpdate(orderRow({ clientOid: undefined }))).toBeNull()
    expect(orderRowToOrderUpdate(orderRow({ clientOid: 'not*our*charset' }))).toBeNull()
    // 33 chars — one over Bitget's 32 ceiling, so this engine could never have submitted it.
    expect(orderRowToOrderUpdate(orderRow({ clientOid: 'x'.repeat(33) }))).toBeNull()
  })
})

describe('pure mappers — positions / account', () => {
  it('reads an absolute size with the direction in posSide (not OKX’s signed value)', () => {
    expect(positionRowToPositionUpdate(positionRow({ size: '2', posSide: 'short' }), resolveAny)).toEqual({
      type: 'PositionUpdate',
      symbol: 'BTC',
      qty: 2,
      side: 'short',
    })
    expect(positionRowToPositionUpdate(positionRow({ size: '2', posSide: 'long' }), resolveAny)).toMatchObject({
      side: 'long',
      qty: 2,
    })
  })

  it('a flat position reads as long qty 0', () => {
    expect(positionRowToPositionUpdate(positionRow({ size: '0' }), resolveAny)).toEqual({
      type: 'PositionUpdate',
      symbol: 'BTC',
      qty: 0,
      side: 'long',
    })
  })

  it('drops a position for an unknown symbol', () => {
    expect(positionRowToPositionUpdate(positionRow({ symbol: 'DOGEUSDT' }), resolveAny)).toBeNull()
    expect(positionRowToPositionUpdate(positionRow({ symbol: undefined }), resolveAny)).toBeNull()
  })

  it('maps the per-coin array with an exact free/used split (no Binance-style approximation)', () => {
    expect(
      accountRowToBalanceUpdates(
        accountRow([
          { coin: 'USDT', balance: '1000', available: '900', locked: '100' },
          { coin: 'BTC', balance: '0.5', available: '0.5', locked: '0' },
        ]),
      ),
    ).toEqual([
      { type: 'BalanceUpdate', asset: 'USDT', free: 900, used: 100 },
      { type: 'BalanceUpdate', asset: 'BTC', free: 0.5, used: 0 },
    ])
  })

  it('account: falls back locked → frozen, then derives used from the balance', () => {
    expect(
      accountRowToBalanceUpdates(accountRow([{ coin: 'USDT', balance: '10', available: '4', frozen: '6' }])),
    ).toEqual([{ type: 'BalanceUpdate', asset: 'USDT', free: 4, used: 6 }])
    expect(accountRowToBalanceUpdates(accountRow([{ coin: 'USDT', balance: '10', available: '4' }]))).toEqual([
      { type: 'BalanceUpdate', asset: 'USDT', free: 4, used: 6 },
    ])
    expect(accountRowToBalanceUpdates(accountRow([{ coin: 'USDT', balance: '10' }]))).toEqual([
      { type: 'BalanceUpdate', asset: 'USDT', free: 10, used: 0 },
    ])
  })

  it('skips a coin row with no coin name, and tolerates an absent array', () => {
    expect(accountRowToBalanceUpdates(accountRow([{ available: '1' }, { coin: '', available: '1' }]))).toEqual([])
    expect(accountRowToBalanceUpdates({})).toEqual([])
  })
})

describe('pure mappers — funding fee (totalFundingFee delta)', () => {
  it('a credited settlement is the positive change in the position’s cumulative funding', () => {
    // 2.0 cumulative now vs 1.5 before ⇒ this settlement credited 0.5.
    expect(positionRowToFundingFee(positionRow({ totalFundingFee: '2' }), resolveAny, 1.5, now)).toEqual({
      type: 'FundingFeeAccrued',
      symbol: 'BTC',
      amount: 0.5,
      fundingTime: 1_700_000_000_000,
    })
  })

  it('a paid settlement shrinks the total → negative amount, no negation (unlike Bybit’s execFee)', () => {
    expect(positionRowToFundingFee(positionRow({ totalFundingFee: '1' }), resolveAny, 1.5, now)).toMatchObject({
      amount: -0.5,
    })
  })

  it('publishes nothing without a baseline (first frame after connect — REST income covers it)', () => {
    expect(positionRowToFundingFee(positionRow(), resolveAny, undefined, now)).toBeNull()
  })

  it('publishes nothing when the cumulative total did not move', () => {
    expect(positionRowToFundingFee(positionRow({ totalFundingFee: '1.5' }), resolveAny, 1.5, now)).toBeNull()
  })

  it('publishes nothing when the row carries no total or no resolvable symbol', () => {
    expect(positionRowToFundingFee(positionRow({ totalFundingFee: '' }), resolveAny, 1.5, now)).toBeNull()
    expect(positionRowToFundingFee(positionRow({ totalFundingFee: undefined }), resolveAny, 1.5, now)).toBeNull()
    expect(positionRowToFundingFee(positionRow({ symbol: 'DOGEUSDT' }), resolveAny, 1.5, now)).toBeNull()
  })

  it('falls back to the clock when the row carries no updatedTime', () => {
    expect(
      positionRowToFundingFee(positionRow({ totalFundingFee: '2', updatedTime: undefined }), resolveAny, 1.5, now),
    ).toMatchObject({ fundingTime: 999 })
  })
})

// ── Wired-stream harness ──────────────────────────────────────────────────────

interface FakeWs extends BitgetPrivateWsClient {
  emit(event: string, arg: unknown): void
  subscribed: BitgetTopicRequest[][]
  wsKeys: string[]
  closed: number
}

function makeFakeWs(): FakeWs {
  const listeners = new Map<string, (arg: unknown) => void>()
  return {
    subscribed: [],
    wsKeys: [],
    closed: 0,
    subscribe(requests, wsKey) {
      this.subscribed.push(requests)
      this.wsKeys.push(wsKey)
      return Promise.resolve()
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

const POSITIONS: Position[] = [{ symbol: 'BTC', side: 'long', qty: 3, entryPrice: 60_000 }]
const BALANCE: Balance = { asset: 'USDT', free: 900, used: 100 }
const OPEN_ORDERS: Order[] = [
  { clientOrderId: CLIENT_ORDER_ID, symbol: 'BTC', side: 'long', type: 'limit', status: 'OPEN' },
]

function build(over?: {
  restPositions?: () => Promise<Position[]>
  restBalance?: () => Promise<Balance>
  restOpenOrders?: () => Promise<Order[]>
}) {
  const clock = createVirtualClock(0)
  const ws = makeFakeWs()
  const { bus, events } = makeBus()
  const venueMap = new Map<string, string>()
  const stream = createBitgetPrivateStream({
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

/** A private push frame in the venue's own envelope. */
function frame(topic: string, data: unknown[]): unknown {
  return { arg: { instType: 'UTA', topic }, action: 'snapshot', data }
}

describe('createBitgetPrivateStream — live WS flow', () => {
  it('subscribes exactly the three UTA topics on the private wsKey', async () => {
    const { ws, stream } = build()
    await stream.subscribe()
    expect(ws.subscribed).toEqual([
      [
        { topic: 'order', payload: { instType: 'UTA' } },
        { topic: 'position', payload: { instType: 'UTA' } },
        { topic: 'account', payload: { instType: 'UTA' } },
      ],
    ])
    expect(ws.wsKeys).toEqual([WS_KEY])
  })

  it('does NOT subscribe `fill` — the order topic is the single source of cumulative fill state', async () => {
    const { ws, stream } = build()
    await stream.subscribe()
    // Two streams feeding one order FSM would double-count fills; this is a deliberate omission.
    expect(ws.subscribed.flat().map((r) => r.topic)).not.toContain('fill')
  })

  it('an order frame publishes OrderUpdate and records clientOrderId → venue symbol', async () => {
    const { ws, events, stream, venueMap } = build()
    await stream.subscribe()
    ws.emit('update', frame('order', [orderRow({ orderStatus: 'filled', cumExecQty: '3', avgPrice: '60000' })]))
    expect(events).toEqual([
      { type: 'OrderUpdate', clientOrderId: CLIENT_ORDER_ID, status: 'FILLED', fillPx: 60_000, qty: 3 },
    ])
    // getOrder/cancel need the symbol Bitget's order read demands; the stream keeps the map warm.
    expect(venueMap.get(CLIENT_ORDER_ID)).toBe('BTCUSDT')
  })

  it('a dropped order row records nothing — a foreign id must not pollute the symbol map', async () => {
    const { ws, events, stream, venueMap } = build()
    await stream.subscribe()
    ws.emit('update', frame('order', [orderRow({ clientOid: 'not*our*charset' })]))
    expect(events).toEqual([])
    expect(venueMap.size).toBe(0)
  })

  it('position / account frames fan out to their engine events', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', frame('position', [positionRow()]))
    ws.emit('update', frame('account', [accountRow([{ coin: 'USDT', balance: '1000', available: '900' }])]))
    expect(events).toEqual([
      { type: 'PositionUpdate', symbol: 'BTC', qty: 3, side: 'long' },
      { type: 'BalanceUpdate', asset: 'USDT', free: 900, used: 100 },
    ])
  })

  it('the first position frame primes the funding baseline and publishes no FundingFeeAccrued', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', frame('position', [positionRow({ totalFundingFee: '1.5' })]))
    expect(events).toEqual([{ type: 'PositionUpdate', symbol: 'BTC', qty: 3, side: 'long' }])
  })

  it('a later frame with a changed total publishes the delta; an unchanged total publishes nothing', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', frame('position', [positionRow({ totalFundingFee: '1.5' })])) // baseline
    events.length = 0

    ws.emit('update', frame('position', [positionRow({ totalFundingFee: '2', updatedTime: '1700000600000' })]))
    expect(events).toEqual([
      { type: 'PositionUpdate', symbol: 'BTC', qty: 3, side: 'long' },
      { type: 'FundingFeeAccrued', symbol: 'BTC', amount: 0.5, fundingTime: 1_700_000_600_000 },
    ])
    events.length = 0

    // A routine position push (price/size move, no settlement) must not re-credit funding.
    ws.emit('update', frame('position', [positionRow({ totalFundingFee: '2', size: '4' })]))
    expect(events.filter((e) => e.type === 'FundingFeeAccrued')).toEqual([])
  })

  it('the baseline advances on every frame, so two settlements are two deltas and not an accumulation', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', frame('position', [positionRow({ totalFundingFee: '1' })])) // baseline 1
    ws.emit('update', frame('position', [positionRow({ totalFundingFee: '1.5' })])) // +0.5
    ws.emit('update', frame('position', [positionRow({ totalFundingFee: '2.25' })])) // +0.75, not +1.25
    expect(events.filter((e) => e.type === 'FundingFeeAccrued')).toEqual([
      { type: 'FundingFeeAccrued', symbol: 'BTC', amount: 0.5, fundingTime: 1_700_000_000_000 },
      { type: 'FundingFeeAccrued', symbol: 'BTC', amount: 0.75, fundingTime: 1_700_000_000_000 },
    ])
  })

  it('tracks the baseline per symbol — one position’s settlement is not measured against another’s', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit(
      'update',
      frame('position', [
        positionRow({ totalFundingFee: '1' }),
        positionRow({ symbol: '1000PEPEUSDT', totalFundingFee: '10' }),
      ]),
    )
    events.length = 0
    ws.emit(
      'update',
      frame('position', [
        positionRow({ totalFundingFee: '1.25' }),
        positionRow({ symbol: '1000PEPEUSDT', totalFundingFee: '10.5' }),
      ]),
    )
    expect(events.filter((e) => e.type === 'FundingFeeAccrued')).toEqual([
      { type: 'FundingFeeAccrued', symbol: 'BTC', amount: 0.25, fundingTime: 1_700_000_000_000 },
      { type: 'FundingFeeAccrued', symbol: 'PEPE', amount: 0.5, fundingTime: 1_700_000_000_000 },
    ])
  })

  it('never throws into the socket lib on a malformed frame', async () => {
    const { ws, stream } = build()
    await stream.subscribe()
    expect(() => ws.emit('update', undefined)).not.toThrow()
    expect(() => ws.emit('update', { arg: { topic: 'order' } })).not.toThrow() // no data array
    expect(() => ws.emit('update', frame('fill', []))).not.toThrow() // unsubscribed topic
    expect(() => ws.emit('update', { event: 'subscribe', arg: { topic: 'order' } })).not.toThrow()
  })

  it('close() closes the socket', async () => {
    const { ws, stream } = build()
    await stream.close()
    expect(ws.closed).toBe(1)
  })
})

describe('createBitgetPrivateStream — disconnect / fallback / reprime', () => {
  it('polls account REST while degraded, reprimes positions → balance → open orders on reconnect', async () => {
    const restPositions = vi.fn(() => Promise.resolve(POSITIONS))
    const restOpenOrders = vi.fn(() => Promise.resolve(OPEN_ORDERS))
    const { clock, ws, events, stream } = build({ restPositions, restOpenOrders })
    await stream.subscribe()

    ws.emit('reconnect', {})
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(1)
    expect(restOpenOrders).not.toHaveBeenCalled() // no order poll while degraded
    expect(events).toContainEqual({ type: 'PositionUpdate', symbol: 'BTC', qty: 3, side: 'long' })

    clock.advanceBy(15_000)
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(2)

    ws.emit('reconnected', {})
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(3) // the reprime snapshot
    expect(restOpenOrders).toHaveBeenCalledTimes(1) // open orders only on reprime
    expect(events).toContainEqual({ type: 'OrderUpdate', clientOrderId: CLIENT_ORDER_ID, status: 'OPEN' })

    const settled = restPositions.mock.calls.length
    clock.advanceBy(15_000 * 5)
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(settled)
  })

  it('drops the funding baseline on disconnect so no phantom credit spans the outage', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', frame('position', [positionRow({ totalFundingFee: '1.5' })])) // baseline 1.5

    ws.emit('reconnect', {})
    await flush()
    events.length = 0

    // Whatever accrued while the socket was down is REST-income truth, not a WS delta: the first
    // frame after the drop only re-primes.
    ws.emit('update', frame('position', [positionRow({ totalFundingFee: '9.5' })]))
    expect(events.filter((e) => e.type === 'FundingFeeAccrued')).toEqual([])

    // …and the next real settlement is measured against the fresh baseline.
    ws.emit('update', frame('position', [positionRow({ totalFundingFee: '10' })]))
    expect(events.filter((e) => e.type === 'FundingFeeAccrued')).toEqual([
      { type: 'FundingFeeAccrued', symbol: 'BTC', amount: 0.5, fundingTime: 1_700_000_000_000 },
    ])
  })
})

/** Drain the microtask + resolved-promise chain the REST poll schedules. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
