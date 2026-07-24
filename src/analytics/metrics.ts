/**
 * The `15` §4 metric table as **pure functions over loaded rows** — no DB, no engine,
 * unit-testable with hand-built rows (task 0410). `queries.ts` does the reading;
 * everything here is arithmetic.
 *
 * Percent vs quote currency is the load-bearing distinction (`00_globals` §1.2). Money
 * metrics (`NET_PNL` sums, `DELTA_PNL` distributions) are **quote ccy** — that is what
 * 0390 persisted (its deliberate §8.3 deviation). The one inherently-*ratio* metric,
 * S1-WS's `|DELTA_PNL| / |F|`, is computed the financially-correct way instead: the
 * numerator is recomputed from prices as `(P_exit − P_entry)/P_entry × 100` and the
 * denominator is the venue-settled `funding_events.rate` (signed percent). A quote-ccy
 * numerator over a percent denominator would be a unit error, never do it.
 */

// The sidecar owns the ±window that matches a position to its settled funding event
// (`pnl-sidecar.ts`); analytics matches the same way so a metric and the booked row
// agree on which drop belongs to which trade.
import { FUNDING_MATCH_WINDOW_MS } from '../accounting/pnl-sidecar.js'
import { EXIT_REASONS } from '../core/intent/intent-machine.js'
import {
  type DeadlineExitStats,
  type Distribution,
  type DropOffsetBucket,
  type EntryFailureRates,
  type EventTimeoutRate,
  type FillCountHistogram,
  type FundingEventRow,
  insufficientData,
  type MetricResult,
  type NetPnlByDropOffset,
  type PathMix,
  type PnlRow,
  type RatioDistribution,
} from './types.js'

/** `t_drop_offset_s` buckets (`15` §4 row 2); `lt0` = the drop landed before settlement. */
const DROP_OFFSET_BUCKETS: readonly { readonly label: string; readonly max: number }[] = [
  { label: 'lt0', max: 0 },
  { label: '0-2', max: 2 },
  { label: '2-5', max: 5 },
  { label: '5-10', max: 10 },
  { label: 'gt10', max: Number.POSITIVE_INFINITY },
]

/** `|DELTA_PNL|/|F|` histogram edges — 0.75 is where the S1-WS kill threshold sits at |F|=0.4. */
const RATIO_HISTOGRAM_BUCKETS: readonly { readonly label: string; readonly max: number }[] = [
  { label: '0-0.25', max: 0.25 },
  { label: '0.25-0.5', max: 0.5 },
  { label: '0.5-0.75', max: 0.75 },
  { label: '0.75-1', max: 1 },
  { label: 'gte1', max: Number.POSITIVE_INFINITY },
]

// ── shared numerics ──────────────────────────────────────────────────────────────

/** Nearest-rank percentile over an already-sorted ascending array (`p` in `[0,1]`). */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length))
  return sorted[rank - 1] as number
}

/** Median: mean of the two middle values on an even count, so it is not biased upward. */
function median(sorted: readonly number[]): number {
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** Summarize a non-empty sample. Callers guarantee non-empty (empty → `insufficient_data`). */
export function describe(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    count: sorted.length,
    min: sorted[0] as number,
    median: median(sorted),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1] as number,
    mean: sum / sorted.length,
  }
}

/** Bucket a value by ascending upper edges (`< max`, last edge is `+∞`). */
function bucketLabel(value: number, buckets: readonly { readonly label: string; readonly max: number }[]): string {
  const hit = buckets.find((b) => value < b.max)
  return (hit ?? (buckets[buckets.length - 1] as { label: string })).label
}

// ── §4 row 1: path mix ───────────────────────────────────────────────────────────

/**
 * Frequency of each terminal `exit_reason` (`15` §4 row 1; S2/S3a/S4.1a/S4.2a). Every
 * canonical reason is always a key (0 when unseen) so the JSON shape is stable across
 * runs; `none` counts intents that terminated without a position (they carry an
 * `error_code` instead — see {@link entryFailureRates}).
 */
export function pathMix(rows: readonly PnlRow[]): PathMix {
  const counts: Record<string, number> = { none: 0 }
  for (const reason of EXIT_REASONS) counts[reason] = 0
  for (const row of rows) counts[row.exitReason ?? 'none'] = (counts[row.exitReason ?? 'none'] as number) + 1

  const frequencies: Record<string, number> = {}
  for (const [key, count] of Object.entries(counts)) frequencies[key] = rows.length === 0 ? 0 : count / rows.length
  return { total: rows.length, counts, frequencies }
}

