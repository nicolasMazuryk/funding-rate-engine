/**
 * Unit: funding tracker (`11` §7, `15` §G-R). Real event bus + a fake `fundingHistory`,
 * offline. Covers: booking every `FundingFeeAccrued` (signed) keyed by symbol, isolating
 * accruals per symbol, `backfill` delegating to REST, and disposal stopping consumption.
 */

import { describe, expect, it } from 'vitest'
import { createEventBus } from '../../../src/core/events/bus.js'
import type { FundingEvent, TimeRange } from '../../../src/core/ports/exchange-adapter.js'
import { createFundingTracker } from '../../../src/execution/funding-tracker.js'

describe('funding tracker', () => {
  it('books every FundingFeeAccrued (signed) keyed by symbol, in arrival order', () => {
    const bus = createEventBus()
    const tracker = createFundingTracker({ bus, exchange: { fundingHistory: () => Promise.resolve([]) } })

    bus.publish({ type: 'FundingFeeAccrued', symbol: 'BTC', amount: 1.5, fundingTime: 1_000 })
    bus.publish({ type: 'FundingFeeAccrued', symbol: 'BTC', amount: -0.8, fundingTime: 2_000 })
    bus.publish({ type: 'FundingFeeAccrued', symbol: 'ETH', amount: 3.2, fundingTime: 1_500 })

    expect(tracker.accrualsFor('BTC')).toEqual([
      { amount: 1.5, fundingTime: 1_000 },
      { amount: -0.8, fundingTime: 2_000 },
    ])
    expect(tracker.accrualsFor('ETH')).toEqual([{ amount: 3.2, fundingTime: 1_500 }])
    expect(tracker.accrualsFor('DOGE')).toEqual([])
    tracker.dispose()
  })

  it('backfill delegates to exchange.fundingHistory', async () => {
    const bus = createEventBus()
    const rows: FundingEvent[] = [{ symbol: 'BTC', rate: -0.4, settleTs: 1_000 }]
    let seen: { symbol: string; range: TimeRange } | undefined
    const tracker = createFundingTracker({
      bus,
      exchange: {
        fundingHistory(symbol, range) {
          seen = { symbol, range }
          return Promise.resolve(rows)
        },
      },
    })

    const range: TimeRange = { fromTs: 0, toTs: 10_000 }
    await expect(tracker.backfill('BTC', range)).resolves.toEqual(rows)
    expect(seen).toEqual({ symbol: 'BTC', range })
    tracker.dispose()
  })

  it('stops booking accruals after dispose', () => {
    const bus = createEventBus()
    const tracker = createFundingTracker({ bus, exchange: { fundingHistory: () => Promise.resolve([]) } })

    tracker.dispose()
    bus.publish({ type: 'FundingFeeAccrued', symbol: 'BTC', amount: 1.5, fundingTime: 1_000 })

    expect(tracker.accrualsFor('BTC')).toEqual([])
  })
})
