/**
 * Unit tier (task 0410) — the `15` §4 metric table + the two spec kill criteria, as pure
 * functions over hand-built rows (no Postgres). Every §4 table row has a named test here;
 * grep the test names against the table to map coverage:
 *
 *   §4 row 1  path mix
 *   §4 row 2  NET_PNL by t_drop_offset_s
 *   §4 row 3  realized |DELTA_PNL| / |F|
 *   §4 row 4  deadline-exit frequency + DELTA_PNL distribution
 *   §4 row 5  fill-count histogram · P_avg vs P_ref · limit_expired/ladder_no_fills rate
 *   §4 row 6  drop-depth ÷ |F|
 *   §4 row 7  S6 PRE overhead (bp) · event-timeout rate · MAIN slippage
 *
 * Expected values are hand-computed in the test body, never re-derived from the code.
 */

import { describe, expect, it } from 'vitest'
import { s1wsKillCriterion, s2BreakEven } from '../../../src/analytics/kill-criteria.js'
import {
  deadlineExitStats,
  deltaToFundingRatioDist,
  dropDepthToFunding,
  entryFailureRates,
  eventTimeoutRate,
  fillCountHistogram,
  netPnlByDropOffset,
  pAvgVsPRef,
  pathMix,
  s6MainSlippage,
  s6PreOverheadBp,
} from '../../../src/analytics/metrics.js'
import {
  type FundingEventRow,
  type InsufficientData,
  isInsufficientData,
  type PnlRow,
} from '../../../src/analytics/types.js'

const T_SETTLE = 1_700_000_000_000

function row(overrides: Partial<PnlRow> = {}): PnlRow {
  return {
    exchange: 'binance',
    strategy: 's1',
    subaccount: 'a',
    intentId: 'i1',
    symbol: 'BTCUSDT',
    tSettleMs: T_SETTLE,
    deltaPnl: 0,
    fundingPnl: 0,
    feeCost: 0,
    netPnl: 0,
    fillCount: 1,
    fundingReceived: true,
    ...overrides,
  }
}

/** A settled funding event carrying a signed-percent `rate` — the `|F|` source (never the money cols). */
function funding(overrides: Partial<FundingEventRow> = {}): FundingEventRow {
  return {
    exchange: 'binance',
    strategy: 's1',
    subaccount: 'a',
    symbol: 'BTCUSDT',
    fundingTime: T_SETTLE,
    amount: -4,
    rate: -0.4,
    ...overrides,
  }
}

/** Narrow a `MetricResult` to its computed side, failing the test if it is `insufficient_data`. */
function computed<T>(result: T): Exclude<T, InsufficientData> {
  if (isInsufficientData(result)) throw new Error(`expected a computed metric, got: ${result.reason}`)
  return result as Exclude<T, InsufficientData>
}

describe('15 §4 row 1 — path mix', () => {
  it('counts each exit_reason and reports it as a frequency of all terminated intents', () => {
    const mix = pathMix([
      row({ exitReason: 'tp_hit' }),
      row({ exitReason: 'tp_hit' }),
      row({ exitReason: 'sl_hit' }),
      row({ exitReason: 'deadline' }),
    ])
    expect(mix.total).toBe(4)
    expect(mix.counts.tp_hit).toBe(2)
    expect(mix.counts.sl_hit).toBe(1)
    expect(mix.counts.deadline).toBe(1)
    expect(mix.frequencies.tp_hit).toBe(0.5)
    expect(mix.frequencies.sl_hit).toBe(0.25)
  })

  it('keeps every canonical reason as a key (0 when unseen) and buckets error-terminated intents as `none`', () => {
    const mix = pathMix([row({ errorCode: 'limit_expired' })])
    expect(mix.counts.none).toBe(1)
    expect(mix.counts.tp_hit).toBe(0)
    expect(mix.counts.kill_switch_flatten).toBe(0)
  })
})

