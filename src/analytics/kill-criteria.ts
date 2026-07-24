/**
 * The two criteria the strategy specs state numerically, evaluated over realized trades
 * (task 0410). Pure, like `metrics.ts` — 0500's canary gate imports these directly.
 *
 * Each returns `{metric, value, threshold, verdict}`; the verdict is the spec's own
 * comparison, not a judgement call added here. Both filter to their own strategy first:
 * an S1-WS kill criterion evaluated over a fleet-wide row set would be meaningless.
 */

import { describe, realizedRatios } from './metrics.js'
import type { PnlRow } from './types.js'
import { type CriterionVerdict, type FundingEventRow, insufficientData, type MetricResult } from './types.js'

/**
 * S1-WS (`02` §4): *"live trade data must be monitored for the realized `|DELTA_PNL|/|F|`
 * ratio distribution; a median ≥ `(|F| − fees)/|F|` kills the strategy at that threshold."*
 *
 * `fees = 2 × takerFeePct` (entry + exit taker, `02` §4 skeleton). `|F|` in the threshold is
 * the median realized funding rate of the same observations — the strategy is judged against
 * the funding it actually harvested, not a configured floor.
 */
export function s1wsKillCriterion(
  rows: readonly PnlRow[],
  fundingEvents: readonly FundingEventRow[],
  { takerFeePct }: { readonly takerFeePct: number },
): MetricResult<CriterionVerdict> {
  const ratios = realizedRatios(
    rows.filter((r) => r.strategy === 's1-ws'),
    fundingEvents,
  )
  if (ratios.length === 0) return insufficientData('no s1-ws trade has both a price pair and a matched funding rate')

  const medianRatio = describe(ratios.map((r) => r.ratio)).median
  const medianAbsF = describe(ratios.map((r) => r.absFundingPct)).median
  const threshold = (medianAbsF - 2 * takerFeePct) / medianAbsF
  return {
    metric: 'median |DELTA_PNL| / |F|',
    value: medianRatio,
    threshold,
    verdict: medianRatio >= threshold ? 'kill' : 'ok',
  }
}

/**
 * S2 (`03` §4): *"break-even requires roughly `p_sl+deadline-loss` weighted below ~40% — live
 * monitoring must confirm the realized path mix."* Evaluated as the realized path-mix-weighted
 * expectation `E[NET] = Σ_path p_path × mean(NET_PNL | path)`, which is algebraically the mean
 * realized `NET_PNL` but reported per path so the mix that produced it is visible.
 *
 * Units: quote currency (0390's §8.3 deviation), so the threshold is a plain 0 — a strategy
 * whose realized expectation is not positive does not clear its own break-even condition.
 */
export function s2BreakEven(rows: readonly PnlRow[]): MetricResult<CriterionVerdict> {
  const s2 = rows.filter((r) => r.strategy === 's2')
  if (s2.length === 0) return insufficientData('no s2 trades in range')

  const byPath = new Map<string, number[]>()
  for (const row of s2) {
    const path = row.exitReason ?? 'none'
    const bucket = byPath.get(path) ?? []
    bucket.push(row.netPnl)
    byPath.set(path, bucket)
  }

  let expectedNet = 0
  for (const nets of byPath.values()) {
    const pathProbability = nets.length / s2.length
    const meanNet = nets.reduce((acc, v) => acc + v, 0) / nets.length
    expectedNet += pathProbability * meanNet
  }

  return {
    metric: 'path-mix-weighted E[NET_PNL] (quote ccy)',
    value: expectedNet,
    threshold: 0,
    verdict: expectedNet > 0 ? 'ok' : 'kill',
  }
}
