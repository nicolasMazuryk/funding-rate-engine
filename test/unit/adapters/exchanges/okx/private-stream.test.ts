/**
 * Unit: OKX private account stream (`11` §7). Offline against a fake credentialed
 * `WebsocketClient` + fake bus. Venue-specific focus:
 *  - `orders` rows key on `clOrdId`, which is the engine's id **re-spelled**, so the codec
 *    round-trip is part of the stream contract and a foreign key is dropped;
 *  - `positions` reports a **signed** `pos` with `posSide: 'net'` in one-way mode, where Bybit
 *    reports an absolute size plus a `Buy`/`Sell` field;
 *  - `account` gives an exact `availBal`/`frozenBal` split;
 *  - **funding fee is an inferred cash-balance delta** off `balance_and_position`
 *    (`eventType: 'funding_fee'`), because OKX ships no funding amount on any private channel
 *    — the highest-risk mapping on this venue, and the reason the REST `fundingIncome` read is
 *    the money truth here rather than a safety net.
 */

import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { toVenueClOrdId } from '../../../../../src/adapters/exchanges/okx/client-order-id.js'
import {
  accountRowToBalanceUpdates,
  balancePositionRowToFundingFee,
  createOkxPrivateStream,
  type OkxAccountRow,
  type OkxBalancePositionRow,
  type OkxOrderRow,
  type OkxPositionRow,
  type OkxPrivateWsClient,
  orderRowToOrderUpdate,
  positionRowToPositionUpdate,
} from '../../../../../src/adapters/exchanges/okx/private-stream.js'
import type { EngineEvent } from '../../../../../src/core/events/types.js'
import type { EventBus } from '../../../../../src/core/ports/bus.js'
import type { Balance, Order, Position } from '../../../../../src/core/ports/exchange-adapter.js'

const VENUE_TO_CANONICAL: Record<string, string> = { 'BTC-USDT-SWAP': 'BTC', 'XRP-USDT-SWAP': 'XRP' }
const resolveAny = (venue: string): string | undefined => VENUE_TO_CANONICAL[venue]
const now = (): number => 999

const CLIENT_ORDER_ID = 'BTC-28710000-entry-1'
const VENUE_CLORDID = toVenueClOrdId(CLIENT_ORDER_ID)

// ── Row factories (real venue shape: strings everywhere) ──────────────────────

function orderRow(over: Partial<OkxOrderRow> = {}): OkxOrderRow {
  return {
    instId: 'BTC-USDT-SWAP',
    clOrdId: VENUE_CLORDID,
    ordId: '312269865356374016',
    state: 'live',
    accFillSz: '0',
    avgPx: '',
    ...over,
  }
}

function positionRow(over: Partial<OkxPositionRow> = {}): OkxPositionRow {
  return { instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '3', avgPx: '60000', ...over }
}

function accountRow(details: OkxAccountRow['details']): OkxAccountRow {
  return { details }
}

function balPosRow(over: Partial<OkxBalancePositionRow> = {}): OkxBalancePositionRow {
  return {
    eventType: 'funding_fee',
    pTime: '1700000000000',
    balData: [{ ccy: 'USDT', cashBal: '1000' }],
    posData: [{ instId: 'BTC-USDT-SWAP' }],
    ...over,
  }
}

describe('pure mappers — orders', () => {
  it('decodes clOrdId back to the engine id, carrying no fill fields before a fill', () => {
    expect(orderRowToOrderUpdate(orderRow())).toEqual({
      type: 'OrderUpdate',
      clientOrderId: CLIENT_ORDER_ID,
      status: 'OPEN',
    })
  })

  it('carries fillPx/qty once partly filled', () => {
    expect(orderRowToOrderUpdate(orderRow({ state: 'partially_filled', accFillSz: '1', avgPx: '60010' }))).toEqual({
      type: 'OrderUpdate',
      clientOrderId: CLIENT_ORDER_ID,
      status: 'PARTIAL',
      fillPx: 60_010,
      qty: 1,
    })
  })

  it('maps both cancel states to CANCELLED, keeping the fill it did get', () => {
    expect(orderRowToOrderUpdate(orderRow({ state: 'canceled', accFillSz: '2', avgPx: '60005' }))).toMatchObject({
      status: 'CANCELLED',
      qty: 2,
      fillPx: 60_005,
    })
    expect(orderRowToOrderUpdate(orderRow({ state: 'mmp_canceled' }))).toMatchObject({ status: 'CANCELLED' })
  })

  it('drops an unknown state rather than inventing a terminal one', () => {
    expect(orderRowToOrderUpdate(orderRow({ state: 'nonsense' }))).toBeNull()
    expect(orderRowToOrderUpdate(orderRow({ state: undefined }))).toBeNull()
  })

  it("drops another bot's order: a clOrdId this codec did not produce never drives our FSM", () => {
    expect(orderRowToOrderUpdate(orderRow({ clOrdId: 'BTCxq1' }))).toBeNull()
    expect(orderRowToOrderUpdate(orderRow({ clOrdId: '' }))).toBeNull()
  })
})