describe('15 §4 row 2 — NET_PNL bucketed by t_drop_offset_s', () => {
  it('sums quote-ccy net_pnl into the [<0, 0-2, 2-5, 5-10, >10]s buckets', () => {
    const result = netPnlByDropOffset([
      row({ tDropOffsetS: -1, netPnl: 10 }),
      row({ tDropOffsetS: 0, netPnl: 2 }),
      row({ tDropOffsetS: 1, netPnl: 4 }),
      row({ tDropOffsetS: 3, netPnl: 4 }),
      row({ tDropOffsetS: 12, netPnl: -6 }),
    ])
    const byLabel = Object.fromEntries(result.buckets.map((b) => [b.bucket, b]))
    expect(byLabel.lt0).toMatchObject({ count: 1, sumNetPnl: 10, meanNetPnl: 10 })
    // 0 and 1 both land in `0-2`: sum 6, mean 3.
    expect(byLabel['0-2']).toMatchObject({ count: 2, sumNetPnl: 6, meanNetPnl: 3 })
    expect(byLabel['2-5']).toMatchObject({ count: 1, sumNetPnl: 4 })
    expect(byLabel['5-10']).toMatchObject({ count: 0, sumNetPnl: 0, meanNetPnl: 0 })
    expect(byLabel.gt10).toMatchObject({ count: 1, sumNetPnl: -6 })
  })

  it('counts rows with no t_drop_offset_s separately instead of folding them into a bucket', () => {
    const result = netPnlByDropOffset([row({ netPnl: 99 }), row({ tDropOffsetS: 1, netPnl: 1 })])
    expect(result.missingOffset).toBe(1)
    expect(result.buckets.reduce((acc, b) => acc + b.sumNetPnl, 0)).toBe(1)
  })
})

describe('15 §4 row 3 — realized |DELTA_PNL| / |F| distribution (S1-WS)', () => {
  // |F| = 0.4%. DELTA_PNL% is recomputed from prices, never from the quote-ccy money cols:
  //   100 → 99.88 ⇒ −0.12% ⇒ ratio 0.30
  //   100 → 99.76 ⇒ −0.24% ⇒ ratio 0.60
  //   100 → 99.50 ⇒ −0.50% ⇒ ratio 1.25
  // Deliberately off the histogram edges: these are decimal prices, so a ratio landing
  // exactly on a bucket boundary would be decided by float noise, not by the metric.
  const rows = [
    row({ intentId: 'i1', pEntry: 100, pExit: 99.88 }),
    row({ intentId: 'i2', pEntry: 100, pExit: 99.76 }),
    row({ intentId: 'i3', pEntry: 100, pExit: 99.5 }),
  ]

  it('recomputes the ratio from prices and |F| from the settled funding rate', () => {
    const result = computed(deltaToFundingRatioDist(rows, [funding()]))
    expect(result.distribution.count).toBe(3)
    expect(result.distribution.min).toBeCloseTo(0.3, 10)
    expect(result.distribution.median).toBeCloseTo(0.6, 10)
    expect(result.distribution.p90).toBeCloseTo(1.25, 10)
    expect(result.distribution.max).toBeCloseTo(1.25, 10)
    expect(result.distribution.mean).toBeCloseTo((0.3 + 0.6 + 1.25) / 3, 10)
    expect(result.histogram).toEqual({ '0-0.25': 0, '0.25-0.5': 1, '0.5-0.75': 1, '0.75-1': 0, gte1: 1 })
  })

  it('skips trades with no price pair or no matched funding rate, and reports them as unmatched', () => {
    const result = computed(
      deltaToFundingRatioDist(
        [...rows, row({ intentId: 'i4' }), row({ intentId: 'i5', symbol: 'ETHUSDT' })],
        [funding()],
      ),
    )
    expect(result.distribution.count).toBe(3)
    expect(result.unmatched).toBe(2)
  })

  it('is insufficient_data when nothing matches (a funding event beyond the ±match window)', () => {
    const stale = funding({ fundingTime: T_SETTLE + 2 * 60 * 60 * 1000 })
    expect(deltaToFundingRatioDist(rows, [stale])).toMatchObject({ status: 'insufficient_data' })
  })
})