// ── §4 row 2: NET_PNL by t_drop_offset_s ─────────────────────────────────────────

/** Σ/mean quote-ccy `net_pnl` per `t_drop_offset_s` bucket (`15` §4 row 2; S1/S1-WS/S3a). */
export function netPnlByDropOffset(rows: readonly PnlRow[]): NetPnlByDropOffset {
  const sums = new Map<string, { count: number; sum: number }>()
  for (const bucket of DROP_OFFSET_BUCKETS) sums.set(bucket.label, { count: 0, sum: 0 })

  let missingOffset = 0
  for (const row of rows) {
    if (row.tDropOffsetS === undefined) {
      missingOffset += 1
      continue
    }
    const acc = sums.get(bucketLabel(row.tDropOffsetS, DROP_OFFSET_BUCKETS)) as { count: number; sum: number }
    acc.count += 1
    acc.sum += row.netPnl
  }

  const buckets: DropOffsetBucket[] = DROP_OFFSET_BUCKETS.map(({ label }) => {
    const acc = sums.get(label) as { count: number; sum: number }
    return {
      bucket: label,
      count: acc.count,
      sumNetPnl: acc.sum,
      meanNetPnl: acc.count === 0 ? 0 : acc.sum / acc.count,
    }
  })
  return { buckets, missingOffset }
}

// ── §4 row 3: realized |DELTA_PNL| / |F| (S1-WS) ─────────────────────────────────

/** `DELTA_PNL` as a **percent** of entry, recomputed from prices (`15` §1 skeleton). */
export function deltaPnlPercent(row: PnlRow): number | undefined {
  if (row.pEntry === undefined || row.pExit === undefined || row.pEntry === 0) return undefined
  return ((row.pExit - row.pEntry) / row.pEntry) * 100
}

/**
 * `|F|` (percent) for a closed trade: the settled rate of the `funding_events` row on the
 * same instance + symbol nearest `T_settle`, within {@link FUNDING_MATCH_WINDOW_MS}.
 * Undefined when the trade has no symbol/settle time or no rate-carrying event matched.
 */
export function matchFundingRatePct(row: PnlRow, fundingEvents: readonly FundingEventRow[]): number | undefined {
  const { symbol, tSettleMs } = row
  if (symbol === undefined || tSettleMs === undefined) return undefined
  const candidates = fundingEvents.filter(
    (e) =>
      e.exchange === row.exchange &&
      e.strategy === row.strategy &&
      e.subaccount === row.subaccount &&
      e.symbol === symbol &&
      e.rate !== undefined &&
      Math.abs(e.fundingTime - tSettleMs) <= FUNDING_MATCH_WINDOW_MS,
  )
  if (candidates.length === 0) return undefined
  const nearest = candidates.reduce((best, e) =>
    Math.abs(e.fundingTime - tSettleMs) < Math.abs(best.fundingTime - tSettleMs) ? e : best,
  )
  return Math.abs(nearest.rate as number)
}

/** One realized observation behind the S1-WS ratio metric and its kill criterion. */
export interface RealizedRatio {
  readonly intentId: string
  /** `|DELTA_PNL%| / |F%|` — dimensionless. */
  readonly ratio: number
  /** `|F|`, percent. */
  readonly absFundingPct: number
}

/** The `(ratio, |F|)` pairs computable from these rows; trades missing either side are skipped. */
export function realizedRatios(
  rows: readonly PnlRow[],
  fundingEvents: readonly FundingEventRow[],
): readonly RealizedRatio[] {
  const out: RealizedRatio[] = []
  for (const row of rows) {
    const deltaPct = deltaPnlPercent(row)
    const absFundingPct = matchFundingRatePct(row, fundingEvents)
    if (deltaPct === undefined || absFundingPct === undefined || absFundingPct === 0) continue
    out.push({ intentId: row.intentId, ratio: Math.abs(deltaPct) / absFundingPct, absFundingPct })
  }
  return out
}

