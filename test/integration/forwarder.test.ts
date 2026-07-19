/**
 * Integration test for the tier-2 WAL forwarder (`14` §2.1, §4) against a live
 * Postgres (`docker compose up -d`). Self-contained: runs migrations and
 * truncates the two tables it touches before each test.
 *
 * Covers the three properties from task 0080:
 *   1. N local entries forward into `intent_wal` exactly once.
 *   2. Re-forwarding the same file adds zero rows (idempotent natural key +
 *      watermark re-derivation on restart).
 *   3. The forwarder survives Postgres being unreachable — it does not throw,
 *      the local WAL keeps accepting appends, and it catches up once the DB is
 *      back. (Reachability loss is simulated by an ended pool; the manual
 *      `docker compose stop/start` path in the task's verification exercises the
 *      real lifecycle.)
 */

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransitionLogEntry } from '../../src/core/ports/transition-log.js'
import { DEV_INSTANCE } from '../../src/persistence/db/instance.js'
import { intentWal } from '../../src/persistence/db/schema.js'
import { createForwarder } from '../../src/persistence/wal/forwarder.js'
import { createWalFile, type WalFile } from '../../src/persistence/wal/wal-file.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://funding:funding@localhost:5432/funding_drop'

let adminPool: Pool
let tmp: TempDir
let walPath: string
const openPools: Pool[] = []
let openWal: WalFile | undefined

/** A pool tracked for teardown. */
function newPool(): Pool {
  const pool = new Pool({ connectionString: DATABASE_URL })
  openPools.push(pool)
  return pool
}

function entry(i: number): TransitionLogEntry {
  return {
    ts: 1_000 + i,
    intentId: `intent-${i}`,
    fromState: 'SELECTED',
    toState: 'SUBMITTING_ENTRY',
    payload: { i },
  }
}

async function walRowCount(): Promise<number> {
  const db = drizzle(adminPool)
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(intentWal)
  return row?.n ?? 0
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
  await adminPool.query('TRUNCATE intents, intent_wal')
  tmp = tempDir('forwarder-test-')
  walPath = tmp.walPath
})

afterEach(async () => {
  openWal?.close()
  openWal = undefined
  for (const pool of openPools.splice(0)) {
    // Ended pools throw on end(); ignore — they were ended deliberately in-test.
    await pool.end().catch(() => {})
  }
  tmp.dispose()
})

describe('WAL forwarder', () => {
  it('forwards N local entries into intent_wal exactly once', async () => {
    const wal = createWalFile({ path: walPath })
    openWal = wal
    const n = 5
    for (let i = 0; i < n; i += 1) await wal.append(entry(i))

    const forwarder = createForwarder({ wal, pool: newPool(), instance: DEV_INSTANCE })
    await forwarder.tick()

    expect(await walRowCount()).toBe(n)
  })

  it('re-forwarding the same file adds zero rows (idempotent + watermark re-derived)', async () => {
    const wal = createWalFile({ path: walPath })
    openWal = wal
    const n = 4
    for (let i = 0; i < n; i += 1) await wal.append(entry(i))

    await createForwarder({ wal, pool: newPool(), instance: DEV_INSTANCE }).tick()
    expect(await walRowCount()).toBe(n)

    // Fresh forwarder (simulates a restart: watermark re-derived from MAX(seq)).
    await createForwarder({ wal, pool: newPool(), instance: DEV_INSTANCE }).tick()
    expect(await walRowCount()).toBe(n)
  })

  it('survives an unreachable Postgres, then catches up once it is back', async () => {
    const wal = createWalFile({ path: walPath })
    openWal = wal
    for (let i = 0; i < 3; i += 1) await wal.append(entry(i))

    // Simulate the DB being unreachable: an ended pool throws on every query.
    const deadPool = newPool()
    await deadPool.end()
    const offlineForwarder = createForwarder({ wal, pool: deadPool, instance: DEV_INSTANCE })
    await expect(offlineForwarder.tick()).resolves.toBeUndefined()
    expect(await walRowCount()).toBe(0)

    // Local WAL keeps accepting appends during the outage.
    for (let i = 3; i < 6; i += 1) await wal.append(entry(i))

    // Postgres back: a live forwarder catches up on everything, exactly once.
    await createForwarder({ wal, pool: newPool(), instance: DEV_INSTANCE }).tick()
    expect(await walRowCount()).toBe(6)
  })

  it('start()/stop() drives the interval loop', async () => {
    const wal = createWalFile({ path: walPath })
    openWal = wal
    await wal.append(entry(0))

    const forwarder = createForwarder({ wal, pool: newPool(), instance: DEV_INSTANCE, intervalMs: 20 })
    forwarder.start()
    try {
      await vi.waitFor(async () => expect(await walRowCount()).toBe(1), { timeout: 5000, interval: 25 })
    } finally {
      forwarder.stop()
    }
  })
})
