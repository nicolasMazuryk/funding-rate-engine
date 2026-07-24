/**
 * Read-only loaders (task 0410). The only part of `src/analytics/` that touches a DB —
 * everything downstream is pure over the rows these return.
 *
 * Analytics is a **reader**: it never writes, and it deliberately bypasses the `Repo` port
 * (which is single-instance-scoped and has no bulk reads) to query the Drizzle tables
 * directly across instances — that is what the `15` §5 fleet rollup is. Instance isolation
 * is preserved by the query filter, not by a second connection: a query naming one triple
 * loads only that triple's rows.
 *
 * Time windows: `fills` / `funding_events` / `reconciliation` each carry their own
 * timestamp. `pnl` carries none, so a closed trade is placed in time by its intent's
 * `t_settle_ms` (joined from `intents`) — which is also where analytics gets the `symbol`
 * needed to match a trade to its settled funding event. A `pnl` row whose intent has no
 * `t_settle_ms` is therefore invisible to a *windowed* query (and visible to an unwindowed
 * one); that column's producer is the scheduler, and it is nullable until then.
 */

import { and, eq, gte, lte, type SQL } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/node-postgres'
import type { StrategyId } from '../config/canonical.js'
import type { ErrorCode, ExitReason } from '../core/intent/intent-machine.js'
import { fills, fundingEvents, intents, pnl, reconciliation } from '../persistence/db/schema.js'
import type { AnalyticsQuery, AnalyticsRows, FillRow, FundingEventRow, PnlRow, ReconciliationRow } from './types.js'

/** A Drizzle node-postgres handle (`drizzle(pool)`), owned by the caller. */
export type AnalyticsDb = ReturnType<typeof drizzle>

/** Columns every instance-scoped table carries; the query filters on whichever the caller pinned. */
interface InstanceColumns {
  readonly exchange: Parameters<typeof eq>[0]
  readonly strategy: Parameters<typeof eq>[0]
  readonly subaccount: Parameters<typeof eq>[0]
}

/** Instance-column equalities for whatever the query pinned — absent fields widen the scope. */
function instanceFilter(table: InstanceColumns, query: AnalyticsQuery): SQL[] {
  const conditions: SQL[] = []
  if (query.exchange !== undefined) conditions.push(eq(table.exchange, query.exchange))
  if (query.strategy !== undefined) conditions.push(eq(table.strategy, query.strategy))
  if (query.subaccount !== undefined) conditions.push(eq(table.subaccount, query.subaccount))
  return conditions
}

/** `[fromMs, toMs]` bounds on whichever timestamp column the table uses. */
function timeFilter(column: Parameters<typeof gte>[0], query: AnalyticsQuery): SQL[] {
  const conditions: SQL[] = []
  if (query.fromMs !== undefined) conditions.push(gte(column, query.fromMs))
  if (query.toMs !== undefined) conditions.push(lte(column, query.toMs))
  return conditions
}

/** `and()` of every condition, or `undefined` for an unfiltered (fleet-wide, all-time) query. */
function where(conditions: readonly SQL[]): SQL | undefined {
  return conditions.length === 0 ? undefined : and(...conditions)
}