describe('pure mappers — positions / account', () => {
  it('reads the direction from the sign of pos (one-way mode reports posSide: net)', () => {
    expect(positionRowToPositionUpdate(positionRow({ pos: '-0.5' }), resolveAny)).toEqual({
      type: 'PositionUpdate',
      symbol: 'BTC',
      qty: 0.5,
      side: 'short',
    })
    expect(positionRowToPositionUpdate(positionRow({ pos: '0.5' }), resolveAny)).toMatchObject({ side: 'long' })
  })

  it('honours an explicit posSide when the account is in long/short mode', () => {
    expect(positionRowToPositionUpdate(positionRow({ posSide: 'short', pos: '2' }), resolveAny)).toMatchObject({
      side: 'short',
      qty: 2,
    })
  })

  it('a flat position reads as long qty 0', () => {
    expect(positionRowToPositionUpdate(positionRow({ pos: '0' }), resolveAny)).toEqual({
      type: 'PositionUpdate',
      symbol: 'BTC',
      qty: 0,
      side: 'long',
    })
  })

  it('drops a position for an unknown symbol', () => {
    expect(positionRowToPositionUpdate(positionRow({ instId: 'DOGE-USDT-SWAP' }), resolveAny)).toBeNull()
  })

  it('maps account details with an exact free/used split (no Binance-style approximation)', () => {
    expect(
      accountRowToBalanceUpdates(
        accountRow([
          { ccy: 'USDT', cashBal: '1000', availBal: '900', frozenBal: '100' },
          { ccy: 'BTC', cashBal: '0.5', availBal: '0.5', frozenBal: '0' },
        ]),
      ),
    ).toEqual([
      { type: 'BalanceUpdate', asset: 'USDT', free: 900, used: 100 },
      { type: 'BalanceUpdate', asset: 'BTC', free: 0.5, used: 0 },
    ])
  })

  it('account: falls back availBal → availEq, and derives used from the cash balance', () => {
    expect(accountRowToBalanceUpdates(accountRow([{ ccy: 'USDT', cashBal: '10', availEq: '4' }]))).toEqual([
      { type: 'BalanceUpdate', asset: 'USDT', free: 4, used: 6 },
    ])
    expect(accountRowToBalanceUpdates(accountRow([{ ccy: 'USDT', cashBal: '10' }]))).toEqual([
      { type: 'BalanceUpdate', asset: 'USDT', free: 10, used: 0 },
    ])
  })
})

describe('pure mappers — funding fee (inferred cash delta)', () => {
  it('a credited settlement is a positive delta — already the port’s credit-positive convention', () => {
    expect(balancePositionRowToFundingFee(balPosRow(), resolveAny, 999.5, now)).toEqual({
      type: 'FundingFeeAccrued',
      symbol: 'BTC',
      amount: 0.5,
      fundingTime: 1_700_000_000_000,
    })
  })

  it('a paid settlement shrinks cashBal → negative amount, with no negation (unlike Bybit)', () => {
    expect(balancePositionRowToFundingFee(balPosRow(), resolveAny, 1_000.5, now)).toMatchObject({ amount: -0.5 })
  })

  it('publishes nothing without a baseline (first frame after connect — REST income covers it)', () => {
    expect(balancePositionRowToFundingFee(balPosRow(), resolveAny, undefined, now)).toBeNull()
  })

  it('a non-funding eventType is not a funding fee', () => {
    expect(balancePositionRowToFundingFee(balPosRow({ eventType: 'filled' }), resolveAny, 1, now)).toBeNull()
    expect(balancePositionRowToFundingFee(balPosRow({ eventType: 'snapshot' }), resolveAny, 1, now)).toBeNull()
  })

  it('refuses to attribute a settlement that touches two positions (one delta, two symbols)', () => {
    const row = balPosRow({ posData: [{ instId: 'BTC-USDT-SWAP' }, { instId: 'XRP-USDT-SWAP' }] })
    expect(balancePositionRowToFundingFee(row, resolveAny, 999.58, now)).toBeNull()
  })

  it('drops a frame whose only position is an unknown symbol', () => {
    const row = balPosRow({ posData: [{ instId: 'DOGE-USDT-SWAP' }] })
    expect(balancePositionRowToFundingFee(row, resolveAny, 999.58, now)).toBeNull()
  })

  it('publishes nothing when the settle balance did not move', () => {
    expect(balancePositionRowToFundingFee(balPosRow(), resolveAny, 1_000, now)).toBeNull()
  })

  it('reads only the settle currency — a coin-only balData yields no delta', () => {
    const row = balPosRow({ balData: [{ ccy: 'BTC', cashBal: '1' }] })
    expect(balancePositionRowToFundingFee(row, resolveAny, 999.58, now)).toBeNull()
  })
})

// ── Wired-stream harness ──────────────────────────────────────────────────────

interface FakeWs extends OkxPrivateWsClient {
  emit(event: string, arg: unknown): void
  subscribed: unknown[][]
  closed: number
}

