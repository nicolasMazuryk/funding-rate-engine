/**
 * Integration test for the full-schema idempotent repo writers (task 0360; `14`
 * §3–§4) against a live Postgres (`docker compose up -d`). Mirrors the
 * `forwarder.test.ts` bring-up: migrate once, `TRUNCATE` the touched tables per
 * test.
 *
 * Covers the two DoD properties per aggregate:
 *   1. Idempotency — a double-upsert by the natural key leaves exactly one row.
 *   2. Instance isolation — two repos with different instance triples cannot see
 *      each other's rows through their scoped reads/counts.
 *
 * Also drives the bus → Postgres projector twice over one fixed event stream and
 * asserts identical table counts (the replay-twice idempotency DoD).
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createEventBus } from '../../src/core/events/bus.js'
import type { EngineEvent } from '../../src/core/events/types.js'
import type { Instance } from '../../src/persistence/db/instance.js'
import { createPgRepo } from '../../src/persistence/db/repo.js'
import { createPersistenceProjector } from '../../src/persistence/projector.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://funding:funding@localhost:5432/funding_drop'

const INSTANCE_A: Instance = { exchange: 'binance', strategy: 's1', subaccount: 'a' }
const INSTANCE_B: Instance = { exchange: 'binance', strategy: 's1', subaccount: 'b' }

const TABLES = 'orders, fills, positions, funding_events, kill_switch, tracker_snapshots'

let adminPool: Pool
const openPools: Pool[] = []

function newPool(): Pool {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 })
  openPools.push(pool)
  return pool
}

async function rowCount(table: string, instance: Instance): Promise<number> {
  const { rows } = await adminPool.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE exchange = $1 AND strategy = $2 AND subaccount = $3`,
    [instance.exchange, instance.strategy, instance.subaccount],
  )
  return rows[0]?.n ?? 0
}

beforeAll(async () => {
  const migratePool = new Pool({ connectionString: DATABASE_URL })
  await migrate(drizzle(migratePool), { migrationsFolder: 'src/persistence/db/migrations' })
  await migratePool.end()
  adminPool = new Pool({ connectionString: DATABASE_URL })
})

afterAll(async () => {
  await adminPool.end()
})

beforeEach(async () => {
  await adminPool.query(`TRUNCATE ${TABLES}`)
})

afterEach(async () => {
  for (const pool of openPools.splice(0)) await pool.end().catch(() => {})
})

describe('repo idempotency (natural key → single row)', () => {
  it('upsertOrderStatus dedupes on client_order_id', async () => {
    const repo = createPgRepo({ pool: newPool(), instance: INSTANCE_A })
    await repo.upsertOrderStatus?.({ clientOrderId: 'c1', status: 'OPEN' })
    await repo.upsertOrderStatus?.({ clientOrderId: 'c1', status: 'FILLED', filledQty: 3 })
    expect(await rowCount('orders', INSTANCE_A)).toBe(1)
  })

  it('insertFill dedupes on (client_order_id, ts, qty)', async () => {
    const repo = createPgRepo({ pool: newPool(), instance: INSTANCE_A })
    const fill = { clientOrderId: 'c1', px: 100, qty: 2, ts: 1_000 }
    await repo.insertFill?.(fill)
    await repo.insertFill?.(fill)
    expect(await rowCount('fills', INSTANCE_A)).toBe(1)
  })

  it('upsertPosition dedupes on symbol', async () => {
    const repo = createPgRepo({ pool: newPool(), instance: INSTANCE_A })
    await repo.upsertPosition?.({ symbol: 'BTC', side: 'long', qty: 1, updatedTs: 1 })
    await repo.upsertPosition?.({ symbol: 'BTC', side: 'long', qty: 2, updatedTs: 2 })
    expect(await rowCount('positions', INSTANCE_A)).toBe(1)
  })

  it('upsertFundingEvent dedupes on (symbol, funding_time)', async () => {
    const repo = createPgRepo({ pool: newPool(), instance: INSTANCE_A })
    const ev = { symbol: 'BTC', fundingTime: 1_000, amount: -1.2 }
    await repo.upsertFundingEvent?.(ev)
    await repo.upsertFundingEvent?.(ev)
    expect(await rowCount('funding_events', INSTANCE_A)).toBe(1)
  })

  it('upsertKillSwitch keeps one row per instance', async () => {
    const repo = createPgRepo({ pool: newPool(), instance: INSTANCE_A })
    await repo.upsertKillSwitch?.({ state: 'paused', updatedTs: 1 })
    await repo.upsertKillSwitch?.({ state: 'flatten', updatedTs: 2 })
    expect(await rowCount('kill_switch', INSTANCE_A)).toBe(1)
  })

  it('upsertTrackerSnapshot dedupes on intent_id, round-trips via load', async () => {
    const repo = createPgRepo({ pool: newPool(), instance: INSTANCE_A })
    await repo.upsertTrackerSnapshot?.({ intentId: 'i1', snapshot: { peak: 100 }, updatedTs: 1 })
    await repo.upsertTrackerSnapshot?.({ intentId: 'i1', snapshot: { peak: 120 }, updatedTs: 2 })
    expect(await rowCount('tracker_snapshots', INSTANCE_A)).toBe(1)
    const loaded = await repo.loadTrackerSnapshots?.()
    expect(loaded).toEqual([{ intentId: 'i1', snapshot: { peak: 120 }, updatedTs: 2 }])
  })
})

describe('instance isolation (one instance cannot see another)', () => {
  it('scoped reads/counts never cross the triple', async () => {
    const repoA = createPgRepo({ pool: newPool(), instance: INSTANCE_A })
    const repoB = createPgRepo({ pool: newPool(), instance: INSTANCE_B })

    await repoA.upsertPosition?.({ symbol: 'BTC', side: 'long', qty: 1, updatedTs: 1 })
    await repoA.upsertTrackerSnapshot?.({ intentId: 'i1', snapshot: { a: 1 }, updatedTs: 1 })

    // Same natural keys under B are independent rows, invisible to A's scoped reads.
    await repoB.upsertPosition?.({ symbol: 'BTC', side: 'short', qty: 9, updatedTs: 1 })
    await repoB.upsertTrackerSnapshot?.({ intentId: 'i1', snapshot: { b: 2 }, updatedTs: 1 })

    expect(await rowCount('positions', INSTANCE_A)).toBe(1)
    expect(await rowCount('positions', INSTANCE_B)).toBe(1)
    expect(await repoA.loadTrackerSnapshots?.()).toEqual([{ intentId: 'i1', snapshot: { a: 1 }, updatedTs: 1 }])
    expect(await repoB.loadTrackerSnapshots?.()).toEqual([{ intentId: 'i1', snapshot: { b: 2 }, updatedTs: 1 }])
  })
})

describe('projector replay-twice idempotency', () => {
  const STREAM: EngineEvent[] = [
    { type: 'OrderUpdate', clientOrderId: 'c1', status: 'FILLED', fillPx: 100, qty: 2 },
    { type: 'PositionUpdate', symbol: 'BTC', qty: 2, side: 'long' },
    { type: 'FundingFeeAccrued', symbol: 'BTC', amount: -1.2, fundingTime: 5_000 },
    { type: 'OrderUpdate', clientOrderId: 'c2', status: 'OPEN' },
  ]

  /** Feed the fixed stream once through a fresh projector, with a deterministic clock. */
  async function replayOnce(repo: ReturnType<typeof createPgRepo>): Promise<void> {
    let t = 0
    const bus = createEventBus()
    const projector = createPersistenceProjector({ bus, repo, now: () => (t += 1) })
    for (const event of STREAM) bus.publish(event)
    // Fire-and-forget writes hit the network; poll until the row counts settle
    // before asserting (integration tier permits real waits).
    await waitForCount('orders', INSTANCE_A, 2)
    projector.stop()
  }

  /** Poll the scoped row count until it reaches `expected` or a timeout trips. */
  async function waitForCount(table: string, instance: Instance, expected: number): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      if ((await rowCount(table, instance)) >= expected) return
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('two passes over one stream on the same DB → identical counts', async () => {
    const repo = createPgRepo({ pool: newPool(), instance: INSTANCE_A })
    await replayOnce(repo)
    const after1 = {
      orders: await rowCount('orders', INSTANCE_A),
      fills: await rowCount('fills', INSTANCE_A),
      positions: await rowCount('positions', INSTANCE_A),
      funding: await rowCount('funding_events', INSTANCE_A),
    }
    await replayOnce(repo)
    const after2 = {
      orders: await rowCount('orders', INSTANCE_A),
      fills: await rowCount('fills', INSTANCE_A),
      positions: await rowCount('positions', INSTANCE_A),
      funding: await rowCount('funding_events', INSTANCE_A),
    }
    expect(after2).toEqual(after1)
    expect(after1).toEqual({ orders: 2, fills: 1, positions: 1, funding: 1 })
  })
})