describe('15 §4 row 4 — deadline-exit frequency & DELTA_PNL distribution (S2)', () => {
  it('reports the deadline frequency and the quote-ccy DELTA_PNL distribution on that path', () => {
    const stats = deadlineExitStats([
      row({ exitReason: 'deadline', deltaPnl: -3 }),
      row({ exitReason: 'deadline', deltaPnl: -1 }),
      row({ exitReason: 'tp_hit', deltaPnl: 5 }),
    ])
    expect(stats).toMatchObject({ total: 3, deadlineExits: 2 })
    expect(stats.frequency).toBeCloseTo(2 / 3, 10)
    expect(computed(stats.deltaPnl)).toMatchObject({ count: 2, min: -3, median: -2, max: -1, mean: -2 })
  })

  it('is insufficient_data for the distribution when no intent exited on the deadline', () => {
    const stats = deadlineExitStats([row({ exitReason: 'tp_hit' })])
    expect(stats.deadlineExits).toBe(0)
    expect(stats.deltaPnl).toMatchObject({ status: 'insufficient_data' })
  })
})

describe('15 §4 row 5 — fill-count histogram (S4.1a/S4.2a)', () => {
  it('counts intents by their realized fill_count', () => {
    const histogram = fillCountHistogram([row({ fillCount: 1 }), row({ fillCount: 1 }), row({ fillCount: 3 })])
    expect(histogram).toEqual({ total: 3, counts: { '1': 2, '3': 1 } })
  })
})

describe('15 §4 row 5 — limit_expired / ladder_no_fills rate', () => {
  it('divides each entry-failure error_code by all terminated intents', () => {
    const rates = entryFailureRates([
      row({ errorCode: 'limit_expired' }),
      row({ errorCode: 'ladder_no_fills' }),
      row({ exitReason: 'tp_hit' }),
      row({ exitReason: 'sl_hit' }),
    ])
    expect(rates).toEqual({
      total: 4,
      limitExpired: 1,
      ladderNoFills: 1,
      limitExpiredRate: 0.25,
      ladderNoFillsRate: 0.25,
    })
  })
})

describe('15 §4 row 7 — S6 event-timeout rate', () => {
  it('divides funding_event_timeout terminations by S6 intents only', () => {
    const result = computed(
      eventTimeoutRate([
        row({ strategy: 's6', errorCode: 'funding_event_timeout' }),
        row({ strategy: 's6', exitReason: 'tp_hit' }),
        row({ strategy: 's6', exitReason: 'timed' }),
        row({ strategy: 's6', exitReason: 'timed' }),
        // Another strategy's timeout-shaped row must not dilute or inflate the S6 rate.
        row({ strategy: 's1', errorCode: 'funding_event_timeout' }),
      ]),
    )
    expect(result).toEqual({ total: 4, timeouts: 1, rate: 0.25 })
  })

  it('is insufficient_data when the range holds no S6 intents', () => {
    expect(eventTimeoutRate([row({ strategy: 's1' })])).toMatchObject({ status: 'insufficient_data' })
  })
})

describe('blocked metrics — inputs never persisted', () => {
  // Each keeps a stable `insufficient_data` shape so 0500's canary gate compiles against it
  // today; the capture that unblocks them is out of scope here (SUGGESTIONS).
  it('15 §4 row 5 — P_avg vs P_ref is insufficient_data (no P_ref is persisted)', () => {
    expect(pAvgVsPRef()).toMatchObject({ status: 'insufficient_data' })
  })

  it('15 §4 row 6 — drop-depth ÷ |F| is insufficient_data (no price timeseries is persisted)', () => {
    expect(dropDepthToFunding()).toMatchObject({ status: 'insufficient_data' })
  })

  it('15 §4 row 7 — S6 realized PRE overhead (bp) is insufficient_data (PRE-leg fills not persisted)', () => {
    expect(s6PreOverheadBp()).toMatchObject({ status: 'insufficient_data' })
  })

  it('15 §4 row 7 — S6 MAIN slippage is insufficient_data (no expected-fill reference persisted)', () => {
    expect(s6MainSlippage()).toMatchObject({ status: 'insufficient_data' })
  })
})

