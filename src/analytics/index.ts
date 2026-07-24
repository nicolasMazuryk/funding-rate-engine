/**
 * Analytics composition (task 0410): one loader pass → every `15` §4 metric, both spec
 * kill criteria, and the `15` §5 fleet rollup, assembled into one {@link AnalyticsReport}.
 *
 * `runAnalytics` is what the CLI (`scripts/analytics.ts`) and the integration test call;
 * `buildReport` is its pure half, so the whole report can be asserted from hand-built rows
 * with no DB. 0500's canary gate imports the individual metric / kill-criterion functions
 * directly rather than the report.
 */

import { s1wsKillCriterion, s2BreakEven } from './kill-criteria.js'
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
} from './metrics.js'
import { type AnalyticsDb, loadAnalyticsRows } from './queries.js'
import { byExchange, byStrategy, fleetPnl, fundingAttributionAudit, reconciliationSummary } from './rollup.js'
import type { AnalyticsQuery, AnalyticsReport, AnalyticsRows } from './types.js'

export interface AnalyticsOptions {
  readonly query: AnalyticsQuery
  /** Exchange taker fee, percent (`09` §4 profile) — the S1-WS kill threshold's `fees` term. */
  readonly takerFeePct: number
}

/** Pure: rows in, report out. Every metric key is always present, blocked ones as `insufficient_data`. */
export function buildReport(rows: AnalyticsRows, options: AnalyticsOptions): AnalyticsReport {
  const { pnl, fills, fundingEvents, reconciliation } = rows
  return {
    query: options.query,
    rowCounts: {
      pnl: pnl.length,
      fills: fills.length,
      fundingEvents: fundingEvents.length,
      reconciliation: reconciliation.length,
    },
    metrics: {
      pathMix: pathMix(pnl),
      netPnlByDropOffset: netPnlByDropOffset(pnl),
      deltaToFundingRatio: deltaToFundingRatioDist(pnl, fundingEvents),
      deadlineExits: deadlineExitStats(pnl),
      fillCountHistogram: fillCountHistogram(pnl),
      entryFailureRates: entryFailureRates(pnl),
      s6EventTimeoutRate: eventTimeoutRate(pnl),
      pAvgVsPRef: pAvgVsPRef(),
      dropDepthToFunding: dropDepthToFunding(),
      s6PreOverheadBp: s6PreOverheadBp(),
      s6MainSlippage: s6MainSlippage(),
    },
    killCriteria: {
      s1wsRatio: s1wsKillCriterion(pnl, fundingEvents, { takerFeePct: options.takerFeePct }),
      s2BreakEven: s2BreakEven(pnl),
    },
    rollup: {
      byInstance: fleetPnl(pnl),
      byStrategy: byStrategy(pnl),
      byExchange: byExchange(pnl),
      fundingAttribution: fundingAttributionAudit(pnl, fundingEvents),
      reconciliation: reconciliationSummary(reconciliation),
    },
  }
}

/** Read once, then assemble. The caller owns the pool/handle and closes it. */
export async function runAnalytics(db: AnalyticsDb, options: AnalyticsOptions): Promise<AnalyticsReport> {
  return buildReport(await loadAnalyticsRows(db, options.query), options)
}

export * from './format.js'
export * from './kill-criteria.js'
export * from './metrics.js'
export * from './queries.js'
export * from './rollup.js'
export * from './types.js'
