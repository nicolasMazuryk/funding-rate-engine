/**
 * End-to-end integration for the walking skeleton against a live Postgres
 * (`docker compose up -d`), task 0090 DoD #3. Mirrors `forwarder.test.ts`'s
 * setup: migrate once, truncate the two tables per test, tmp WAL per test.
 *
 * Runs the shared scenario on a virtual clock (no wall-clock waits) with the real
 * WAL, real sim venue, real `createPgRepo` (current-state projection) and real
 * `createForwarder` (WAL → `intent_wal`). Asserts the slice persists: the intent
 * row reaches `CLOSED` / `exit_reason = 'timed'`, and `intent_wal` holds exactly
 * the four transition rows for that intent.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEV_INSTANCE } from '../../src/persistence/db/instance.js'
import { createPgRepo } from '../../src/persistence/db/repo.js'
import { createForwarder } from '../../src/persistence/wal/forwarder.js'
import { createKillSwitch } from '../../src/risk/kill-switch.js'
import { buildSkeletonEngine, type SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import { runSkeletonScenario, START_MS, triggeredIntentId } from '../helpers/skeleton-scenario.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://funding:funding@localhost:5432/funding_drop'

let adminPool: Pool
let dir: string
let walPath: string
const openPools: Pool[] = []
const harnesses: SkeletonHarness[] = []

/**
 * A tracked pool. `max` defaults to 1: the engine fires its current-state
 * upserts un-awaited (off the hot path), so a single serialized connection is
 * what keeps them committing in call order — otherwise a late `MONITORING`
 * upsert can land after `CLOSED` on a multi-connection pool.
 */
function newPool(max = 1): Pool {
  const pool = new Pool({ connectionString: DATABASE_URL, max })
  openPools.push(pool)
  return pool
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
  dir = mkdtempSync(join(tmpdir(), 'skeleton-e2e-'))
  walPath = join(dir, 'instance.wal.jsonl')
})

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    h.engine.dispose()
    h.wal.close()
  }
  for (const pool of openPools.splice(0)) {
    await pool.end().catch(() => {})
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('skeleton end-to-end through Postgres', () => {
  it('persists the intent as CLOSED/timed and forwards its four WAL transitions', async () => {
    const repo = createPgRepo({ pool: newPool(), instance: DEV_INSTANCE })
    const harness = buildSkeletonEngine({ startMs: START_MS, walPath, repo })
    harnesses.push(harness)
    const forwarder = createForwarder({ wal: harness.wal, pool: newPool(), instance: DEV_INSTANCE })

    runSkeletonScenario(harness)
    const intentId = triggeredIntentId(harness)

    // Current-state projection is written via un-awaited upserts — wait for CLOSED.
    await vi.waitFor(
      async () => {
        const { rows } = await adminPool.query('SELECT state, exit_reason FROM intents WHERE intent_id = $1', [
          intentId,
        ])
        expect(rows[0]).toEqual({ state: 'CLOSED', exit_reason: 'timed' })
      },
      { timeout: 5000, interval: 25 },
    )

    await forwarder.tick()

    const { rows } = await adminPool.query(
      'SELECT from_state, to_state FROM intent_wal WHERE intent_id = $1 ORDER BY seq',
      [intentId],
    )
    expect(rows).toEqual([
      { from_state: 'SELECTED', to_state: 'SUBMITTING_ENTRY' },
      { from_state: 'SUBMITTING_ENTRY', to_state: 'MONITORING' },
      { from_state: 'MONITORING', to_state: 'EXITING' },
      { from_state: 'EXITING', to_state: 'CLOSED' },
    ])
  })

  it('with the kill switch paused: places no order and persists one ABORTED intent', async () => {
    const repo = createPgRepo({ pool: newPool(), instance: DEV_INSTANCE })
    // Kill switch fixed at `paused` with a throwaway WAL, so the harness WAL holds only engine transitions.
    const killSwitch = createKillSwitch({
      initial: 'paused',
      clock: { now: () => 0, scheduleTimer: () => ({ cancel() {} }) },
      wal: { append: () => Promise.resolve() },
    })
    const harness = buildSkeletonEngine({ startMs: START_MS, walPath, repo, killSwitch })
    harnesses.push(harness)
    const placeOrder = vi.spyOn(harness.exchange, 'placeOrder')
    const forwarder = createForwarder({ wal: harness.wal, pool: newPool(), instance: DEV_INSTANCE })

    runSkeletonScenario(harness)
    const intentId = triggeredIntentId(harness)

    expect(placeOrder).not.toHaveBeenCalled()
    await vi.waitFor(
      async () => {
        const { rows } = await adminPool.query('SELECT state, error_code FROM intents WHERE intent_id = $1', [intentId])
        expect(rows[0]).toEqual({ state: 'ABORTED', error_code: 'kill_switch' })
      },
      { timeout: 5000, interval: 25 },
    )

    await forwarder.tick()
    const { rows } = await adminPool.query('SELECT from_state, to_state FROM intent_wal WHERE intent_id = $1', [
      intentId,
    ])
    expect(rows).toEqual([{ from_state: 'SELECTED', to_state: 'ABORTED' }])
  })
})
