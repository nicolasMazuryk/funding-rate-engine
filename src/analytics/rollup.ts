/**
 * Fleet-level rollup (`15` §5, task 0410) — pure aggregations over the rows the one
 * loader pass already read.
 *
 * `15` §5 describes the rollup as a read-only `GROUP BY exchange, strategy` over the
 * shared DB; grouping the loaded rows in TS is the same aggregation without a second
 * round trip, and it keeps the rollup unit-testable with hand-built rows. Instances stay
 * isolated because they always were: analytics only reads, and every row carries its own
 * triple, so a single-instance query simply never loads another instance's rows.
 *
 * Money is quote currency (0390's `00_globals` §8.3 deviation) — these are sums of
 * quote amounts, not percents.
 */

import type {
  FundingAttributionRow,
  FundingEventRow,
  GroupRollup,
  InstanceRollup,
  PnlRow,
  ReconciliationRow,
  ReconciliationSummary,
} from './types.js'

/** `exchange|strategy|subaccount` — the instance identity (there is no `instance_id` column). */
function instanceKey(row: { exchange: string; strategy: string; subaccount: string }): string {
  return `${row.exchange}|${row.strategy}|${row.subaccount}`
}

interface Totals {
  trades: number
  deltaPnl: number
  fundingPnl: number
  feeCost: number
  netPnl: number
}

function emptyTotals(): Totals {
  return { trades: 0, deltaPnl: 0, fundingPnl: 0, feeCost: 0, netPnl: 0 }
}

function addTo(totals: Totals, row: PnlRow): void {
  totals.trades += 1
  totals.deltaPnl += row.deltaPnl
  totals.fundingPnl += row.fundingPnl
  totals.feeCost += row.feeCost
  totals.netPnl += row.netPnl
}

/** Fleet P&L grouped by the full instance triple (`15` §5), sorted for a stable report. */
export function fleetPnl(rows: readonly PnlRow[]): readonly InstanceRollup[] {
  const groups = new Map<string, { key: PnlRow; totals: Totals }>()
  for (const row of rows) {
    const key = instanceKey(row)
    const group = groups.get(key) ?? { key: row, totals: emptyTotals() }
    addTo(group.totals, row)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, { key, totals }]) => ({
      exchange: key.exchange,
      strategy: key.strategy,
      subaccount: key.subaccount,
      ...totals,
    }))
}

/** Rollup grouped by a single instance column — the `15` §5 per-strategy / per-exchange breakdowns. */
function groupBy(rows: readonly PnlRow[], pick: (row: PnlRow) => string): readonly GroupRollup[] {
  const groups = new Map<string, Totals>()
  for (const row of rows) {
    const key = pick(row)
    const totals = groups.get(key) ?? emptyTotals()
    addTo(totals, row)
    groups.set(key, totals)
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, totals]) => ({ key, ...totals }))
}

export function byStrategy(rows: readonly PnlRow[]): readonly GroupRollup[] {
  return groupBy(rows, (row) => row.strategy)
}

export function byExchange(rows: readonly PnlRow[]): readonly GroupRollup[] {
  return groupBy(rows, (row) => row.exchange)
}

/**
 * Cross-venue funding-attribution audit (`15` §5): per instance, the funding the accounting
 * sidecar *booked* into `pnl.funding_pnl` against what the venue actually *settled* into
 * `funding_events.amount`. A non-zero `diff` means funding a trade never claimed (a settlement
 * outside any intent's match window) or a double-attribution — the audit `07` §2/§6 asks for.
 * Both sides are quote ccy and signed (credit +, charge −).
 */
export function fundingAttributionAudit(
  pnlRows: readonly PnlRow[],
  fundingEvents: readonly FundingEventRow[],
): readonly FundingAttributionRow[] {
  const booked = new Map<string, number>()
  const settled = new Map<string, number>()
  const keys = new Map<string, { exchange: string; strategy: string; subaccount: string }>()

  for (const row of pnlRows) {
    const key = instanceKey(row)
    keys.set(key, row)
    booked.set(key, (booked.get(key) ?? 0) + row.fundingPnl)
  }
  for (const event of fundingEvents) {
    const key = instanceKey(event)
    keys.set(key, event)
    settled.set(key, (settled.get(key) ?? 0) + event.amount)
  }

  return [...keys.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, identity]) => {
      const bookedFundingPnl = booked.get(key) ?? 0
      const settledFundingAmount = settled.get(key) ?? 0
      return {
        exchange: identity.exchange,
        strategy: identity.strategy,
        subaccount: identity.subaccount,
        bookedFundingPnl,
        settledFundingAmount,
        diff: bookedFundingPnl - settledFundingAmount,
      }
    })
}

/** Reconciliation-diff counts (`15` §2 rows, written by 0400) — how much drift the range saw. */
export function reconciliationSummary(rows: readonly ReconciliationRow[]): ReconciliationSummary {
  const byDimension: Record<string, number> = {}
  const byResolution: Record<string, number> = {}
  for (const row of rows) {
    byDimension[row.dimension] = (byDimension[row.dimension] ?? 0) + 1
    byResolution[row.resolution] = (byResolution[row.resolution] ?? 0) + 1
  }
  return {
    total: rows.length,
    beyondTolerance: rows.filter((r) => !r.withinTolerance).length,
    byDimension,
    byResolution,
  }
}
