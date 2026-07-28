import { describe, expect, it } from 'vitest'
import type { Instrument, OrderRequest } from '../../../src/core/ports/exchange-adapter.js'
import { isPriceable, orderNotionalUsd } from '../../../src/live/notional.js'

/**
 * Notional estimation is fail-closed (task 0470): unpriceable → `Infinity`, and the
 * `contractSize` ambiguity is resolved toward the larger reading.
 */

function instrument(contractSize: number): Instrument {
  return {
    normalized: 'PEPE',
    venueSymbol: '1000PEPEUSDT',
    contractSize,
    pricePrecision: 0.0001,
    amountPrecision: 1,
    minNotional: 5,
    minQty: 1,
    fundingIntervalHours: 8,
  }
}

function order(over: Partial<OrderRequest> = {}): OrderRequest {
  return { symbol: 'PEPE', side: 'long', type: 'limit', qty: 10, price: 2, clientOrderId: 'c-1', ...over }
}

describe('orderNotionalUsd', () => {
  it('is qty * price when contractSize is 1', () => {
    expect(orderNotionalUsd(order(), instrument(1))).toBe(20)
  })

  it('takes the larger reading when contractSize != 1', () => {
    // A contract multiplier could mean 20 USD or 200 USD; the cap must assume 200.
    expect(orderNotionalUsd(order(), instrument(10))).toBe(200)
    // ...and a sub-unit multiplier must not be used to shrink the estimate below the plain reading.
    expect(orderNotionalUsd(order(), instrument(0.001))).toBe(20)
  })

  it('is Infinity for anything it cannot price', () => {
    const inf = Number.POSITIVE_INFINITY
    expect(orderNotionalUsd(order({ type: 'market', price: undefined }), instrument(1))).toBe(inf)
    expect(orderNotionalUsd(order({ price: 0 }), instrument(1))).toBe(inf)
    expect(orderNotionalUsd(order({ price: Number.NaN }), instrument(1))).toBe(inf)
    expect(orderNotionalUsd(order({ qty: 0 }), instrument(1))).toBe(inf)
    expect(orderNotionalUsd(order(), instrument(0))).toBe(inf)
    expect(orderNotionalUsd(order(), instrument(Number.NaN))).toBe(inf)
  })
})

describe('isPriceable', () => {
  it('is true only with a usable price and qty', () => {
    expect(isPriceable(order())).toBe(true)
    expect(isPriceable(order({ type: 'market', price: undefined }))).toBe(false)
    expect(isPriceable(order({ qty: -1 }))).toBe(false)
  })
})
