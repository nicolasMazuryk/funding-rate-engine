/**
 * WAL forwarder — tier 2 of the two-tier write path (`14` §2.1).
 *
 * A background loop that ships local WAL entries to the centralized Postgres
 * `intent_wal` table, off the hot path. It NEVER throws into the caller: on a
 * Postgres outage it logs a warning, leaves its watermark unchanged, and
 * catches up on a later tick once the DB is reachable again (`14` §2.1). The
 * local WAL file keeps accepting appends throughout.
 *
 * Idempotency: batch inserts use `ON CONFLICT (intent_id, from_state, to_state)
 * DO NOTHING` (`14` §4), so a re-forwarded entry is a no-op. The in-memory
 * watermark is a fast-path skip, not a correctness dependency — on start it is
 * re-derived from `MAX(seq)` in `intent_wal` for this instance (simpler than a
 * sidecar file), so a restart re-sends nothing already shipped.
 */

import { and, eq, max } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import type { Instance } from '../db/instance.js'
import { intentWal } from '../db/schema.js'
import type { WalFile } from './wal-file.js'

/** Default forwarder tick interval (`14` §2.1: "every 200 ms or N entries"). */
const DEFAULT_INTERVAL_MS = 200

export interface Forwarder {
  /** Begin the background tick loop. Idempotent. */
  start(): void
  /** Stop the tick loop. Does not flush; the local WAL is durable regardless. */
  stop(): void
  /** Run one forward pass now (used by tests); resolves after the attempt. */
  tick(): Promise<void>
}

/** Build a forwarder shipping `wal` entries to `pool`, scoped to `instance`. */
export function createForwarder({
  wal,
  pool,
  instance,
  intervalMs = DEFAULT_INTERVAL_MS,
}: {
  readonly wal: WalFile
  readonly pool: Pool
  readonly instance: Instance
  readonly intervalMs?: number
}): Forwarder {
  const db = drizzle(pool)
  const instanceScope = and(
    eq(intentWal.exchange, instance.exchange),
    eq(intentWal.strategy, instance.strategy),
    eq(intentWal.subaccount, instance.subaccount),
  )

  // Highest forwarded seq. Re-derived from the DB on the first successful tick
  // (`14` §2.1); -1 means "nothing shipped yet".
  let watermark = -1
  let derived = false
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight = false

  async function forwardOnce(): Promise<void> {
    if (!derived) {
      const [row] = await db
        .select({ m: max(intentWal.seq) })
        .from(intentWal)
        .where(instanceScope)
      watermark = row?.m ?? -1
      derived = true
    }
    const pending = wal.readAll().filter((record) => record.seq > watermark)
    if (pending.length === 0) return

    const values = pending.map((record) => ({
      seq: record.seq,
      exchange: instance.exchange,
      strategy: instance.strategy,
      subaccount: instance.subaccount,
      ts: record.ts,
      intentId: record.intentId,
      fromState: record.fromState,
      toState: record.toState,
      payload: record.payload ?? null,
      clientOrderId: record.clientOrderId ?? null,
    }))
    await db
      .insert(intentWal)
      .values(values)
      .onConflictDoNothing({
        target: [intentWal.intentId, intentWal.fromState, intentWal.toState],
      })
    // Advance only after a successful commit (`14` §2.1: watermark unchanged on error).
    watermark = Math.max(...pending.map((record) => record.seq))
  }

  async function tick(): Promise<void> {
    if (inFlight) return
    inFlight = true
    try {
      await forwardOnce()
    } catch (err) {
      // Never throw into the hot path: warn, keep the watermark, retry next tick.
      console.warn(`[forwarder] deferring — Postgres unreachable: ${(err as Error).message}`)
    } finally {
      inFlight = false
    }
  }

  return {
    start() {
      if (timer !== undefined) return
      timer = setInterval(() => void tick(), intervalMs)
      // Do not keep the process alive solely for the forwarder.
      timer.unref?.()
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    },
    tick,
  }
}
