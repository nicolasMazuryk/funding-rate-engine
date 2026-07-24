import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../src/adapters/clock/virtual-clock.js'
import { createSimExchange } from '../../../../src/adapters/sim/sim-exchange.js'
import { createEventBus } from '../../../../src/core/events/bus.js'
import type { EngineEvent } from '../../../../src/core/events/types.js'
import type { ExchangeAdapter, OrderRequest } from '../../../../src/core/ports/exchange-adapter.js'

/** Wire a sim venue to a real bus + virtual clock, collecting every published event. */
function harness() {
  const clock = createVirtualClock(1_000)
  const bus = createEventBus()
  const events: EngineEvent[] = []
  bus.subscribe((e) => events.push(e))
  const sim = createSimExchange(clock, bus)
  return { clock, bus, sim, events }
}

const buy = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  symbol: 'BTC',
  side: 'long',
  type: 'market',
  qty: 1,
  clientOrderId: 'o1',
  ...over,
})

describe('createSimExchange', () => {
  it('fills a BUY MARKET at the scripted price and reflects it in getPositions', async () => {
    const { sim, events } = harness()
    sim.setPrice('BTC', 30_000)

    const ack = await sim.placeOrder(buy({ qty: 2 }))

    expect(ack).toEqual({ clientOrderId: 'o1', accepted: true, venueOrderId: 'o1' })
    expect(events).toContainEqual({
      type: 'OrderUpdate',
      clientOrderId: 'o1',
      status: 'FILLED',
      fillPx: 30_000,
      qty: 2,
    })
    expect(events).toContainEqual({ type: 'PositionUpdate', symbol: 'BTC', qty: 2, side: 'long' })
    expect(await sim.getPositions()).toEqual([{ symbol: 'BTC', side: 'long', qty: 2, entryPrice: 30_000 }])
  })

  it('fails loud when no price is scripted (no silent zero-fill)', () => {
    const { sim } = harness()
    expect(() => sim.placeOrder(buy())).toThrow(/no price scripted/)
  })

  it('books the taker fee on a fill and reports it via getOrder (reconciliation fills dimension, 0400)', async () => {
    const { sim } = harness()
    sim.setPrice('BTC', 30_000)
    await sim.placeOrder(buy({ qty: 2 }))
    // Default taker fee 0.04% × notional (30 000 × 2) = 24.
    expect((await sim.getOrder('o1')).fee).toBeCloseTo(24, 6)
  })

  it('scriptOrderFee reports a divergent fee for the fee-divergence scenario', async () => {
    const { sim } = harness()
    sim.setPrice('BTC', 30_000)
    await sim.placeOrder(buy({ qty: 2 }))
    sim.scriptOrderFee('o1', 99.5)
    expect((await sim.getOrder('o1')).fee).toBe(99.5)
  })

  it('reduce-only SELL flattens the position, capping qty at the open size', async () => {
    const { sim, events } = harness()
    sim.setPrice('BTC', 30_000)
    await sim.placeOrder(buy({ qty: 1 }))

    // Request more than is open — reduce-only caps at position qty, so it flattens, not flips.
    const ack = await sim.placeOrder(buy({ side: 'short', qty: 5, reduceOnly: true, clientOrderId: 'c1' }))

    expect(ack.accepted).toBe(true)
    expect(await sim.getPositions()).toEqual([])
    expect(events).toContainEqual({
      type: 'OrderUpdate',
      clientOrderId: 'c1',
      status: 'FILLED',
      fillPx: 30_000,
      qty: 1, // capped from the requested 5
    })
    expect(events).toContainEqual({ type: 'PositionUpdate', symbol: 'BTC', qty: 0, side: 'short' })
  })

  it('settleFunding on an open long with negative rate accrues a positive amount', async () => {
    const { sim, events } = harness()
    sim.setPrice('BTC', 30_000)
    await sim.placeOrder(buy({ qty: 1 }))

    sim.settleFunding('BTC', -0.4, 2_000)

    // notional = 1 * 30_000 * 1 = 30_000; long receives +|F| = +0.4% ⇒ +120 USDT.
    expect(events).toContainEqual({
      type: 'FundingFeeAccrued',
      symbol: 'BTC',
      amount: 120,
      fundingTime: 2_000,
    })
    expect(events).toContainEqual({ type: 'FundingSettled', symbol: 'BTC', rate: -0.4, settleTs: 2_000 })
    expect((await sim.getBalance()).free).toBe(10_120)
  })

  it('settleFunding on an open short with negative rate accrues a negative amount', async () => {
    const { sim, events } = harness()
    sim.setPrice('BTC', 30_000)
    await sim.placeOrder(buy({ side: 'short', qty: 1 }))

    sim.settleFunding('BTC', -0.4, 2_000)

    // short pays −|F| = −0.4% ⇒ −120 USDT.
    expect(events).toContainEqual({
      type: 'FundingFeeAccrued',
      symbol: 'BTC',
      amount: -120,
      fundingTime: 2_000,
    })
    expect((await sim.getBalance()).free).toBe(9_880)
  })

  it('settleFunding with no open position emits no FundingFeeAccrued', async () => {
    const { sim, events } = harness()
    sim.setPrice('BTC', 30_000)

    sim.settleFunding('BTC', -0.4, 2_000)

    expect(events).toContainEqual({ type: 'FundingSettled', symbol: 'BTC', rate: -0.4, settleTs: 2_000 })
    expect(events.some((e) => e.type === 'FundingFeeAccrued')).toBe(false)
    expect(events.some((e) => e.type === 'BalanceUpdate')).toBe(false)
  })

  it('normalize fails loud on an unknown symbol', () => {
    const { sim } = harness()
    expect(() => sim.normalize('DOGE')).toThrow(/unknown symbol/)
    expect(sim.normalize('PEPE').contractSize).toBe(1000) // denomination case (`10` §4)
  })

  it('satisfies ExchangeAdapter with no cast (type-level DoD)', () => {
    const clock = createVirtualClock(0)
    const bus = createEventBus()
    // Assignment to the port type is the "satisfies" proof — no `as`.
    const _check: ExchangeAdapter = createSimExchange(clock, bus)
    expect(typeof _check.placeOrder).toBe('function')
  })

  // ── 0160 fault-injection mechanics (isolated; scenario tests cover the catalog rows) ──

  it('rests a limit order OPEN and fills it when the mark price crosses', async () => {
    const { sim, events } = harness()
    const ack = await sim.placeOrder({
      symbol: 'BTC',
      side: 'long',
      type: 'limit',
      qty: 0.001,
      price: 60_000,
      clientOrderId: 'l1',
    })
    expect(ack.accepted).toBe(true)
    expect(events).toContainEqual({ type: 'OrderUpdate', clientOrderId: 'l1', status: 'OPEN' })
    expect(await sim.getPositions()).toEqual([]) // not filled yet

    sim.setPrice('BTC', 59_000) // 59_000 ≤ 60_000 ⇒ buy limit crosses

    expect(events).toContainEqual({
      type: 'OrderUpdate',
      clientOrderId: 'l1',
      status: 'FILLED',
      fillPx: 60_000,
      qty: 0.001,
    })
    expect(await sim.getPositions()).toEqual([{ symbol: 'BTC', side: 'long', qty: 0.001, entryPrice: 60_000 }])
  })

  it('does not cross a buy limit while the mark stays above it', async () => {
    const { sim, events } = harness()
    await sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'limit', qty: 0.001, price: 60_000, clientOrderId: 'l1' })
    sim.setPrice('BTC', 61_000) // above the limit ⇒ no cross
    expect(events.some((e) => e.type === 'OrderUpdate' && e.status === 'FILLED')).toBe(false)
  })

  it('triggers a stop order when the mark rises to it (long stop)', async () => {
    const { sim, events } = harness()
    await sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'stop', qty: 0.001, price: 60_000, clientOrderId: 's1' })
    sim.setPrice('BTC', 60_500) // ≥ stop ⇒ triggers, fills at the current mark
    expect(events).toContainEqual({
      type: 'OrderUpdate',
      clientOrderId: 's1',
      status: 'FILLED',
      fillPx: 60_500,
      qty: 0.001,
    })
  })

  it('cancels a resting order and emits CANCELLED', async () => {
    const { sim, events } = harness()
    await sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'limit', qty: 0.001, price: 60_000, clientOrderId: 'l1' })
    await sim.cancelOrder('l1')
    expect(events).toContainEqual({ type: 'OrderUpdate', clientOrderId: 'l1', status: 'CANCELLED', qty: 0 })
    // Cancelled: a later crossing no longer fills it.
    sim.setPrice('BTC', 59_000)
    expect(events.some((e) => e.type === 'OrderUpdate' && e.status === 'FILLED')).toBe(false)
  })

  it('throws a typed SimVenueError on scripted call ordinals, then recovers', async () => {
    const { sim } = harness()
    sim.scriptRateLimit('getBalance', 'RateLimited', [1])
    expect(() => sim.getBalance()).toThrow(/RateLimited/)
    await expect(sim.getBalance()).resolves.toBeDefined() // ordinal 2 passes
  })

  it('market orders keep the un-validated happy path (no precision/margin regression)', async () => {
    const { sim } = harness()
    sim.setPrice('BTC', 30_000)
    // qty 2 @ 30_000 = 60_000 notional > free 10_000 — a limit would reject on margin;
    // a market order still fills (validateOrder is resting-only).
    const ack = await sim.placeOrder(buy({ qty: 2 }))
    expect(ack.accepted).toBe(true)
  })
})