function makeFakeWs(): FakeWs {
  const listeners = new Map<string, (arg: unknown) => void>()
  return {
    subscribed: [],
    closed: 0,
    subscribe(args) {
      this.subscribed.push(Array.isArray(args) ? args : [args])
      return [Promise.resolve()]
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
  const stream = createOkxPrivateStream({
    ws,
    bus,
    clock,
    resolveCanonical: resolveAny,
    restPositions: over?.restPositions ?? (() => Promise.resolve(POSITIONS)),
    restBalance: over?.restBalance ?? (() => Promise.resolve(BALANCE)),
    restOpenOrders: over?.restOpenOrders ?? (() => Promise.resolve(OPEN_ORDERS)),
    recordOrderSymbol: (cid, venue) => venueMap.set(cid, venue),
  })
  return { clock, ws, bus, events, stream, venueMap }
}

/** A private push frame in the venue's own envelope. */
function frame(channel: string, data: unknown[]): unknown {
  return { arg: { channel }, data }
}

describe('createOkxPrivateStream — live WS flow', () => {
  it('subscribe wires the four private channels on one connection', async () => {
    const { ws, stream } = build()
    await stream.subscribe()
    expect(ws.subscribed).toEqual([
      [
        { channel: 'orders', instType: 'ANY' },
        { channel: 'positions', instType: 'ANY' },
        { channel: 'account' },
        { channel: 'balance_and_position' },
      ],
    ])
  })

  it('an orders frame publishes OrderUpdate and records clientOrderId → instId', async () => {
    const { ws, events, stream, venueMap } = build()
    await stream.subscribe()
    ws.emit('update', frame('orders', [orderRow({ state: 'filled', accFillSz: '3', avgPx: '60000' })]))
    expect(events).toEqual([
      { type: 'OrderUpdate', clientOrderId: CLIENT_ORDER_ID, status: 'FILLED', fillPx: 60_000, qty: 3 },
    ])
    expect(venueMap.get(CLIENT_ORDER_ID)).toBe('BTC-USDT-SWAP')
  })

  it('positions / account frames fan out to their engine events', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', frame('positions', [positionRow()]))
    ws.emit('update', frame('account', [accountRow([{ ccy: 'USDT', cashBal: '1000', availBal: '900' }])]))
    expect(events).toEqual([
      { type: 'PositionUpdate', symbol: 'BTC', qty: 3, side: 'long' },
      { type: 'BalanceUpdate', asset: 'USDT', free: 900, used: 100 },
    ])
  })

  it('balance_and_position publishes only the funding fee — positions have their own channel', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    // First frame sets the baseline and publishes nothing…
    ws.emit('update', frame('balance_and_position', [balPosRow({ eventType: 'snapshot' })]))
    expect(events).toEqual([])
    // …the next funding settlement is measured against it.
    ws.emit('update', frame('balance_and_position', [balPosRow({ balData: [{ ccy: 'USDT', cashBal: '1000.5' }] })]))
    expect(events).toEqual([{ type: 'FundingFeeAccrued', symbol: 'BTC', amount: 0.5, fundingTime: 1_700_000_000_000 }])
  })

  it('the baseline advances on every frame, so one settlement is not measured against a stale trade', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', frame('balance_and_position', [balPosRow({ eventType: 'snapshot' })])) // baseline 1000
    ws.emit(
      'update',
      frame('balance_and_position', [balPosRow({ eventType: 'filled', balData: [{ ccy: 'USDT', cashBal: '900' }] })]),
    )
    ws.emit('update', frame('balance_and_position', [balPosRow({ balData: [{ ccy: 'USDT', cashBal: '900.5' }] })]))
    // 0.5, the settlement alone — not 99.5, the drift since the snapshot.
    expect(events).toEqual([{ type: 'FundingFeeAccrued', symbol: 'BTC', amount: 0.5, fundingTime: 1_700_000_000_000 }])
  })

  it('never throws into the socket lib on a malformed frame', async () => {
    const { ws, stream } = build()
    await stream.subscribe()
    expect(() => ws.emit('update', undefined)).not.toThrow()
    expect(() => ws.emit('update', { arg: { channel: 'orders' } })).not.toThrow()
    expect(() => ws.emit('update', frame('greeks', []))).not.toThrow()
    expect(() => ws.emit('update', { event: 'subscribe', arg: { channel: 'orders' } })).not.toThrow()
  })

  it('close() closes the socket', async () => {
    const { ws, stream } = build()
    await stream.close()
    expect(ws.closed).toBe(1)
  })
})

describe('createOkxPrivateStream — disconnect / fallback / reprime', () => {
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

  it('drops the cash baseline on disconnect so no phantom credit spans the outage', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', frame('balance_and_position', [balPosRow({ eventType: 'snapshot' })])) // baseline 1000

    ws.emit('reconnect', {})
    await flush()
    events.length = 0

    // A settlement arriving right after the drop has no trustworthy baseline → nothing published.
    ws.emit('update', frame('balance_and_position', [balPosRow({ balData: [{ ccy: 'USDT', cashBal: '1500' }] })]))
    expect(events.filter((e) => e.type === 'FundingFeeAccrued')).toEqual([])
  })
})

/** Drain the microtask + resolved-promise chain the REST poll schedules. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
