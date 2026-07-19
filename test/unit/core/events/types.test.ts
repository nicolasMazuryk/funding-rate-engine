import { describe, expect, it } from 'vitest'
import { assertNever, type EngineEvent } from '../../../../src/core/events/types.js'

/**
 * A total switch over every {@link EngineEvent} variant. If a new variant is added
 * to the union without a `case` here, the `assertNever(event)` default fails to
 * compile (`tsc --noEmit`) — that compile check is the real test.
 */
function summarize(event: EngineEvent): string {
  switch (event.type) {
    case 'Timer':
      return `Timer:${event.kind}`
    case 'FundingPredicted':
      return `FundingPredicted:${event.symbol}`
    case 'FundingSettled':
      return `FundingSettled:${event.symbol}`
    case 'FundingFeeAccrued':
      return `FundingFeeAccrued:${event.symbol}`
    case 'MarketTick':
      return `MarketTick:${event.symbol}`
    case 'OrderUpdate':
      return `OrderUpdate:${event.clientOrderId}`
    case 'PositionUpdate':
      return `PositionUpdate:${event.symbol}`
    case 'BalanceUpdate':
      return `BalanceUpdate:${event.asset}`
    default:
      return assertNever(event)
  }
}

describe('EngineEvent exhaustiveness', () => {
  it('summarize handles one instance of each of the 8 variants', () => {
    const events: EngineEvent[] = [
      { type: 'Timer', kind: 'scan', ts: 1 },
      { type: 'FundingPredicted', symbol: 'BTC', rate: -0.4, ts: 1 },
      { type: 'FundingSettled', symbol: 'BTC', rate: -0.4, settleTs: 1 },
      { type: 'FundingFeeAccrued', symbol: 'BTC', amount: -1.2, fundingTime: 1 },
      { type: 'MarketTick', symbol: 'BTC', price: 100, ts: 1 },
      { type: 'OrderUpdate', clientOrderId: 'c1', status: 'FILLED' },
      { type: 'PositionUpdate', symbol: 'BTC', qty: 1, side: 'long' },
      { type: 'BalanceUpdate', asset: 'USDT', free: 10, used: 0 },
    ]
    expect(events.map(summarize)).toEqual([
      'Timer:scan',
      'FundingPredicted:BTC',
      'FundingSettled:BTC',
      'FundingFeeAccrued:BTC',
      'MarketTick:BTC',
      'OrderUpdate:c1',
      'PositionUpdate:BTC',
      'BalanceUpdate:USDT',
    ])
    expect(events).toHaveLength(8)
  })

  it('assertNever throws if an impossible value reaches it at runtime', () => {
    expect(() => assertNever('boom' as never)).toThrow(/Unhandled variant/)
  })
})
