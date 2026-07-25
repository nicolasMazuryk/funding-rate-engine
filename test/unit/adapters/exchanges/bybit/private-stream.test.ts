/**
 * Unit: Bybit private account stream (`11` §7). Offline against a fake credentialed
 * `WebsocketClient` + fake bus. Venue-specific focus:
 *  - `order` rows key on `orderLinkId` (our `clientOrderId`) and drop the conditional-order
 *    lifecycle statuses rather than inventing a terminal state;
 *  - `wallet` rows give an **exact** free/used split (`availableToWithdraw`/`walletBalance`),
 *    unlike Binance's approximation;
 *  - `execution` rows with `execType: 'Funding'` become `FundingFeeAccrued` with the sign
 *    flipped (`execFee` is the charge, the port wants credit-positive).
 */

import type { WSAccountOrderV5, WSExecutionV5, WSPositionV5, WSWalletV5 } from 'bybit-api'
import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import {
  type BybitPrivateWsClient,
  createBybitPrivateStream,
  executionRowToFundingFee,
  orderRowToOrderUpdate,
  positionRowToPositionUpdate,
  walletRowToBalanceUpdates,
} from '../../../../../src/adapters/exchanges/bybit/private-stream.js'
import type { EngineEvent } from '../../../../../src/core/events/types.js'
import type { EventBus } from '../../../../../src/core/ports/bus.js'
import type { Balance, Order, Position } from '../../../../../src/core/ports/exchange-adapter.js'

const VENUE_TO_CANONICAL: Record<string, string> = { BTCUSDT: 'BTC', '1000PEPEUSDT': 'PEPE' }
const resolveAny = (venue: string): string | undefined => VENUE_TO_CANONICAL[venue]
const now = (): number => 999

// ── Row factories (real venue shape: strings everywhere) ──────────────────────

function orderRow(overrides: Partial<WSAccountOrderV5> = {}): WSAccountOrderV5 {
  return {
    category: 'linear',
    orderId: 'ff-1',
    orderLinkId: 'BTC-1-entry-1',
    symbol: 'BTCUSDT',
    price: '60000',
    qty: '0.003',
    side: 'Buy',
    orderStatus: 'New',
    cumExecQty: '0',
    cumExecValue: '0',
    cumExecFee: '0',
    avgPrice: '0',
    reduceOnly: false,
    orderType: 'Limit',
    timeInForce: 'GTC',
    createdTime: '1700000000000',
    updatedTime: '1700000000001',
    ...overrides,
  } as WSAccountOrderV5
}

function positionRow(overrides: Partial<WSPositionV5> = {}): WSPositionV5 {
  return {
    category: 'linear',
    symbol: 'BTCUSDT',
    side: 'Buy',
    size: '0.003',
    entryPrice: '60000',
    ...overrides,
  } as WSPositionV5
}

function walletRow(coins: Array<Record<string, string>>): WSWalletV5 {
  return { accountType: 'UNIFIED', coin: coins } as unknown as WSWalletV5
}

function executionRow(overrides: Partial<WSExecutionV5> = {}): WSExecutionV5 {
  return {
    category: 'linear',
    symbol: 'BTCUSDT',
    orderId: 'ff-1',
    orderLinkId: '',
    side: 'Buy',
    execType: 'Funding',
    execFee: '-0.42', // negative charge = a credit received
    execQty: '0.003',
    execPrice: '60000',
    execTime: '1700000000000',
    ...overrides,
  } as WSExecutionV5
}

