import { describe, expect, it } from 'vitest'
import type { FundingPredicted } from '../../../../src/core/events/types.js'
import type { Instrument } from '../../../../src/core/ports/exchange-adapter.js'
import { type FindCandidatesInput, findCandidates, type ThresholdConfig } from '../../../../src/core/runtime/finder.js'
import { computeFundingSchedule, type FundingScheduleEntry } from '../../../../src/core/runtime/funding-schedule.js'

const HOUR_MS = 3_600_000

/** Scan at 07:58; the next top-of-hour is 08:00, which is an 8 h and 4 h settlement. */
const SCAN_TS = 7 * HOUR_MS + 58 * 60_000

const NEGATIVE: ThresholdConfig = { percent: -0.3, direction: 'negative' }
const POSITIVE: ThresholdConfig = { percent: 0.3, direction: 'positive' }

function reading(symbol: string, rate: number, ts = SCAN_TS): FundingPredicted {
  return { type: 'FundingPredicted', symbol, rate, ts }
}

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

/** Schedule where every listed symbol settles at the imminent 08:00 boundary (8 h interval). */
function scheduleAt(nowMs: number, symbols: readonly string[]): ReadonlyMap<string, FundingScheduleEntry> {
  return computeFundingSchedule(
    symbols.map((s) => instrument(s, 8)),
    nowMs,
  )
}

function input(overrides: Partial<FindCandidatesInput>): FindCandidatesInput {
  const universe = overrides.universe ?? ['BTC']
  return {
    universe,
    predicted: overrides.predicted ?? new Map(),
    schedule: overrides.schedule ?? scheduleAt(SCAN_TS, universe),
    threshold: overrides.threshold ?? NEGATIVE,
    nowMs: overrides.nowMs ?? SCAN_TS,
  }
}

describe('findCandidates — proximity guard', () => {
  it('keeps a rate within 0.1pp of the threshold', () => {
    const predicted = new Map([['BTC', reading('BTC', -0.35)]]) // |−0.35 − (−0.3)| = 0.05 ≤ 0.1
    expect(findCandidates(input({ predicted })).map((c) => c.symbol)).toEqual(['BTC'])
  })

  it('drops a rate beyond 0.1pp of the threshold', () => {
    const predicted = new Map([['BTC', reading('BTC', -0.45)]]) // |−0.45 − (−0.3)| = 0.15 > 0.1
    expect(findCandidates(input({ predicted }))).toEqual([])
  })
})

describe('findCandidates — freshness guard', () => {
  it('keeps a reading observed 59_999 ms ago (fresh)', () => {
    const predicted = new Map([['BTC', reading('BTC', -0.3, SCAN_TS - 59_999)]])
    expect(findCandidates(input({ predicted })).map((c) => c.symbol)).toEqual(['BTC'])
  })

  it('drops a reading observed 60_000 ms ago (stale)', () => {
    const predicted = new Map([['BTC', reading('BTC', -0.3, SCAN_TS - 60_000)]])
    expect(findCandidates(input({ predicted }))).toEqual([])
  })
})

describe('findCandidates — imminence guard', () => {
  it('keeps a 4 h-interval symbol only on the scan whose next top-of-hour is a multiple of 4', () => {
    const fresh = (nowMs: number) => reading('BTC', -0.3, nowMs)

    // A 4 h symbol settles at 00:00 / 04:00 / 08:00 …; it is imminent only when the
    // next top-of-hour equals that settlement — one scan in four.
    const aligned = 7 * HOUR_MS + 58 * 60_000 // next top-of-hour 08:00 = 4 h multiple → in
    const misaligned = 8 * HOUR_MS + 58 * 60_000 // next top-of-hour 09:00 ≠ 4 h multiple → out

    const inScope = findCandidates(
      input({
        predicted: new Map([['BTC', fresh(aligned)]]),
        schedule: computeFundingSchedule([instrument('BTC', 4)], aligned),
        nowMs: aligned,
      }),
    )
    const outOfScope = findCandidates(
      input({
        predicted: new Map([['BTC', fresh(misaligned)]]),
        schedule: computeFundingSchedule([instrument('BTC', 4)], misaligned),
        nowMs: misaligned,
      }),
    )
    expect(inScope.map((c) => c.symbol)).toEqual(['BTC'])
    expect(outOfScope).toEqual([])
  })
})

describe('findCandidates — ordering by extremity', () => {
  it('orders a negative threshold most-negative first', () => {
    const predicted = new Map([
      ['BTC', reading('BTC', -0.35)],
      ['ETH', reading('ETH', -0.38)],
      ['SOL', reading('SOL', -0.25)],
    ])
    const result = findCandidates(input({ universe: ['BTC', 'ETH', 'SOL'], predicted }))
    expect(result.map((c) => c.symbol)).toEqual(['ETH', 'BTC', 'SOL'])
  })

  it('orders an S6-style positive threshold most-positive first', () => {
    const predicted = new Map([
      ['BTC', reading('BTC', 0.35)],
      ['ETH', reading('ETH', 0.38)],
      ['SOL', reading('SOL', 0.25)],
    ])
    const result = findCandidates(input({ universe: ['BTC', 'ETH', 'SOL'], predicted, threshold: POSITIVE }))
    expect(result.map((c) => c.symbol)).toEqual(['ETH', 'BTC', 'SOL'])
  })

  it('breaks ties on symbol ascending, independent of universe order', () => {
    const predicted = new Map([
      ['ETH', reading('ETH', -0.35)],
      ['BTC', reading('BTC', -0.35)],
    ])
    const a = findCandidates(input({ universe: ['ETH', 'BTC'], predicted }))
    const b = findCandidates(input({ universe: ['BTC', 'ETH'], predicted }))
    expect(a.map((c) => c.symbol)).toEqual(['BTC', 'ETH'])
    expect(a).toEqual(b)
  })
})

describe('findCandidates — determinism', () => {
  it('returns identical output across repeat runs on the same input', () => {
    const predicted = new Map([
      ['BTC', reading('BTC', -0.35)],
      ['ETH', reading('ETH', -0.38)],
    ])
    const built = input({ universe: ['BTC', 'ETH'], predicted })
    expect(findCandidates(built)).toEqual(findCandidates(built))
  })

  it('emits the full candidate shape', () => {
    const predicted = new Map([['BTC', reading('BTC', -0.35, SCAN_TS - 1_000)]])
    expect(findCandidates(input({ predicted }))).toEqual([
      { symbol: 'BTC', ratePercent: -0.35, settleTs: 8 * HOUR_MS, observedTs: SCAN_TS - 1_000 },
    ])
  })
})