describe('kill criterion — S1-WS median |DELTA_PNL|/|F| (02 §4)', () => {
  // |F| = 0.4, takerFeePct = 0.05 ⇒ threshold = (0.4 − 2×0.05)/0.4 = 0.75.
  const FEES = { takerFeePct: 0.05 }
  const events = [funding({ strategy: 's1-ws' })]

  function wsRow(pExit: number, intentId: string): PnlRow {
    return row({ intentId, strategy: 's1-ws', pEntry: 100, pExit })
  }

  it('verdict `kill` when the realized median ratio reaches (|F| − fees)/|F|', () => {
    // −0.32%, −0.36%, −0.40% ⇒ ratios 0.80, 0.90, 1.00 ⇒ median 0.90 ≥ 0.75.
    const verdict = computed(
      s1wsKillCriterion([wsRow(99.68, 'i1'), wsRow(99.64, 'i2'), wsRow(99.6, 'i3')], events, FEES),
    )
    expect(verdict.threshold).toBeCloseTo(0.75, 10)
    expect(verdict.value).toBeCloseTo(0.9, 10)
    expect(verdict.verdict).toBe('kill')
  })

  it('verdict `ok` on the same threshold when the realized median ratio sits below it', () => {
    // −0.08%, −0.12%, −0.16% ⇒ ratios 0.20, 0.30, 0.40 ⇒ median 0.30 < 0.75.
    const verdict = computed(
      s1wsKillCriterion([wsRow(99.92, 'i1'), wsRow(99.88, 'i2'), wsRow(99.84, 'i3')], events, FEES),
    )
    expect(verdict.threshold).toBeCloseTo(0.75, 10)
    expect(verdict.value).toBeCloseTo(0.3, 10)
    expect(verdict.verdict).toBe('ok')
  })

  it('ignores other strategies’ trades, and is insufficient_data with no S1-WS observation', () => {
    expect(s1wsKillCriterion([row({ strategy: 's1', pEntry: 100, pExit: 99.6 })], events, FEES)).toMatchObject({
      status: 'insufficient_data',
    })
  })
})

describe('kill criterion — S2 path-mix-weighted break-even (03 §4)', () => {
  function s2Row(exitReason: PnlRow['exitReason'], netPnl: number, intentId: string): PnlRow {
    return row({ intentId, strategy: 's2', exitReason, netPnl })
  }

  it('verdict `ok` when the realized path mix keeps E[NET] positive', () => {
    // p_tp = 2/3 at +0.33, p_sl = 1/3 at −0.50 ⇒ E[NET] = 0.22 − 0.16667 = +0.05333.
    const verdict = computed(
      s2BreakEven([s2Row('tp_hit', 0.33, 'i1'), s2Row('tp_hit', 0.33, 'i2'), s2Row('sl_hit', -0.5, 'i3')]),
    )
    expect(verdict.value).toBeCloseTo(0.0533333, 6)
    expect(verdict.verdict).toBe('ok')
  })

  it('verdict `kill` when the SL path is heavy enough to sink E[NET]', () => {
    // Same mix, worse SL: E[NET] = 0.22 − 0.33333 = −0.11333.
    const verdict = computed(
      s2BreakEven([s2Row('tp_hit', 0.33, 'i1'), s2Row('tp_hit', 0.33, 'i2'), s2Row('sl_hit', -1, 'i3')]),
    )
    expect(verdict.value).toBeCloseTo(-0.1133333, 6)
    expect(verdict.verdict).toBe('kill')
  })

  it('is insufficient_data when the range holds no S2 trades', () => {
    expect(s2BreakEven([row({ strategy: 's1', netPnl: 5 })])).toMatchObject({ status: 'insufficient_data' })
  })
})