/** Closed-trade rows, widened with the intent's `symbol` + `t_settle_ms` (see module note). */
export async function loadPnlRows(db: AnalyticsDb, query: AnalyticsQuery): Promise<readonly PnlRow[]> {
  const rows = await db
    .select({ pnl, symbol: intents.symbol, tSettleMs: intents.tSettleMs })
    .from(pnl)
    .leftJoin(
      intents,
      and(
        eq(pnl.intentId, intents.intentId),
        eq(pnl.exchange, intents.exchange),
        eq(pnl.strategy, intents.strategy),
        eq(pnl.subaccount, intents.subaccount),
      ),
    )
    .where(where([...instanceFilter(pnl, query), ...timeFilter(intents.tSettleMs, query)]))

  return rows.map((r) => ({
    exchange: r.pnl.exchange,
    strategy: r.pnl.strategy,
    subaccount: r.pnl.subaccount,
    intentId: r.pnl.intentId,
    symbol: r.symbol ?? undefined,
    tSettleMs: r.tSettleMs ?? undefined,
    pEntry: r.pnl.pEntry ?? undefined,
    pExit: r.pnl.pExit ?? undefined,
    pAvg: r.pnl.pAvg ?? undefined,
    deltaPnl: r.pnl.deltaPnl ?? 0,
    fundingPnl: r.pnl.fundingPnl ?? 0,
    feeCost: r.pnl.feeCost ?? 0,
    netPnl: r.pnl.netPnl ?? 0,
    exitReason: (r.pnl.exitReason ?? undefined) as ExitReason | undefined,
    errorCode: (r.pnl.errorCode ?? undefined) as ErrorCode | undefined,
    holdDurationS: r.pnl.holdDurationS ?? undefined,
    fillCount: r.pnl.fillCount ?? 0,
    fundingReceived: r.pnl.fundingReceived ?? false,
    tDropOffsetS: r.pnl.tDropOffsetS ?? undefined,
  }))
}

export async function loadFills(db: AnalyticsDb, query: AnalyticsQuery): Promise<readonly FillRow[]> {
  const rows = await db
    .select()
    .from(fills)
    .where(where([...instanceFilter(fills, query), ...timeFilter(fills.ts, query)]))
  return rows.map((r) => ({
    exchange: r.exchange,
    strategy: r.strategy,
    subaccount: r.subaccount,
    clientOrderId: r.clientOrderId,
    px: r.px,
    qty: r.qty,
    ts: r.ts,
    feeClass: r.feeClass ?? undefined,
  }))
}

export async function loadFundingEvents(db: AnalyticsDb, query: AnalyticsQuery): Promise<readonly FundingEventRow[]> {
  const rows = await db
    .select()
    .from(fundingEvents)
    .where(where([...instanceFilter(fundingEvents, query), ...timeFilter(fundingEvents.fundingTime, query)]))
  return rows.map((r) => ({
    exchange: r.exchange,
    strategy: r.strategy,
    subaccount: r.subaccount,
    symbol: r.symbol,
    fundingTime: r.fundingTime,
    amount: r.amount,
    rate: r.rate ?? undefined,
  }))
}

export async function loadReconciliation(
  db: AnalyticsDb,
  query: AnalyticsQuery,
): Promise<readonly ReconciliationRow[]> {
  const rows = await db
    .select()
    .from(reconciliation)
    .where(where([...instanceFilter(reconciliation, query), ...timeFilter(reconciliation.ts, query)]))
  return rows.map((r) => ({
    exchange: r.exchange,
    strategy: r.strategy,
    subaccount: r.subaccount,
    intentId: r.intentId ?? undefined,
    symbol: r.symbol,
    dimension: r.dimension,
    engineValue: r.engineValue,
    venueValue: r.venueValue,
    resolution: r.resolution,
    withinTolerance: r.withinTolerance,
    ts: r.ts,
  }))
}

/**
 * The one loader pass every metric runs over. Concurrent because the four reads are
 * independent and read-only — no ordering to preserve.
 */
export async function loadAnalyticsRows(db: AnalyticsDb, query: AnalyticsQuery): Promise<AnalyticsRows> {
  const [pnlRows, fillRows, fundingRows, reconRows] = await Promise.all([
    loadPnlRows(db, query),
    loadFills(db, query),
    loadFundingEvents(db, query),
    loadReconciliation(db, query),
  ])
  return { pnl: pnlRows, fills: fillRows, fundingEvents: fundingRows, reconciliation: reconRows }
}

/** Re-exported for the CLI's `--strategy` validation (the canonical id list, `09` §2). */
export type { StrategyId }