describe('pure mappers', () => {
  it('maps an order row via orderLinkId, carrying no fill fields before a fill', () => {
    expect(orderRowToOrderUpdate(orderRow())).toEqual({
      type: 'OrderUpdate',
      clientOrderId: 'BTC-1-entry-1',
      status: 'OPEN',
    })
  })

  it('carries fillPx/qty once partly filled', () => {
    const update = orderRowToOrderUpdate(
      orderRow({ orderStatus: 'PartiallyFilled', cumExecQty: '0.001', avgPrice: '60010' }),
    )
    expect(update).toEqual({
      type: 'OrderUpdate',
      clientOrderId: 'BTC-1-entry-1',
      status: 'PARTIAL',
      fillPx: 60_010,
      qty: 0.001,
    })
  })

  it('a rejection carries errorKind + the venue rejectReason', () => {
    const update = orderRowToOrderUpdate(
      orderRow({ orderStatus: 'Rejected', rejectReason: 'EC_PostOnlyWillTakeLiquidity' }),
    )
    expect(update).toMatchObject({
      status: 'REJECTED',
      errorKind: 'OrderRejected',
      reason: 'EC_PostOnlyWillTakeLiquidity',
    })
  })

  it('PartiallyFilledCanceled is terminal → CANCELLED with the fill it did get', () => {
    const update = orderRowToOrderUpdate(
      orderRow({ orderStatus: 'PartiallyFilledCanceled', cumExecQty: '0.002', avgPrice: '60005' }),
    )
    expect(update).toMatchObject({ status: 'CANCELLED', qty: 0.002, fillPx: 60_005 })
  })

  it('drops the conditional-order lifecycle statuses (no engine analogue, never a bogus state)', () => {
    for (const orderStatus of ['Untriggered', 'Triggered', 'Active'] as const) {
      expect(orderRowToOrderUpdate(orderRow({ orderStatus }))).toBeNull()
    }
    expect(orderRowToOrderUpdate(orderRow({ orderStatus: 'Nonsense' as never }))).toBeNull()
  })

  it('maps a position row (absolute size + Buy/Sell side)', () => {
    expect(positionRowToPositionUpdate(positionRow({ side: 'Sell', size: '0.5' }), resolveAny)).toEqual({
      type: 'PositionUpdate',
      symbol: 'BTC',
      qty: 0.5,
      side: 'short',
    })
  })

  it('a flat position (empty side, zero size) reads as long qty 0', () => {
    expect(positionRowToPositionUpdate(positionRow({ side: '' as never, size: '0' }), resolveAny)).toEqual({
      type: 'PositionUpdate',
      symbol: 'BTC',
      qty: 0,
      side: 'long',
    })
  })

  it('drops a position for an unknown symbol', () => {
    expect(positionRowToPositionUpdate(positionRow({ symbol: 'DOGEUSDT' }), resolveAny)).toBeNull()
  })

  it('maps wallet coins with an exact free/used split (no Binance-style approximation)', () => {
    const updates = walletRowToBalanceUpdates(
      walletRow([
        { coin: 'USDT', walletBalance: '1000', availableToWithdraw: '900' },
        { coin: 'BTC', walletBalance: '0.5', availableToWithdraw: '0.5' },
      ]),
    )
    expect(updates).toEqual([
      { type: 'BalanceUpdate', asset: 'USDT', free: 900, used: 100 },
      { type: 'BalanceUpdate', asset: 'BTC', free: 0.5, used: 0 },
    ])
  })

  it('wallet: an absent availableToWithdraw falls back to free, then to the wallet balance', () => {
    expect(walletRowToBalanceUpdates(walletRow([{ coin: 'USDT', walletBalance: '10', free: '4' }]))).toEqual([
      { type: 'BalanceUpdate', asset: 'USDT', free: 4, used: 6 },
    ])
    expect(walletRowToBalanceUpdates(walletRow([{ coin: 'USDT', walletBalance: '10' }]))).toEqual([
      { type: 'BalanceUpdate', asset: 'USDT', free: 10, used: 0 },
    ])
  })

  it("execType 'Funding' → FundingFeeAccrued with the sign flipped (execFee is the charge)", () => {
    expect(executionRowToFundingFee(executionRow({ execFee: '-0.42' }), resolveAny, now)).toEqual({
      type: 'FundingFeeAccrued',
      symbol: 'BTC',
      amount: 0.42, // received
      fundingTime: 1_700_000_000_000,
    })
    expect(executionRowToFundingFee(executionRow({ execFee: '0.42' }), resolveAny, now)).toMatchObject({
      amount: -0.42, // paid
    })
  })

  it('a plain trade execution is not a funding fee', () => {
    expect(executionRowToFundingFee(executionRow({ execType: 'Trade' }), resolveAny, now)).toBeNull()
  })
})

// ── Wired-stream harness ──────────────────────────────────────────────────────

interface FakeWs extends BybitPrivateWsClient {
  emit(event: string, arg: unknown): void
  subscribed: string[][]
  closed: number
}

