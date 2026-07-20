import type {
  WsAccountUpdatedBalance,
  WsMessageFuturesUserDataAccountUpdateFormatted,
  WsMessageFuturesUserDataTradeUpdateEventFormatted,
  WsUpdatedPosition,
} from 'binance'
import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import {
  accountUpdateToEvents,
  type BinancePrivateWsClient,
  createBinancePrivateStream,
  orderTradeUpdateToOrderUpdate,
} from '../../../../../src/adapters/exchanges/binance/private-stream.js'
import type { EngineEvent } from '../../../../../src/core/events/types.js'
import type { EventBus } from '../../../../../src/core/ports/bus.js'
import type { Balance, Order, Position } from '../../../../../src/core/ports/exchange-adapter.js'

// ── Synthetic lib-typed fixtures (capture tool is 0250; inline until then) ────

function orderTradeUpdate(
  order: Partial<WsMessageFuturesUserDataTradeUpdateEventFormatted['order']>,
): WsMessageFuturesUserDataTradeUpdateEventFormatted {
  return {
    wsMarket: 'usdm',
    wsKey: 'usdm',
    streamName: 'usdm',
    eventType: 'ORDER_TRADE_UPDATE',
    eventTime: 1_700_000_000_000,
    transactionTime: 1_700_000_000_010,
    order: {
      symbol: 'BTCUSDT',
      clientOrderId: 'o1',
      orderSide: 'BUY',
      orderType: 'LIMIT',
      orderStatus: 'NEW',
      averagePrice: 0,
      orderFilledAccumulatedQuantity: 0,
      lastFilledPrice: 0,
      ...order,
    },
  } as WsMessageFuturesUserDataTradeUpdateEventFormatted
}

function accountUpdate(
  updateData: Partial<WsMessageFuturesUserDataAccountUpdateFormatted['updateData']>,
  overrides: Partial<WsMessageFuturesUserDataAccountUpdateFormatted> = {},
): WsMessageFuturesUserDataAccountUpdateFormatted {
  return {
    wsMarket: 'usdm',
    wsKey: 'usdm',
    streamName: 'usdm',
    eventType: 'ACCOUNT_UPDATE',
    eventTime: 1_700_000_000_000,
    transactionTime: 1_700_000_000_500,
    updateData: { updateEventType: 'ORDER', updatedBalances: [], updatedPositions: [], ...updateData },
    ...overrides,
  } as WsMessageFuturesUserDataAccountUpdateFormatted
}

function position(over: Partial<WsUpdatedPosition>): WsUpdatedPosition {
  return {
    symbol: 'BTCUSDT',
    marginAsset: 'USDT',
    positionAmount: 2,
    entryPrice: 60_000,
    accumulatedRealisedPreFee: 0,
    unrealisedPnl: 0,
    marginType: 'isolated',
    isolatedWalletAmount: 0,
    positionSide: 'BOTH',
    ...over,
  }
}

function balance(over: Partial<WsAccountUpdatedBalance>): WsAccountUpdatedBalance {
  return { asset: 'USDT', balanceChange: 0, crossWalletBalance: 1_000, walletBalance: 1_000, ...over }
}

const VENUE_TO_CANONICAL: Record<string, string> = { BTCUSDT: 'BTC', '1000PEPEUSDT': 'PEPE' }
const resolveAny = (venue: string): string | undefined => VENUE_TO_CANONICAL[venue]

describe('pure mappers — orderTradeUpdateToOrderUpdate', () => {
  it('maps a full fill (FILLED, average fill price, cumulative qty)', () => {
    const update = orderTradeUpdateToOrderUpdate(
      orderTradeUpdate({ orderStatus: 'FILLED', averagePrice: 60_050, orderFilledAccumulatedQuantity: 2 }),
    )
    expect(update).toEqual({ type: 'OrderUpdate', clientOrderId: 'o1', status: 'FILLED', fillPx: 60_050, qty: 2 })
  })

  it('maps a partial fill (PARTIAL, carries the partial fill px/qty)', () => {
    const update = orderTradeUpdateToOrderUpdate(
      orderTradeUpdate({ orderStatus: 'PARTIALLY_FILLED', averagePrice: 60_000, orderFilledAccumulatedQuantity: 1 }),
    )
    expect(update).toEqual({ type: 'OrderUpdate', clientOrderId: 'o1', status: 'PARTIAL', fillPx: 60_000, qty: 1 })
  })

  it('maps NEW → OPEN with no fill fields', () => {
    expect(orderTradeUpdateToOrderUpdate(orderTradeUpdate({ orderStatus: 'NEW' }))).toEqual({
      type: 'OrderUpdate',
      clientOrderId: 'o1',
      status: 'OPEN',
    })
  })

  it('maps a reject → REJECTED with errorKind + venue reason', () => {
    const update = orderTradeUpdateToOrderUpdate(
      orderTradeUpdate({ orderStatus: 'REJECTED', orderExpireReason: 'insufficient margin' }),
    )
    expect(update).toEqual({
      type: 'OrderUpdate',
      clientOrderId: 'o1',
      status: 'REJECTED',
      errorKind: 'OrderRejected',
      reason: 'insufficient margin',
    })
  })

  it('maps CANCELED → CANCELLED and EXPIRED → EXPIRED', () => {
    expect(orderTradeUpdateToOrderUpdate(orderTradeUpdate({ orderStatus: 'CANCELED' }))?.status).toBe('CANCELLED')
    expect(orderTradeUpdateToOrderUpdate(orderTradeUpdate({ orderStatus: 'EXPIRED' }))?.status).toBe('EXPIRED')
  })

  it('returns null for a status with no engine analogue (PENDING_CANCEL)', () => {
    expect(orderTradeUpdateToOrderUpdate(orderTradeUpdate({ orderStatus: 'PENDING_CANCEL' }))).toBeNull()
  })
})

