/**
 * Analytics result types (task 0410; `15` §4/§5).
 *
 * Every metric returns a typed object. Metrics whose *source inputs were never
 * persisted* (a `P_ref` pre-event reference, a drop-depth timeseries, the S6 PRE-leg
 * fill facts, a MAIN expected-fill reference) return {@link InsufficientData} rather
 * than a fabricated number — the report key exists with a stable shape so 0500's canary
 * gate can consume it unchanged once that capture lands (see SUGGESTIONS).
 *
 * Units: `pnl` money columns are **quote currency** (0390's deliberate `00_globals` §8.3
 * deviation), so plain P&L sums here are quote amounts. The inherently-*percent* ratio
 * metrics never touch them — they recompute `DELTA_PNL%` from prices and read `|F|` from
 * `funding_events.rate` (signed percent). Timestamps are epoch ms UTC.
 */

import type { StrategyId } from '../config/canonical.js'
import type { ErrorCode, ExitReason } from '../core/intent/intent-machine.js'

/** Filter applied to every loader: instance columns + a time window (epoch ms UTC). */
export interface AnalyticsQuery {
  readonly exchange?: string
  readonly strategy?: StrategyId
  readonly subaccount?: string
  readonly fromMs?: number
  readonly toMs?: number
}

/** A metric that cannot be computed because its source input was never persisted. */
export interface InsufficientData {
  readonly status: 'insufficient_data'
  readonly reason: string
}

export type MetricResult<T> = T | InsufficientData

export function insufficientData(reason: string): InsufficientData {
  return { status: 'insufficient_data', reason }
}

export function isInsufficientData(result: unknown): result is InsufficientData {
  return typeof result === 'object' && result !== null && (result as InsufficientData).status === 'insufficient_data'
}

/** The instance triple every persisted row carries (`14` §3) — the rollup's `GROUP BY` key. */
export interface InstanceKey {
  readonly exchange: string
  readonly strategy: string
  readonly subaccount: string
}

/**
 * A `pnl` row widened with the two `intents` columns analytics needs and `pnl` lacks:
 * `symbol` (to match a funding event) and `tSettleMs` (the only timestamp a closed trade
 * has — `pnl` itself carries none, so the query's time window filters on it).
 */
export interface PnlRow extends InstanceKey {
  readonly intentId: string
  readonly symbol?: string
  readonly tSettleMs?: number
  readonly pEntry?: number
  readonly pExit?: number
  readonly pAvg?: number
  /** Price-move P&L, quote ccy. */
  readonly deltaPnl: number
  /** Funding P&L, quote ccy. */
  readonly fundingPnl: number
  /** Fee cost, quote ccy. */
  readonly feeCost: number
  /** Net P&L, quote ccy. */
  readonly netPnl: number
  readonly exitReason?: ExitReason
  readonly errorCode?: ErrorCode
  readonly holdDurationS?: number
  readonly fillCount: number
  readonly fundingReceived: boolean
  readonly tDropOffsetS?: number
}

export interface FillRow extends InstanceKey {
  readonly clientOrderId: string
  readonly px: number
  readonly qty: number
  readonly ts: number
  readonly feeClass?: string
}

export interface FundingEventRow extends InstanceKey {
  readonly symbol: string
  readonly fundingTime: number
  /** Settled amount, quote ccy, signed. */
  readonly amount: number
  /** Settled rate, signed **percent**; null when only the fee is known. */
  readonly rate?: number
}

export interface ReconciliationRow extends InstanceKey {
  readonly intentId?: string
  readonly symbol: string
  readonly dimension: string
  readonly engineValue: number
  readonly venueValue: number
  readonly resolution: string
  readonly withinTolerance: boolean
  readonly ts: number
}

/** Everything one loader pass returns; every metric is pure over this. */
export interface AnalyticsRows {
  readonly pnl: readonly PnlRow[]
  readonly fills: readonly FillRow[]
  readonly fundingEvents: readonly FundingEventRow[]
  readonly reconciliation: readonly ReconciliationRow[]
}

/** Nearest-rank distribution summary, in whatever unit the metric documents. */
export interface Distribution {
  readonly count: number
  readonly min: number
  readonly median: number
  readonly p90: number
  readonly max: number
  readonly mean: number
}

/** `15` §4 row 1 — path mix. Frequencies are fractions of `total` (sum to 1 ± float error). */
export interface PathMix {
  readonly total: number
  readonly counts: Readonly<Record<string, number>>
  readonly frequencies: Readonly<Record<string, number>>
}

export interface DropOffsetBucket {
  readonly bucket: string
  readonly count: number
  /** Σ `net_pnl`, quote ccy. */
  readonly sumNetPnl: number
  readonly meanNetPnl: number
}

