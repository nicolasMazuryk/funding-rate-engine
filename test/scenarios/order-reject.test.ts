/**
 * Scenario: **order reject** (`13` §6 — precision / min-notional / margin). A resting
 * limit order that fails validation is rejected before it joins the book: `accepted:
 * false`, an `OrderUpdate{status:'REJECTED'}` carrying the typed `reason`/`errorKind`,
 * and no position. Market orders keep 0060's un-validated fill path, so these rejects
 * are exercised via limit orders (direct `sim.placeOrder`).
 */

import { describe, expect, it } from 'vitest'
import type { OrderUpdate } from '../../src/core/events/types.js'
import type { OrderRequest } from '../../src/core/ports/exchange-adapter.js'
import { simHarness } from './sim-harness.js'

const limit = (over: Partial<OrderRequest>): OrderRequest => ({
  symbol: 'BTC',
  side: 'long',
  type: 'limit',
  qty: 0.001,
  price: 60_000,
  clientOrderId: 'o',
  ...over,
})

async function reject(over: Partial<OrderRequest>): Promise<OrderUpdate> {
  const { sim, events } = simHarness()
  const ack = await sim.placeOrder(limit(over))
  expect(ack.accepted).toBe(false)
  expect(await sim.getPositions()).toEqual([])
  const update = events.find((e): e is OrderUpdate => e.type === 'OrderUpdate')
  if (!update) throw new Error('no OrderUpdate emitted')
  expect(update.status).toBe('REJECTED')
  return update
}

describe('scenario: order reject', () => {
  it('precision rejection: qty off the amount grid', async () => {
    const update = await reject({ qty: 0.0015 }) // amountPrecision 0.001 ⇒ 1.5 lots
    expect(update.reason).toBe('precision')
    expect(update.errorKind).toBe('OrderRejected')
  })

  it('min-notional rejection: notional below the instrument minimum', async () => {
    const update = await reject({ price: 100 }) // 0.001 * 100 = 0.1 < minNotional 5
    expect(update.reason).toBe('min_notional')
    expect(update.errorKind).toBe('OrderRejected')
  })

  it('margin rejection: notional exceeds free balance', async () => {
    const update = await reject({ qty: 1 }) // 1 * 60_000 = 60_000 > free 10_000
    expect(update.reason).toBe('margin')
    expect(update.errorKind).toBe('InsufficientBalance')
  })
})