/** Distribution + histogram of realized `|DELTA_PNL| / |F|` (`15` §4 row 3; S1-WS `02` §4). */
export function deltaToFundingRatioDist(
  rows: readonly PnlRow[],
  fundingEvents: readonly FundingEventRow[],
): MetricResult<RatioDistribution> {
  const ratios = realizedRatios(rows, fundingEvents)
  if (ratios.length === 0) {
    return insufficientData('no closed trade has both an entry/exit price pair and a matched settled funding rate')
  }

  const histogram: Record<string, number> = {}
  for (const bucket of RATIO_HISTOGRAM_BUCKETS) histogram[bucket.label] = 0
  for (const { ratio } of ratios) {
    const label = bucketLabel(ratio, RATIO_HISTOGRAM_BUCKETS)
    histogram[label] = (histogram[label] as number) + 1
  }

  return {
    distribution: describe(ratios.map((r) => r.ratio)),
    histogram,
    unmatched: rows.length - ratios.length,
  }
}

// ── §4 row 4: S2 deadline exits ──────────────────────────────────────────────────

/** Deadline-exit frequency + the quote-ccy `DELTA_PNL` distribution on that path (`15` §4 row 4; S2 `03` §4). */
export function deadlineExitStats(rows: readonly PnlRow[]): DeadlineExitStats {
  const deadlines = rows.filter((r) => r.exitReason === 'deadline')
  return {
    total: rows.length,
    deadlineExits: deadlines.length,
    frequency: rows.length === 0 ? 0 : deadlines.length / rows.length,
    deltaPnl:
      deadlines.length === 0
        ? insufficientData('no deadline exits in range')
        : describe(deadlines.map((r) => r.deltaPnl)),
  }
}

// ── §4 row 5: fill count + entry-failure rates ───────────────────────────────────

/** Histogram of `pnl.fill_count` (`15` §4 row 5; S4.1a/S4.2a ladder fill quality). */
export function fillCountHistogram(rows: readonly PnlRow[]): FillCountHistogram {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const key = String(row.fillCount)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return { total: rows.length, counts }
}

/** `limit_expired` / `ladder_no_fills` rates over all terminated intents (`15` §4 row 5). */
export function entryFailureRates(rows: readonly PnlRow[]): EntryFailureRates {
  const limitExpired = rows.filter((r) => r.errorCode === 'limit_expired').length
  const ladderNoFills = rows.filter((r) => r.errorCode === 'ladder_no_fills').length
  const rate = (n: number): number => (rows.length === 0 ? 0 : n / rows.length)
  return {
    total: rows.length,
    limitExpired,
    ladderNoFills,
    limitExpiredRate: rate(limitExpired),
    ladderNoFillsRate: rate(ladderNoFills),
  }
}

// ── §4 row 7: S6 ─────────────────────────────────────────────────────────────────

/** S6 `funding_event_timeout` rate over S6 intents only (`15` §4 row 7; `07` §6 canary). */
export function eventTimeoutRate(rows: readonly PnlRow[]): MetricResult<EventTimeoutRate> {
  const s6 = rows.filter((r) => r.strategy === 's6')
  if (s6.length === 0) return insufficientData('no s6 intents in range')
  const timeouts = s6.filter((r) => r.errorCode === 'funding_event_timeout').length
  return { total: s6.length, timeouts, rate: timeouts / s6.length }
}

// ── Blocked metrics: the inputs were never persisted ─────────────────────────────
//
// Each keeps its report key with a stable `insufficient_data` shape so 0500's canary gate
// compiles against it today and gets real numbers the moment the capture lands. Adding
// that capture is out of scope here (it means amending 0390 + the engine); see SUGGESTIONS.

/** `P_avg` vs `P_ref` (`15` §4 row 5) — `P_ref`, the pre-event reference price, is never persisted. */
export function pAvgVsPRef(): MetricResult<never> {
  return insufficientData('P_ref (pre-event reference price) is not persisted; needs a price-snapshot capture')
}

/** Drop-depth ÷ `|F|` (`15` §4 row 6, S3a) — needs a post-settlement price timeseries nobody records. */
export function dropDepthToFunding(): MetricResult<never> {
  return insufficientData('drop-depth requires a post-T_drop price timeseries that is not persisted')
}

/** S6 realized PRE overhead in bp (`15` §4 row 7) — the PRE-leg fill facts never reach the `pnl` row. */
export function s6PreOverheadBp(): MetricResult<never> {
  return insufficientData('S6 PRE-leg fill px/qty are not threaded out of the entry sub-machine (0390 books 0)')
}

/** S6 MAIN slippage distribution (`15` §4 row 7) — no expected-fill reference is persisted to diff against. */
export function s6MainSlippage(): MetricResult<never> {
  return insufficientData('S6 MAIN slippage needs an expected-fill reference price that is not persisted')
}
