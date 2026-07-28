/**
 * Unit: the venue-native **cancel sweeps** and their shared {@link cancelEach} driver
 * (task 0470 phase 3).
 *
 * `cancelEach`'s contract is the load-bearing one: a venue reject on one order must not strand
 * the orders behind it, because each stranded order is real money resting on a real book.
 *
 * The five venue wrappers are covered against stub clients for wiring only — that each reads
 * open orders **account-wide** and cancels by the **venue's own order id** (never a client id
 * this process may not have minted). Real behaviour is proven by the live runs (phase 5).
 */

import { describe, expect, it } from 'vitest'
import type { BinanceClients } from '../../../src/adapters/exchanges/binance/factory.js'
import type { BitgetClients } from '../../../src/adapters/exchanges/bitget/factory.js'
import type { BybitClients } from '../../../src/adapters/exchanges/bybit/factory.js'
import type { KucoinClients } from '../../../src/adapters/exchanges/kucoin/factory.js'
import type { OkxClients } from '../../../src/adapters/exchanges/okx/factory.js'
import { createBinanceCancelSweep } from '../../../src/live/binance/cancel-sweep.js'
import { createBitgetCancelSweep } from '../../../src/live/bitget/cancel-sweep.js'
import { createBybitCancelSweep } from '../../../src/live/bybit/cancel-sweep.js'
import { createKucoinCancelSweep } from '../../../src/live/kucoin/cancel-sweep.js'
import { createOkxCancelSweep } from '../../../src/live/okx/cancel-sweep.js'
import { cancelEach } from '../../../src/live/sweep.js'

describe('cancelEach (0470 phase 3)', () => {
  it('cancels every row and returns their labels', async () => {
    const cancelled: string[] = []

    const labels = await cancelEach(
      [{ id: 'a' }, { id: 'b' }],
      (r) => r.id,
      (r) => Promise.resolve(cancelled.push(r.id)),
    )

    expect(cancelled).toEqual(['a', 'b'])
    expect(labels).toEqual(['a', 'b'])
  })

  it('does not short-circuit on a reject — later orders are still cancelled', async () => {
    const cancelled: string[] = []

    const sweep = cancelEach(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      (r) => r.id,
      (r) => (r.id === 'a' ? Promise.reject(new Error('too late to cancel')) : Promise.resolve(cancelled.push(r.id))),
    )

    // The aggregate throw names both sides so teardown's `errors[]` is self-explaining.
    await expect(sweep).rejects.toThrow(/1 of 3 orders could not be cancelled.*too late.*cancelled \[b, c\]/s)
    expect(cancelled).toEqual(['b', 'c'])
  })
})

describe('venue cancel sweeps (0470 phase 3)', () => {
  it('binance: account-wide open orders, cancelled by orderId', async () => {
    const calls: unknown[] = []
    const clients = {
      native: {
        getAllOpenOrders: (params?: unknown) => {
          calls.push(['read', params])
          return Promise.resolve([{ symbol: 'BTCUSDT', orderId: 42 }])
        },
        cancelOrder: (params: unknown) => {
          calls.push(['cancel', params])
          return Promise.resolve({})
        },
      },
    } as unknown as Pick<BinanceClients, 'native'>

    expect(await createBinanceCancelSweep(clients)()).toEqual(['BTCUSDT#42'])
    expect(calls).toEqual([
      ['read', undefined],
      ['cancel', { symbol: 'BTCUSDT', orderId: 42 }],
    ])
  })

  it('bybit: linear/USDT-settled open orders, cancelled by orderId', async () => {
    const calls: unknown[] = []
    const clients = {
      native: {
        getActiveOrders: (params: unknown) => {
          calls.push(['read', params])
          return Promise.resolve({ result: { list: [{ symbol: 'BTCUSDT', orderId: 'o-1' }] } })
        },
        cancelOrder: (params: unknown) => {
          calls.push(['cancel', params])
          return Promise.resolve({})
        },
      },
    } as unknown as Pick<BybitClients, 'native'>

    expect(await createBybitCancelSweep(clients)()).toEqual(['BTCUSDT#o-1'])
    expect(calls).toEqual([
      ['read', { category: 'linear', settleCoin: 'USDT' }],
      ['cancel', { category: 'linear', symbol: 'BTCUSDT', orderId: 'o-1' }],
    ])
  })

  it('okx: SWAP open orders, cancelled by ordId', async () => {
    const calls: unknown[] = []
    const clients = {
      native: {
        getOrderList: (params: unknown) => {
          calls.push(['read', params])
          return Promise.resolve([{ instId: 'BTC-USDT-SWAP', ordId: 'o-1' }, { instId: 'ETH-USDT-SWAP' }])
        },
        cancelOrder: (params: unknown) => {
          calls.push(['cancel', params])
          return Promise.resolve({})
        },
      },
    } as unknown as Pick<OkxClients, 'native'>

    // The id-less row is skipped rather than cancelled blind.
    expect(await createOkxCancelSweep(clients)()).toEqual(['BTC-USDT-SWAP#o-1'])
    expect(calls).toEqual([
      ['read', { instType: 'SWAP' }],
      ['cancel', { instId: 'BTC-USDT-SWAP', ordId: 'o-1' }],
    ])
  })

  it('bitget: USDT-FUTURES unfilled orders, cancelled by orderId', async () => {
    const calls: unknown[] = []
    const clients = {
      native: {
        getUnfilledOrders: (params: unknown) => {
          calls.push(['read', params])
          return Promise.resolve({ data: { list: [{ symbol: 'BTCUSDT', orderId: 'o-1' }] } })
        },
        cancelOrder: (params: unknown) => {
          calls.push(['cancel', params])
          return Promise.resolve({})
        },
      },
    } as unknown as Pick<BitgetClients, 'native'>

    expect(await createBitgetCancelSweep(clients)()).toEqual(['BTCUSDT#o-1'])
    expect(calls).toEqual([
      ['read', { category: 'USDT-FUTURES' }],
      ['cancel', { category: 'USDT-FUTURES', orderId: 'o-1' }],
    ])
  })

  it('kucoin: account-wide ccxt open orders, cancelled by venue orderId', async () => {
    const calls: unknown[] = []
    const clients = {
      ccxt: {
        fetchOpenOrders: (symbol?: string) => {
          calls.push(['read', symbol])
          return Promise.resolve([{ id: 'o-1', symbol: 'XBT/USDT:USDT', clientOrderId: 'c-1' }])
        },
      },
      native: {
        cancelOrderById: (params: unknown) => {
          calls.push(['cancel', params])
          return Promise.resolve({})
        },
      },
    } as unknown as Pick<KucoinClients, 'ccxt' | 'native'>

    expect(await createKucoinCancelSweep(clients)()).toEqual(['XBT/USDT:USDT#o-1'])
    expect(calls).toEqual([
      ['read', undefined],
      ['cancel', { orderId: 'o-1' }],
    ])
  })
})
