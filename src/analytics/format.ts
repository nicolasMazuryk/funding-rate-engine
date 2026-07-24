/**
 * Report output (task 0410): machine-readable JSON + a human-readable table.
 *
 * `toJson` is the contract 0500's canary gate and any downstream tooling read — every
 * metric key is present, blocked ones carrying `insufficient_data`. `toTable` is
 * hand-rolled aligned text, same idiom as `testnet/summary.ts` (no table library).
 */

import {
  type AnalyticsReport,
  type Distribution,
  isInsufficientData,
  type MetricResult,
  type ReconciliationSummary,
} from './types.js'

export function toJson(report: AnalyticsReport): string {
  return JSON.stringify(report)
}

/** Fixed 4-decimal money/ratio rendering — enough for quote-ccy cents and percent ratios. */
function num(value: number): string {
  return value.toFixed(4)
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`
}

function pad(text: string, width: number): string {
  return text.padEnd(width)
}

/** `k=v` pairs for a counts map, in insertion order (metrics build them deterministically). */
function pairs(counts: Readonly<Record<string, number>>, render: (n: number) => string = String): string {
  const entries = Object.entries(counts)
  if (entries.length === 0) return '(none)'
  return entries.map(([key, value]) => `${key}=${render(value)}`).join(' ')
}

function distLine(dist: MetricResult<Distribution>): string {
  if (isInsufficientData(dist)) return `insufficient_data — ${dist.reason}`
  return `n=${dist.count} min=${num(dist.min)} median=${num(dist.median)} p90=${num(dist.p90)} max=${num(dist.max)} mean=${num(dist.mean)}`
}

function reconLine(summary: ReconciliationSummary): string {
  return `total=${summary.total} beyond_tolerance=${summary.beyondTolerance} | ${pairs(summary.byDimension)} | ${pairs(summary.byResolution)}`
}

export function toTable(report: AnalyticsReport): string {
  const { query, rowCounts, metrics, killCriteria, rollup } = report
  const scope = [
    query.exchange ?? '*',
    query.strategy ?? '*',
    query.subaccount ?? '*',
    `[${query.fromMs ?? '-∞'}, ${query.toMs ?? '+∞'}]`,
  ].join(' / ')

  const lines: string[] = [
    `analytics: ${scope}`,
    `  rows: pnl=${rowCounts.pnl} fills=${rowCounts.fills} funding_events=${rowCounts.fundingEvents} reconciliation=${rowCounts.reconciliation}`,
    '',
    'metrics (15 §4)',
    `  ${pad('path mix', 26)} ${pairs(metrics.pathMix.frequencies, pct)}`,
    `  ${pad('fill-count histogram', 26)} ${pairs(metrics.fillCountHistogram.counts)}`,
    `  ${pad('entry failures', 26)} limit_expired=${pct(metrics.entryFailureRates.limitExpiredRate)} ladder_no_fills=${pct(metrics.entryFailureRates.ladderNoFillsRate)}`,
    `  ${pad('deadline exits (S2)', 26)} freq=${pct(metrics.deadlineExits.frequency)} DELTA_PNL ${distLine(metrics.deadlineExits.deltaPnl)}`,
  ]

  lines.push('  NET_PNL by t_drop_offset_s (quote ccy)')
  for (const bucket of metrics.netPnlByDropOffset.buckets) {
    lines.push(
      `    ${pad(bucket.bucket, 8)} n=${bucket.count} sum=${num(bucket.sumNetPnl)} mean=${num(bucket.meanNetPnl)}`,
    )
  }
  if (metrics.netPnlByDropOffset.missingOffset > 0) {
    lines.push(`    (no t_drop_offset_s: ${metrics.netPnlByDropOffset.missingOffset})`)
  }

  const ratio = metrics.deltaToFundingRatio
  lines.push('  |DELTA_PNL| / |F| (S1-WS)')
  if (isInsufficientData(ratio)) {
    lines.push(`    insufficient_data — ${ratio.reason}`)
  } else {
    lines.push(`    ${distLine(ratio.distribution)} unmatched=${ratio.unmatched}`)
    lines.push(`    histogram ${pairs(ratio.histogram)}`)
  }

  const timeout = metrics.s6EventTimeoutRate
  lines.push(
    `  ${pad('S6 event-timeout rate', 26)} ${
      isInsufficientData(timeout)
        ? `insufficient_data — ${timeout.reason}`
        : `${pct(timeout.rate)} (${timeout.timeouts}/${timeout.total})`
    }`,
  )

  lines.push('', 'blocked (source inputs never persisted)')
  for (const [name, metric] of [
    ['P_avg vs P_ref', metrics.pAvgVsPRef],
    ['drop-depth / |F| (S3a)', metrics.dropDepthToFunding],
    ['S6 PRE overhead (bp)', metrics.s6PreOverheadBp],
    ['S6 MAIN slippage', metrics.s6MainSlippage],
  ] as const) {
    lines.push(`  ${pad(name, 26)} ${isInsufficientData(metric) ? metric.reason : 'computed'}`)
  }

  lines.push('', 'kill criteria')
  for (const [name, criterion] of [
    ['S1-WS ratio (02 §4)', killCriteria.s1wsRatio],
    ['S2 break-even (03 §4)', killCriteria.s2BreakEven],
  ] as const) {
    lines.push(
      `  ${pad(name, 26)} ${
        isInsufficientData(criterion)
          ? `insufficient_data — ${criterion.reason}`
          : `${criterion.verdict.toUpperCase()} value=${num(criterion.value)} threshold=${num(criterion.threshold)}`
      }`,
    )
  }

  lines.push('', 'fleet rollup (15 §5, quote ccy)')
  for (const row of rollup.byInstance) {
    lines.push(
      `  ${pad(`${row.exchange}/${row.strategy}/${row.subaccount}`, 26)} trades=${row.trades} net=${num(row.netPnl)} delta=${num(row.deltaPnl)} funding=${num(row.fundingPnl)} fees=${num(row.feeCost)}`,
    )
  }
  for (const row of rollup.byStrategy) lines.push(`  ${pad(`strategy ${row.key}`, 26)} net=${num(row.netPnl)}`)
  for (const row of rollup.byExchange) lines.push(`  ${pad(`exchange ${row.key}`, 26)} net=${num(row.netPnl)}`)

  lines.push('', 'funding attribution audit')
  for (const row of rollup.fundingAttribution) {
    lines.push(
      `  ${pad(`${row.exchange}/${row.strategy}/${row.subaccount}`, 26)} booked=${num(row.bookedFundingPnl)} settled=${num(row.settledFundingAmount)} diff=${num(row.diff)}`,
    )
  }

  lines.push('', `reconciliation ${reconLine(rollup.reconciliation)}`)
  return lines.join('\n')
}
