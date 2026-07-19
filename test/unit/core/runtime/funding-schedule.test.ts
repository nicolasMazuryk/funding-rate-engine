import { describe, expect, it } from 'vitest'
import type { Instrument } from '../../../../src/core/ports/exchange-adapter.js'
import { computeFundingSchedule, nextSettleTs } from '../../../../src/core/runtime/funding-schedule.js'

const HOUR_MS = 3_600_000

function instrument(normalized: string, fundingIntervalHours: number): Instrument {
  return {
    normalized,
    venueSymbol: normalized,
    contractSize: 1,
    pricePrecision: 0.01,
    amountPrecision: 0.001,
    minNotional: 1,
    minQty: 0.001,
    fundingIntervalHours,
  }
}

describe('nextSettleTs', () => {
  it('returns the next UTC multiple of the interval strictly after a mid-period instant', () => {
    // 07:58 on an 8 h schedule → next settlement 08:00.
    expect(nextSettleTs(7 * HOUR_MS + 58 * 60_000, 8)).toBe(8 * HOUR_MS)
    // 07:58 on a 4 h schedule → next settlement 08:00.
    expect(nextSettleTs(7 * HOUR_MS + 58 * 60_000, 4)).toBe(8 * HOUR_MS)
    // 08:58 on a 4 h schedule → next settlement 12:00.
    expect(nextSettleTs(8 * HOUR_MS + 58 * 60_000, 4)).toBe(12 * HOUR_MS)
  })

  it('returns the instant itself when exactly on a boundary (≥, not >)', () => {
    expect(nextSettleTs(8 * HOUR_MS, 8)).toBe(8 * HOUR_MS)
    expect(nextSettleTs(0, 1)).toBe(0)
  })
})

describe('computeFundingSchedule', () => {
  it('maps each instrument to its next settlement keyed by normalized symbol', () => {
    const nowMs = 7 * HOUR_MS + 58 * 60_000
    const schedule = computeFundingSchedule([instrument('BTC', 8), instrument('ALT', 1)], nowMs)

    expect(schedule.get('BTC')).toEqual({ symbol: 'BTC', fundingIntervalHours: 8, settleTs: 8 * HOUR_MS })
    // A 1 h-interval symbol always settles at the next top-of-hour.
    expect(schedule.get('ALT')).toEqual({ symbol: 'ALT', fundingIntervalHours: 1, settleTs: 8 * HOUR_MS })
  })
})
