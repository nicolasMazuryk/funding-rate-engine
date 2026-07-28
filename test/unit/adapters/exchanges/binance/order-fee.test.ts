/**
 * Unit: Binance's realized-fee read (task 0470 §6).
 *
 * Binance is the only one of the five venues whose order endpoint reports **no commission at
 * all** — the live `fill-test` run filled an ADA order and `getOrder` came back with `fee:
 * undefined`, which leaves the fills dimension of reconciliation (`15` §2) with nothing to
 * compare. The fee lives on `fapi/v1/userTrades`, so a terminal order is topped up from there.
 *
 * What these pin down: the extra read happens only for a (partly) filled order that is missing
 * a fee, it sums every execution of *that* order, and a failure to read it degrades to the old
 * fee-less order rather than failing the fill-poll.
 */

import type { Order, Trade } from 'ccxt'
import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { createBinanceAdapter } from '../../../../../src/adapters/exchanges/binance/adapter.js'
import type { BinanceMarketClient } from '../../../../../src/adapters/exchanges/binance/factory.js'
import type {
  BinanceRestOrderClient,
  BinanceWsOrderClient,
} from '../../../../../src/adapters/exchanges/binance/ws-orders.js'
import { createEventBus } from '../../../../../src/core/events/bus.js'
import type { ExchangeAdapter } from '../../../../../src/core/ports/exchange-adapter.js'
import { loadMarkets } from './fixtures.js'

const CLIENT_ORDER_ID = 'BTC-1-entry-1'
const VENUE_ORDER_ID = '77'

/** A ccxt order that filled — exactly as Binance reports it: no `fee` field anywhere. */
function filledOrder(): Order {
  return {
    clientOrderId: CLIENT_ORDER_ID,
    id: VENUE_ORDER_ID,
    symbol: 'BTC/USDT:USDT',
    info: { symbol: 'BTCUSDT' },
    side: 'buy',
    type: 'limit',
    status: 'closed',
    average: 20_000,
    filled: 0.003,
  } as unknown as Order
}

function trade(order: string, cost: number | undefined): Trade {
  return { order, fee: cost === undefined ? undefined : { cost, currency: 'USDT' } } as unknown as Trade
}

/**
 * A wired adapter whose order map knows `CLIENT_ORDER_ID` — the map is populated at submit, so
 * the order path is wired with fakes and one order is placed before the fill-poll.
 */
async function adapterWithSubmittedOrder(over: Partial<BinanceMarketClient>): Promise<ExchangeAdapter> {
  const clock = createVirtualClock(0)
  const bus = createEventBus()
  const client: BinanceMarketClient = {
    loadMarkets: () => Promise.resolve(loadMarkets(['clean-perp-btc'])),
    setLeverage: () => Promise.resolve({}),
    setMarginMode: () => Promise.resolve({}),
    setPositionMode: () => Promise.resolve({}),
    fetchFundingRate: () => Promise.reject(new Error('unused')),
    fetchFundingRateHistory: () => Promise.resolve([]),
    fetchFundingRates: () => Promise.resolve({}),
    fetchFundingIntervals: () => Promise.resolve({}),
    fetchTicker: () => Promise.reject(new Error('unused')),
    fetchPositions: () => Promise.resolve([]),
    fetchBalance: () => Promise.reject(new Error('unused')),
    fetchOrder: () => Promise.resolve(filledOrder()),
    fetchOpenOrders: () => Promise.resolve([]),
    fetchMyTrades: () => Promise.resolve([]),
    fetchFundingHistory: () => Promise.resolve([]),
    ...over,
  }
  const wsApiPrivate: BinanceWsOrderClient = {
    submitNewFuturesOrder: () =>
      Promise.resolve({ result: { orderId: Number(VENUE_ORDER_ID), clientOrderId: CLIENT_ORDER_ID } } as never),
    cancelFuturesOrder: () => Promise.resolve({ result: {} } as never),
  }
  const restOrders: BinanceRestOrderClient = { submitNewOrder: () => Promise.resolve({ orderId: 2 } as never) }

  const adapter = createBinanceAdapter({ client, clock, bus, wsApiPrivate, restOrders })
  await adapter.init()
  await adapter.placeOrder({
    symbol: 'BTC',
    side: 'long',
    type: 'limit',
    qty: 0.003,
    price: 20_000,
    clientOrderId: CLIENT_ORDER_ID,
  })
  return adapter
}

describe('binance getOrder — realized fee from userTrades (0470 §6)', () => {
  it('sums the fee over every execution of that order', async () => {
    const adapter = await adapterWithSubmittedOrder({
      fetchMyTrades: () =>
        Promise.resolve([trade(VENUE_ORDER_ID, 0.004), trade(VENUE_ORDER_ID, 0.002), trade('99', 9)]),
    })

    const order = await adapter.getOrder(CLIENT_ORDER_ID)

    expect(order.status).toBe('FILLED')
    expect(order.fee).toBeCloseTo(0.006, 10)
  })

  it('queries the venue for that order id only, and only once the order has filled', async () => {
    const fetchMyTrades = vi.fn(() => Promise.resolve([trade(VENUE_ORDER_ID, 0.004)]))
    const adapter = await adapterWithSubmittedOrder({ fetchMyTrades })

    await adapter.getOrder(CLIENT_ORDER_ID)

    expect(fetchMyTrades).toHaveBeenCalledTimes(1)
    expect(fetchMyTrades).toHaveBeenCalledWith('BTCUSDT', undefined, undefined, { orderId: VENUE_ORDER_ID })
  })

  it('leaves a resting order alone — no fee, no extra read', async () => {
    const fetchMyTrades = vi.fn(() => Promise.resolve([]))
    const adapter = await adapterWithSubmittedOrder({
      fetchOrder: () =>
        Promise.resolve({ ...filledOrder(), status: 'open', filled: 0, average: undefined } as unknown as Order),
      fetchMyTrades,
    })

    const order = await adapter.getOrder(CLIENT_ORDER_ID)

    expect(order.status).toBe('OPEN')
    expect(order.fee).toBeUndefined()
    expect(fetchMyTrades).not.toHaveBeenCalled()
  })

  it('degrades to a fee-less order when the trades read fails — the fill-poll still succeeds', async () => {
    const adapter = await adapterWithSubmittedOrder({
      fetchMyTrades: () => Promise.reject(new Error('userTrades unavailable')),
    })

    const order = await adapter.getOrder(CLIENT_ORDER_ID)

    expect(order.status).toBe('FILLED')
    expect(order.fee).toBeUndefined()
  })
})