function makeFakeWs(): FakeWs {
  const listeners = new Map<string, (arg: unknown) => void>()
  return {
    subscribed: [],
    closed: 0,
    subscribeV5(topics) {
      this.subscribed.push(Array.isArray(topics) ? topics : [topics])
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

const POSITIONS: Position[] = [{ symbol: 'BTC', side: 'long', qty: 0.003, entryPrice: 60_000 }]
const BALANCE: Balance = { asset: 'USDT', free: 900, used: 100 }
const OPEN_ORDERS: Order[] = [
  { clientOrderId: 'BTC-1-entry-1', symbol: 'BTC', side: 'long', type: 'limit', status: 'OPEN' },
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
  const stream = createBybitPrivateStream({
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

describe('createBybitPrivateStream — live WS flow', () => {
  it('subscribe wires the four private topics on one connection', async () => {
    const { ws, stream } = build()
    await stream.subscribe()
    expect(ws.subscribed).toEqual([['order', 'execution', 'position', 'wallet']])
  })

  it('an order frame publishes OrderUpdate and records clientOrderId → venueSymbol', async () => {
    const { ws, events, stream, venueMap } = build()
    await stream.subscribe()
    ws.emit('update', {
      topic: 'order',
      creationTime: 1,
      data: [orderRow({ orderStatus: 'Filled', cumExecQty: '0.003', avgPrice: '60000' })],
    })
    expect(events).toEqual([
      { type: 'OrderUpdate', clientOrderId: 'BTC-1-entry-1', status: 'FILLED', fillPx: 60_000, qty: 0.003 },
    ])
    expect(venueMap.get('BTC-1-entry-1')).toBe('BTCUSDT')
  })

  it('position / wallet / funding-execution frames each fan out to their engine events', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe()
    ws.emit('update', { topic: 'position', data: [positionRow()] })
    ws.emit('update', {
      topic: 'wallet',
      data: [walletRow([{ coin: 'USDT', walletBalance: '1000', availableToWithdraw: '900' }])],
    })
    ws.emit('update', { topic: 'execution', data: [executionRow()] })
    expect(events).toEqual([
      { type: 'PositionUpdate', symbol: 'BTC', qty: 0.003, side: 'long' },
      { type: 'BalanceUpdate', asset: 'USDT', free: 900, used: 100 },
      { type: 'FundingFeeAccrued', symbol: 'BTC', amount: 0.42, fundingTime: 1_700_000_000_000 },
    ])
  })

  it('never throws into the socket lib on a malformed frame', async () => {
    const { ws, stream } = build()
    await stream.subscribe()
    expect(() => ws.emit('update', undefined)).not.toThrow()
    expect(() => ws.emit('update', { topic: 'order' })).not.toThrow()
    expect(() => ws.emit('update', { topic: 'greeks', data: [] })).not.toThrow()
  })

  it('close() closes the socket', async () => {
    const { ws, stream } = build()
    await stream.close()
    expect(ws.closed).toBe(1)
  })
})

describe('createBybitPrivateStream — disconnect / fallback / reprime', () => {
  it('polls account REST while degraded, reprimes positions → balance → open orders on reconnect', async () => {
    const restPositions = vi.fn(() => Promise.resolve(POSITIONS))
    const restOpenOrders = vi.fn(() => Promise.resolve(OPEN_ORDERS))
    const { clock, ws, events, stream } = build({ restPositions, restOpenOrders })
    await stream.subscribe()

    ws.emit('reconnect', {})
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(1)
    expect(restOpenOrders).not.toHaveBeenCalled() // no order poll while degraded
    expect(events).toContainEqual({ type: 'PositionUpdate', symbol: 'BTC', qty: 0.003, side: 'long' })

    clock.advanceBy(15_000)
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(2)

    ws.emit('reconnected', {})
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(3) // the reprime snapshot
    expect(restOpenOrders).toHaveBeenCalledTimes(1) // open orders only on reprime
    expect(events).toContainEqual({ type: 'OrderUpdate', clientOrderId: 'BTC-1-entry-1', status: 'OPEN' })

    const settled = restPositions.mock.calls.length
    clock.advanceBy(15_000 * 5)
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(settled)
  })
})

/** Drain the microtask + resolved-promise chain the REST poll schedules. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
