/**
 * E2E harness (task 0270; `17` §4) — boots a full instance on the virtual clock +
 * sim venue but with **real Docker Postgres + a real local WAL file**, the seam
 * between the pure core and the persistence tier. It composes over
 * `buildSkeletonEngine` (the one skeleton assembler; `src/composition.ts` is
 * deferred to 0280) plus a real `createPgRepo` (current-state projection) and
 * `createForwarder` (WAL → `intent_wal`).
 *
 * Reuses the integration bring-up pattern (`forwarder.test.ts`): migrate once,
 * `TRUNCATE intents, intent_wal` per test, a fresh tmp WAL per test, and
 * `newPool(max=1)` — a single serialized connection so the engine's un-awaited
 * current-state upserts commit in call order (a multi-connection pool can land a
 * late `MONITORING` upsert after `CLOSED`).
 *
 * One scenario file per strategy plugs in here from 0280; this file stays
 * strategy-agnostic.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { DEV_INSTANCE } from '../../src/persistence/db/instance.js'
import { createPgRepo } from '../../src/persistence/db/repo.js'
import { createPersistenceProjector, type PersistenceProjector } from '../../src/persistence/projector.js'
import { createForwarder, type Forwarder } from '../../src/persistence/wal/forwarder.js'
import type { WalRecord } from '../../src/persistence/wal/wal-file.js'
import { type BuildOpts, buildSkeletonEngine, type SkeletonHarness } from '../../src/replay/build-skeleton-harness.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://funding:funding@localhost:5432/funding_drop'

/** A projected `intent_wal` row (the two columns the consistency check compares). */
export interface WalDbRow {
  readonly from_state: string
  readonly to_state: string
}

/** A booted instance: its harness + forwarder, plus DB/local-WAL state accessors. */
export interface BootedInstance {
  readonly harness: SkeletonHarness
  readonly forwarder: Forwarder
  /** The bus → Postgres derived-fact projector (orders/fills/positions/funding; 0360). */
  readonly projector: PersistenceProjector
  /** The current-state `intents` row for `intentId` (`SELECT *`), or `undefined`. */
  intentRow(intentId: string): Promise<Record<string, unknown> | undefined>
  /** The forwarded `intent_wal` transition rows for `intentId`, in `seq` order. */
  walRows(intentId: string): Promise<WalDbRow[]>
  /** The local-WAL records for `intentId` (pre-forwarder ground truth). */
  localWal(intentId: string): WalRecord[]
}

export interface E2eContext {
  /** Shared admin pool for TRUNCATE + assertion reads. */
  readonly adminPool: Pool
  /** Truncate the two tables and make a fresh tmp WAL; returns its path. Call per test. */
  reset(): Promise<string>
  /** Boot a full instance against the current tmp WAL (or an explicit `walPath`). */
  bootInstance(opts?: Omit<BuildOpts, 'walPath'> & { readonly walPath?: string }): BootedInstance
  /** Dispose every booted harness, end every pool, remove the tmp WAL. */
  close(): Promise<void>
}

/** Migrate once, open the shared admin pool, and return the e2e context. Call in `beforeAll`. */
export async function createE2eContext(): Promise<E2eContext> {
  const migratePool = new Pool({ connectionString: DATABASE_URL })
  await migrate(drizzle(migratePool), { migrationsFolder: 'src/persistence/db/migrations' })
  await migratePool.end()

  const adminPool = new Pool({ connectionString: DATABASE_URL })
  const openPools: Pool[] = []
  const harnesses: SkeletonHarness[] = []
  const projectors: PersistenceProjector[] = []
  let tmp: TempDir | undefined

  function newPool(max = 1): Pool {
    const pool = new Pool({ connectionString: DATABASE_URL, max })
    openPools.push(pool)
    return pool
  }

  async function disposeInstances(): Promise<void> {
    for (const p of projectors.splice(0)) p.stop()
    for (const h of harnesses.splice(0)) {
      h.engine.dispose()
      h.wal.close()
    }
    for (const pool of openPools.splice(0)) await pool.end().catch(() => {})
  }

  return {
    adminPool,
    async reset(): Promise<string> {
      await disposeInstances()
      tmp?.dispose()
      await adminPool.query(
        'TRUNCATE intents, intent_wal, orders, fills, positions, funding_events, kill_switch, tracker_snapshots',
      )
      tmp = tempDir('skeleton-e2e-')
      return tmp.walPath
    },
    bootInstance(opts = {}): BootedInstance {
      const walPath = opts.walPath ?? tmp?.walPath
      if (walPath === undefined) throw new Error('e2e harness: call reset() before bootInstance()')
      const repo = createPgRepo({ pool: newPool(), instance: DEV_INSTANCE })
      const harness = buildSkeletonEngine({ ...opts, walPath, repo })
      harnesses.push(harness)
      const forwarder = createForwarder({ wal: harness.wal, pool: newPool(), instance: DEV_INSTANCE })
      const projector = createPersistenceProjector({ bus: harness.bus, repo, now: () => harness.clock.now() })
      projectors.push(projector)
      return {
        harness,
        forwarder,
        projector,
        async intentRow(intentId): Promise<Record<string, unknown> | undefined> {
          const { rows } = await adminPool.query('SELECT * FROM intents WHERE intent_id = $1', [intentId])
          return rows[0]
        },
        async walRows(intentId): Promise<WalDbRow[]> {
          const { rows } = await adminPool.query(
            'SELECT from_state, to_state FROM intent_wal WHERE intent_id = $1 ORDER BY seq',
            [intentId],
          )
          return rows
        },
        localWal(intentId): WalRecord[] {
          return harness.wal.readAll().filter((r) => r.intentId === intentId)
        },
      }
    },
    async close(): Promise<void> {
      await disposeInstances()
      tmp?.dispose()
      await adminPool.end()
    },
  }
}
