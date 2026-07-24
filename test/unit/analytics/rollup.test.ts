/**
 * Unit tier (task 0410) — the `15` §5 fleet rollup as pure aggregations over hand-built
 * rows: grouping by the instance triple (there is no `instance_id` column), the
 * per-strategy / per-exchange breakdowns, the funding-attribution audit, and the
 * reconciliation-diff summary. The DB-side proof (two seeded instances, one query never
 * seeing the other) lives in `test/integration/analytics.test.ts`.
 *
 * Money is quote currency (0390's `00_globals` §8.3 deviation) — these are quote sums.
 */

import { describe, expect, it } from 'vitest'
import { buildReport } from '../../../src/analytics/index.js'
import {
  byExchange,
  byStrategy,
  fleetPnl,
  fundingAttributionAudit,
  reconciliationSummary,
} from '../../../src/analytics/rollup.js'
import type { AnalyticsRows, FundingEventRow, PnlRow, ReconciliationRow } from '../../../src/analytics/types.js'

function row(overrides: Partial<PnlRow> = {}): PnlRow {
  return {
    exchange: 'binance',
    strategy: 's1',
    subaccount: 'a',
    intentId: 'i1',
    deltaPnl: 0,
    fundingPnl: 0,
    feeCost: 0,
    netPnl: 0,
    fillCount: 1,
    fundingReceived: true,
    ...overrides,
  }
}

describe('15 §5 fleet rollup — grouping by the instance triple', () => {
  const rows = [
    row({ intentId: 'i1', deltaPnl: -1, fundingPnl: 4, feeCost: 0.5, netPnl: 2.5 }),
    row({ intentId: 'i2', deltaPnl: -2, fundingPnl: 4, feeCost: 0.5, netPnl: 1.5 }),
    row({ intentId: 'i3', subaccount: 'b', strategy: 's2', deltaPnl: 1, fundingPnl: 3, feeCost: 1, netPnl: 3 }),
    row({ intentId: 'i4', exchange: 'bybit', strategy: 's2', deltaPnl: 0, fundingPnl: 2, feeCost: 1, netPnl: 1 }),
  ]

  it('sums each money column per (exchange, strategy, subaccount)', () => {
    const byInstance = fleetPnl(rows)
    expect(byInstance).toHaveLength(3)
    expect(byInstance[0]).toEqual({
      exchange: 'binance',
      strategy: 's1',
      subaccount: 'a',
      trades: 2,
      deltaPnl: -3,
      fundingPnl: 8,
      feeCost: 1,
      netPnl: 4,
    })
  })

  it('breaks the same rows down per strategy and per exchange', () => {
    expect(byStrategy(rows).map((g) => [g.key, g.trades, g.netPnl])).toEqual([
      ['s1', 2, 4],
      ['s2', 2, 4],
    ])
    expect(byExchange(rows).map((g) => [g.key, g.trades, g.netPnl])).toEqual([
      ['binance', 3, 7],
      ['bybit', 1, 1],
    ])
  })

  it('returns empty groups for an empty row set rather than a zero-filled row', () => {
    expect(fleetPnl([])).toEqual([])
    expect(byStrategy([])).toEqual([])
  })
})

describe('15 §5 funding-attribution audit', () => {
  it('diffs booked funding_pnl against venue-settled funding_events per instance', () => {
    const pnlRows = [row({ intentId: 'i1', fundingPnl: -4 }), row({ intentId: 'i2', fundingPnl: -3 })]
    const events: FundingEventRow[] = [
      { exchange: 'binance', strategy: 's1', subaccount: 'a', symbol: 'BTCUSDT', fundingTime: 1, amount: -4 },
      { exchange: 'binance', strategy: 's1', subaccount: 'a', symbol: 'BTCUSDT', fundingTime: 2, amount: -3 },
      // Settled but never claimed by an intent — exactly the drift this audit exists to surface.
      { exchange: 'binance', strategy: 's1', subaccount: 'a', symbol: 'ETHUSDT', fundingTime: 3, amount: -1 },
    ]
    expect(fundingAttributionAudit(pnlRows, events)).toEqual([
      {
        exchange: 'binance',
        strategy: 's1',
        subaccount: 'a',
        bookedFundingPnl: -7,
        settledFundingAmount: -8,
        diff: 1,
      },
    ])
  })

  it('reports an instance that settled funding but booked no trade', () => {
    const events: FundingEventRow[] = [
      { exchange: 'binance', strategy: 's6', subaccount: 'c', symbol: 'BTCUSDT', fundingTime: 1, amount: 5 },
    ]
    expect(fundingAttributionAudit([], events)).toEqual([
      {
        exchange: 'binance',
        strategy: 's6',
        subaccount: 'c',
        bookedFundingPnl: 0,
        settledFundingAmount: 5,
        diff: -5,
      },
    ])
  })
})

describe('reconciliation summary (15 §2 diffs, written by 0400)', () => {
  function diff(overrides: Partial<ReconciliationRow>): ReconciliationRow {
    return {
      exchange: 'binance',
      strategy: 's1',
      subaccount: 'a',
      symbol: 'BTCUSDT',
      dimension: 'fills',
      engineValue: 1,
      venueValue: 1.1,
      resolution: 'venue_wins',
      withinTolerance: true,
      ts: 1,
      ...overrides,
    }
  }

  it('counts diffs by dimension, by resolution, and how many broke tolerance', () => {
    expect(
      reconciliationSummary([
        diff({}),
        diff({ dimension: 'funding' }),
        diff({ dimension: 'position', resolution: 'desync', withinTolerance: false }),
      ]),
    ).toEqual({
      total: 3,
      beyondTolerance: 1,
      byDimension: { fills: 1, funding: 1, position: 1 },
      byResolution: { venue_wins: 2, desync: 1 },
    })
  })
})

describe('report assembly', () => {
  it('emits every 15 §4 metric key, blocked ones carrying insufficient_data', () => {
    const rows: AnalyticsRows = { pnl: [], fills: [], fundingEvents: [], reconciliation: [] }
    const report = buildReport(rows, { query: {}, takerFeePct: 0.05 })

    expect(Object.keys(report.metrics).sort()).toEqual(
      [
        'deadlineExits',
        'deltaToFundingRatio',
        'dropDepthToFunding',
        'entryFailureRates',
        'fillCountHistogram',
        'netPnlByDropOffset',
        'pAvgVsPRef',
        's6EventTimeoutRate',
        's6MainSlippage',
        's6PreOverheadBp',
        'pathMix',
      ].sort(),
    )
    for (const blocked of [
      report.metrics.pAvgVsPRef,
      report.metrics.dropDepthToFunding,
      report.metrics.s6PreOverheadBp,
      report.metrics.s6MainSlippage,
    ]) {
      expect(blocked).toMatchObject({ status: 'insufficient_data' })
    }
    expect(report.rowCounts).toEqual({ pnl: 0, fills: 0, fundingEvents: 0, reconciliation: 0 })
    expect(report.killCriteria.s1wsRatio).toMatchObject({ status: 'insufficient_data' })
  })
})