describe('pure mappers — accountUpdateToEvents', () => {
  it('emits a PositionUpdate per resolved position (abs qty, signed side)', () => {
    const events = accountUpdateToEvents(
      accountUpdate({ updatedPositions: [position({ positionAmount: -3 })] }),
      resolveAny,
    )
    expect(events).toEqual([{ type: 'PositionUpdate', symbol: 'BTC', qty: 3, side: 'short' }])
  })

  it('skips a position whose venue symbol does not resolve', () => {
    const events = accountUpdateToEvents(
      accountUpdate({ updatedPositions: [position({ symbol: 'DOGEUSDT' })] }),
      resolveAny,
    )
    expect(events).toEqual([])
  })

  it('decomposes a BalanceUpdate: free = crossWallet, used = max(0, wallet − crossWallet)', () => {
    const events = accountUpdateToEvents(
      accountUpdate({ updatedBalances: [balance({ crossWalletBalance: 800, walletBalance: 1_000 })] }),
      resolveAny,
    )
    expect(events).toEqual([{ type: 'BalanceUpdate', asset: 'USDT', free: 800, used: 200 }])
  })

  it('FUNDING_FEE → FundingFeeAccrued with signed amount + fundingTime to the ms', () => {
    const events = accountUpdateToEvents(
      accountUpdate(
        {
          updateEventType: 'FUNDING_FEE',
          updatedPositions: [position({})],
          updatedBalances: [balance({ balanceChange: -0.0123, crossWalletBalance: 999.9877, walletBalance: 999.9877 })],
        },
        { transactionTime: 1_700_000_007_777 },
      ),
      resolveAny,
    )
    expect(events).toContainEqual({
      type: 'FundingFeeAccrued',
      symbol: 'BTC',
      amount: -0.0123,
      fundingTime: 1_700_000_007_777,
    })
  })

  it('emits positions, then balances, then funding-fee in order', () => {
    const events = accountUpdateToEvents(
      accountUpdate({
        updateEventType: 'FUNDING_FEE',
        updatedPositions: [position({})],
        updatedBalances: [balance({ balanceChange: 0.5 })],
      }),
      resolveAny,
    )
    expect(events.map((e) => e.type)).toEqual(['PositionUpdate', 'BalanceUpdate', 'FundingFeeAccrued'])
  })
})

// ── Wired-stream harness (fake ws emitter + fake bus) ─────────────────────────

interface FakeWs extends BinancePrivateWsClient {
  emit(event: string, arg: unknown): void
  subscribed: number
  closed: number
}

