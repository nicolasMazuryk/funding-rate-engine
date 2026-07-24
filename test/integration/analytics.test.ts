/**
 * Integration tier (task 0410) — the analytics loaders + fleet rollup against a live
 * Postgres (`docker compose up -d`). Mirrors the `repo-idempotency.test.ts` bring-up:
 * migrate once, `TRUNCATE` the touched tables per test.
 *
 * Proves the four things only a real DB can prove (`15` §4/§5 DoD):
 *   1. Each loader reads its rows back numerically, including the `pnl` → `intents` join
 *      that supplies `symbol` / `t_settle_ms`.
 *   2. The rollup groups by the instance triple across **two** seeded instances.
 *   3. A single-instance query never sees the other instance's rows.
 *   4. `npm run analytics -- --json` over the seeded DB emits parseable JSON carrying every
 *      metric key, blocked ones as `insufficient_data`.
 */

import { execFileSync } from 'node:child_process'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runAnalytics } from '../../src/analytics/index.js'
import { loadFills, loadFundingEvents, loadPnlRows, loadReconciliation } from '../../src/analytics/queries.js'
import type { AnalyticsReport } from '../../src/analytics/types.js'
import { fills, fundingEvents, intents, pnl, reconciliation } from '../../src/persistence/db/schema.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://funding:funding@localhost:5432/funding_drop'

const TAKER_FEE_PCT = 0.05
const TABLES = 'intents, pnl, fills, funding_events, reconciliation'

/** Instance A: an S1-WS book with prices + settled funding rates — the ratio metrics' input. */
const A = { exchange: 'binance', strategy: 's1-ws', subaccount: 'a' } as const
/** Instance B: an S2 book on the same DB — the isolation counterparty. */
const B = { exchange: 'binance', strategy: 's2', subaccount: 'b' } as const

const T_SETTLE_A = 1_700_000_000_000
const T_SETTLE_B = 1_700_003_600_000

let pool: Pool
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL })
  await migrate(drizzle(pool), { migrationsFolder: 'src/persistence/db/migrations' })
  db = drizzle(pool)
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query(`TRUNCATE ${TABLES}`)
  await seed()
})

/**
 * Two instances of known trades. A: `|DELTA_PNL|/|F|` of 0.30 and 0.60 against a settled
 * −0.4% rate; B: one `tp_hit` at +3 and one `deadline` at −1, so its realized break-even
 * expectation is +1 (quote ccy).
 */
async function seed(): Promise<void> {
  await db.insert(intents).values([
    { ...A, intentId: 'a1', symbol: 'BTCUSDT', tSettleMs: T_SETTLE_A, state: 'CLOSED' },
    { ...A, intentId: 'a2', symbol: 'BTCUSDT', tSettleMs: T_SETTLE_A, state: 'CLOSED' },
    { ...B, intentId: 'b1', symbol: 'ETHUSDT', tSettleMs: T_SETTLE_B, state: 'CLOSED' },
    { ...B, intentId: 'b2', symbol: 'ETHUSDT', tSettleMs: T_SETTLE_B, state: 'CLOSED' },
  ])

  await db.insert(pnl).values([
    {
      ...A,
      intentId: 'a1',
      pEntry: 100,
      pExit: 99.88,
      deltaPnl: -1,
      fundingPnl: 4,
      feeCost: 0.5,
      netPnl: 2.5,
      exitReason: 'timed',
      fillCount: 1,
      fundingReceived: true,
      tDropOffsetS: 1,
    },
    {
      ...A,
      intentId: 'a2',
      pEntry: 100,
      pExit: 99.76,
      deltaPnl: -2,
      fundingPnl: 4,
      feeCost: 0.5,
      netPnl: 1.5,
      exitReason: 'tp_hit',
      fillCount: 2,
      fundingReceived: true,
      tDropOffsetS: 3,
    },
    {
      ...B,
      intentId: 'b1',
      pEntry: 200,
      pExit: 202,
      deltaPnl: 2,
      fundingPnl: 2,
      feeCost: 1,
      netPnl: 3,
      exitReason: 'tp_hit',
      fillCount: 1,
      fundingReceived: true,
      tDropOffsetS: 2,
    },
    {
      ...B,
      intentId: 'b2',
      pEntry: 200,
      pExit: 198,
      deltaPnl: -2,
      fundingPnl: 2,
      feeCost: 1,
      netPnl: -1,
      exitReason: 'deadline',
      fillCount: 1,
      fundingReceived: true,
      tDropOffsetS: 4,
    },
  ])

  await db.insert(fundingEvents).values([
    { ...A, symbol: 'BTCUSDT', fundingTime: T_SETTLE_A, amount: 8, rate: -0.4 },
    { ...B, symbol: 'ETHUSDT', fundingTime: T_SETTLE_B, amount: 4, rate: -0.3 },
  ])

  await db.insert(fills).values([
    { ...A, clientOrderId: 'a1-entry-1', px: 100, qty: 1, ts: T_SETTLE_A - 1_000 },
    { ...A, clientOrderId: 'a1-exit-1', px: 99.88, qty: 1, ts: T_SETTLE_A + 1_000 },
    { ...B, clientOrderId: 'b1-entry-1', px: 200, qty: 1, ts: T_SETTLE_B - 1_000 },
  ])

  await db.insert(reconciliation).values([
    {
      ...A,
      intentId: 'a1',
      symbol: 'BTCUSDT',
      dimension: 'fills',
      engineValue: 0.5,
      venueValue: 0.52,
      resolution: 'venue_wins',
      withinTolerance: true,
      ts: T_SETTLE_A,
    },
    {
      ...B,
      symbol: 'ETHUSDT',
      dimension: 'position',
      engineValue: 1,
      venueValue: 0,
      resolution: 'desync',
      withinTolerance: false,
      ts: T_SETTLE_B,
    },
  ])
}