/** `15` §4 row 2 — `NET_PNL` bucketed by `t_drop_offset_s`. */
export interface NetPnlByDropOffset {
  readonly buckets: readonly DropOffsetBucket[]
  /** Rows with no `t_drop_offset_s` (never bucketed, never silently folded into one). */
  readonly missingOffset: number
}

/** `15` §4 row 3 — realized `|DELTA_PNL| / |F|`, both sides recomputed as percent. */
export interface RatioDistribution {
  readonly distribution: Distribution
  /** `[0,0.25) [0.25,0.5) [0.5,0.75) [0.75,1) [1,∞)` counts. */
  readonly histogram: Readonly<Record<string, number>>
  /** Closed trades dropped for want of a price pair or a matched funding rate. */
  readonly unmatched: number
}

/** `15` §4 row 4 — S2 deadline-exit frequency + its `DELTA_PNL` distribution (quote ccy). */
export interface DeadlineExitStats {
  readonly total: number
  readonly deadlineExits: number
  readonly frequency: number
  readonly deltaPnl: MetricResult<Distribution>
}

/** `15` §4 row 5 (part) — fill-count histogram, keyed by fill count. */
export interface FillCountHistogram {
  readonly total: number
  readonly counts: Readonly<Record<string, number>>
}

/** `15` §4 row 5 (part) — `limit_expired` / `ladder_no_fills` rates. */
export interface EntryFailureRates {
  readonly total: number
  readonly limitExpired: number
  readonly ladderNoFills: number
  readonly limitExpiredRate: number
  readonly ladderNoFillsRate: number
}

/** `15` §4 row 7 (part) — S6 `funding_event_timeout` rate over S6 intents. */
export interface EventTimeoutRate {
  readonly total: number
  readonly timeouts: number
  readonly rate: number
}

/** A spec-stated kill/break-even criterion evaluated over realized trades. */
export interface CriterionVerdict {
  readonly metric: string
  readonly value: number
  readonly threshold: number
  readonly verdict: 'kill' | 'ok'
}

export interface InstanceRollup extends InstanceKey {
  readonly trades: number
  readonly deltaPnl: number
  readonly fundingPnl: number
  readonly feeCost: number
  readonly netPnl: number
}

/** A rollup grouped by one column (`strategy` or `exchange`) rather than the full triple. */
export interface GroupRollup {
  readonly key: string
  readonly trades: number
  readonly deltaPnl: number
  readonly fundingPnl: number
  readonly feeCost: number
  readonly netPnl: number
}

/** Per-instance Σ booked `funding_pnl` vs Σ venue-settled `funding_events.amount` (`15` §5). */
export interface FundingAttributionRow extends InstanceKey {
  readonly bookedFundingPnl: number
  readonly settledFundingAmount: number
  readonly diff: number
}

export interface ReconciliationSummary {
  readonly total: number
  readonly beyondTolerance: number
  readonly byDimension: Readonly<Record<string, number>>
  readonly byResolution: Readonly<Record<string, number>>
}

export interface FleetRollup {
  readonly byInstance: readonly InstanceRollup[]
  readonly byStrategy: readonly GroupRollup[]
  readonly byExchange: readonly GroupRollup[]
  readonly fundingAttribution: readonly FundingAttributionRow[]
  readonly reconciliation: ReconciliationSummary
}

/** The `15` §4 metric table, one key per row — blocked ones carry `insufficient_data`. */
export interface AnalyticsMetrics {
  readonly pathMix: PathMix
  readonly netPnlByDropOffset: NetPnlByDropOffset
  readonly deltaToFundingRatio: MetricResult<RatioDistribution>
  readonly deadlineExits: DeadlineExitStats
  readonly fillCountHistogram: FillCountHistogram
  readonly entryFailureRates: EntryFailureRates
  readonly s6EventTimeoutRate: MetricResult<EventTimeoutRate>
  readonly pAvgVsPRef: MetricResult<never>
  readonly dropDepthToFunding: MetricResult<never>
  readonly s6PreOverheadBp: MetricResult<never>
  readonly s6MainSlippage: MetricResult<never>
}

export interface AnalyticsKillCriteria {
  readonly s1wsRatio: MetricResult<CriterionVerdict>
  readonly s2BreakEven: MetricResult<CriterionVerdict>
}

export interface AnalyticsReport {
  readonly query: AnalyticsQuery
  readonly rowCounts: {
    readonly pnl: number
    readonly fills: number
    readonly fundingEvents: number
    readonly reconciliation: number
  }
  readonly metrics: AnalyticsMetrics
  readonly killCriteria: AnalyticsKillCriteria
  readonly rollup: FleetRollup
}