function makeFakeWs(): FakeWs {
  const listeners = new Map<string, (arg: unknown) => void>()
  return {
    subscribed: 0,
    closed: 0,
    subscribeUsdFuturesUserDataStream() {
      this.subscribed += 1
      return Promise.resolve(undefined)
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

function build(overrides?: {
  restPositions?: () => Promise<Position[]>
  restBalance?: () => Promise<Balance>
  restOpenOrders?: () => Promise<Order[]>
  recordOrderSymbol?: (clientOrderId: string, venueSymbol: string) => void
}) {
  const clock = createVirtualClock(0)
  const ws = makeFakeWs()
  const { bus, events } = makeBus()
  const stream = createBinancePrivateStream({
    ws,
    bus,
    clock,
    resolveCanonical: resolveAny,
    restPositions: overrides?.restPositions ?? (() => Promise.resolve([])),
    restBalance: overrides?.restBalance ?? (() => Promise.resolve({ asset: 'USDT', free: 100, used: 0 })),
    restOpenOrders: overrides?.restOpenOrders ?? (() => Promise.resolve([])),
    recordOrderSymbol: overrides?.recordOrderSymbol ?? (() => {}),
  })
  return { clock, ws, bus, events, stream }
}

describe('createBinancePrivateStream — live WS flow', () => {
  it('subscribe opens the USD-M user-data stream', async () => {
    const { ws, stream } = build()
    await stream.subscribe()
    expect(ws.subscribed).toBe(1)
  })

  it('an ORDER_TRADE_UPDATE publishes the mapped OrderUpdate and records the symbol', () => {
    const recordOrderSymbol = vi.fn()
    const { ws, events } = build({ recordOrderSymbol })
    ws.emit(
      'formattedUserDataMessage',
      orderTradeUpdate({ orderStatus: 'FILLED', averagePrice: 60_000, orderFilledAccumulatedQuantity: 1 }),
    )
    expect(events).toEqual([{ type: 'OrderUpdate', clientOrderId: 'o1', status: 'FILLED', fillPx: 60_000, qty: 1 }])
    expect(recordOrderSymbol).toHaveBeenCalledWith('o1', 'BTCUSDT')
  })

  it('an ACCOUNT_UPDATE fans out position + balance events', () => {
    const { ws, events } = build()
    ws.emit(
      'formattedUserDataMessage',
      accountUpdate({
        updatedPositions: [position({ positionAmount: 2 })],
        updatedBalances: [balance({ crossWalletBalance: 500, walletBalance: 500 })],
      }),
    )
    expect(events).toEqual([
      { type: 'PositionUpdate', symbol: 'BTC', qty: 2, side: 'long' },
      { type: 'BalanceUpdate', asset: 'USDT', free: 500, used: 0 },
    ])
  })

  it('tolerates duplicate delivery — publishes each, never throws', () => {
    const { ws, events } = build()
    const msg = orderTradeUpdate({ orderStatus: 'FILLED', averagePrice: 1, orderFilledAccumulatedQuantity: 1 })
    expect(() => {
      ws.emit('formattedUserDataMessage', msg)
      ws.emit('formattedUserDataMessage', msg)
    }).not.toThrow()
    expect(events).toHaveLength(2)
  })

  it('never throws into the socket lib on a malformed message', () => {
    const { ws } = build()
    expect(() => ws.emit('formattedUserDataMessage', undefined)).not.toThrow()
    expect(() => ws.emit('formattedUserDataMessage', { eventType: 'listenKeyExpired' })).not.toThrow()
  })

  it('close() closes the socket', async () => {
    const { ws, stream } = build()
    await stream.close()
    expect(ws.closed).toBe(1)
  })
})

describe('createBinancePrivateStream — disconnect / fallback / reprime', () => {
  it('polls positions+balance while degraded, then reprimes positions → balance → open orders before resume', async () => {
    const order: string[] = []
    const restPositions = vi.fn(() => {
      order.push('positions')
      return Promise.resolve<Position[]>([{ symbol: 'BTC', side: 'long', qty: 1 }])
    })
    const restBalance = vi.fn(() => {
      order.push('balance')
      return Promise.resolve<Balance>({ asset: 'USDT', free: 100, used: 0 })
    })
    const restOpenOrders = vi.fn(() => {
      order.push('open-orders')
      return Promise.resolve<Order[]>([
        { clientOrderId: 'o9', symbol: 'BTC', side: 'long', type: 'limit', status: 'OPEN' },
      ])
    })
    const { clock, ws, events } = build({ restPositions, restBalance, restOpenOrders })

    // Disconnect → degraded: one immediate poll of positions + balance (NO open-orders poll).
    ws.emit('reconnecting', {})
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(1)
    expect(restBalance).toHaveBeenCalledTimes(1)
    expect(restOpenOrders).toHaveBeenCalledTimes(0)

    // Poll self-reschedules on the virtual clock while still degraded.
    clock.advanceBy(15_000)
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(2)

    // Reconnect → reprime: one more positions+balance snapshot AND open orders, in order.
    order.length = 0
    ws.emit('reconnected', {})
    await flush()
    expect(order).toEqual(['positions', 'balance', 'open-orders'])
    expect(restOpenOrders).toHaveBeenCalledTimes(1)

    // Once live, the fallback poll no longer fires on further clock advances.
    const positionsAfterReprime = restPositions.mock.calls.length
    clock.advanceBy(15_000 * 5)
    await flush()
    expect(restPositions).toHaveBeenCalledTimes(positionsAfterReprime)

    // The open-orders reprime published an OrderUpdate for the resting order.
    expect(events).toContainEqual({ type: 'OrderUpdate', clientOrderId: 'o9', status: 'OPEN' })
  })
})

/** Drain the microtask + resolved-promise chain the REST poll schedules. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