describe('analytics loaders (read-only, over seeded rows)', () => {
  it('loads pnl rows joined to their intent symbol + t_settle_ms', async () => {
    const rows = await loadPnlRows(db, A)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.intentId).sort()).toEqual(['a1', 'a2'])
    const [first] = rows.filter((r) => r.intentId === 'a1')
    expect(first).toMatchObject({ symbol: 'BTCUSDT', tSettleMs: T_SETTLE_A, netPnl: 2.5, exitReason: 'timed' })
  })

  it('loads fills, funding events and reconciliation diffs scoped to one instance', async () => {
    expect(await loadFills(db, A)).toHaveLength(2)
    expect((await loadFundingEvents(db, A)).map((e) => e.rate)).toEqual([-0.4])
    expect((await loadReconciliation(db, A)).map((r) => r.dimension)).toEqual(['fills'])
  })

  it('applies the time window (pnl through its intent t_settle_ms)', async () => {
    // A window strictly after A's settle keeps B's trades and drops A's.
    const rows = await loadPnlRows(db, { fromMs: T_SETTLE_A + 1 })
    expect(rows.map((r) => r.intentId).sort()).toEqual(['b1', 'b2'])
  })
})

describe('fleet rollup over two instances (15 §5)', () => {
  it('groups by the instance triple and breaks down per strategy', async () => {
    const report = await runAnalytics(db, { query: {}, takerFeePct: TAKER_FEE_PCT })
    expect(report.rowCounts.pnl).toBe(4)
    expect(report.rollup.byInstance).toHaveLength(2)
    expect(report.rollup.byInstance.map((r) => [r.strategy, r.trades, r.netPnl])).toEqual([
      ['s1-ws', 2, 4],
      ['s2', 2, 2],
    ])
    expect(report.rollup.byStrategy.map((g) => [g.key, g.netPnl])).toEqual([
      ['s1-ws', 4],
      ['s2', 2],
    ])
    expect(report.rollup.byExchange.map((g) => [g.key, g.trades])).toEqual([['binance', 4]])
  })

  it('audits booked funding against venue-settled funding per instance', async () => {
    const report = await runAnalytics(db, { query: {}, takerFeePct: TAKER_FEE_PCT })
    // A booked 4+4 and the venue settled 8 → no drift; B booked 2+2 against 4 → none either.
    expect(report.rollup.fundingAttribution.map((r) => r.diff)).toEqual([0, 0])
  })

  it('a single-instance query never sees the other instance (DoD-4)', async () => {
    const report = await runAnalytics(db, { query: A, takerFeePct: TAKER_FEE_PCT })
    expect(report.rowCounts.pnl).toBe(2)
    expect(report.rollup.byInstance).toHaveLength(1)
    expect(report.rollup.byInstance[0]).toMatchObject({ strategy: 's1-ws', subaccount: 'a', netPnl: 4 })
    expect(report.rollup.reconciliation.total).toBe(1)
    // B's S2 book is invisible: its break-even criterion has nothing to evaluate.
    expect(report.killCriteria.s2BreakEven).toMatchObject({ status: 'insufficient_data' })
  })
})

describe('metrics over seeded rows', () => {
  it('computes the S1-WS ratio + kill verdict from prices and the settled funding rate', async () => {
    const report = await runAnalytics(db, { query: A, takerFeePct: TAKER_FEE_PCT })
    // Ratios 0.30 and 0.60 ⇒ median 0.45; threshold (0.4 − 2×0.05)/0.4 = 0.75 ⇒ `ok`.
    expect(report.killCriteria.s1wsRatio).toMatchObject({ verdict: 'ok' })
    expect(report.metrics.deltaToFundingRatio).toMatchObject({ distribution: { count: 2 } })
  })

  it('computes the S2 realized break-even expectation from the seeded path mix', async () => {
    const report = await runAnalytics(db, { query: B, takerFeePct: TAKER_FEE_PCT })
    // p_tp = 0.5 at +3, p_deadline = 0.5 at −1 ⇒ E[NET] = +1 ⇒ `ok`.
    expect(report.killCriteria.s2BreakEven).toMatchObject({ value: 1, verdict: 'ok' })
    expect(report.metrics.deadlineExits.frequency).toBe(0.5)
  })
})

describe('CLI --json over the seeded DB (DoD-2)', () => {
  it('emits parseable JSON with every metric key, blocked ones as insufficient_data', () => {
    const stdout = execFileSync(
      'node',
      ['--experimental-transform-types', '--import', './scripts/register-ts.mjs', 'scripts/analytics.ts', '--json'],
      { env: { ...process.env, DATABASE_URL }, encoding: 'utf8' },
    )
    const report = JSON.parse(stdout) as AnalyticsReport

    expect(report.rowCounts.pnl).toBe(4)
    expect(Object.keys(report.metrics).sort()).toEqual(
      [
        'deadlineExits',
        'deltaToFundingRatio',
        'dropDepthToFunding',
        'entryFailureRates',
        'fillCountHistogram',
        'netPnlByDropOffset',
        'pAvgVsPRef',
        'pathMix',
        's6EventTimeoutRate',
        's6MainSlippage',
        's6PreOverheadBp',
      ].sort(),
    )
    expect(report.metrics.pAvgVsPRef).toMatchObject({ status: 'insufficient_data' })
    expect(report.metrics.dropDepthToFunding).toMatchObject({ status: 'insufficient_data' })
    expect(report.metrics.s6PreOverheadBp).toMatchObject({ status: 'insufficient_data' })
    expect(report.metrics.s6MainSlippage).toMatchObject({ status: 'insufficient_data' })
    expect(report.rollup.byInstance).toHaveLength(2)
  })
})
