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
 *
 * Robustness (0370): each tick ships at most {@link DEFAULT_BATCH_SIZE} rows,
 * looping within the tick until the backlog is drained rather than growing one
 * unbounded `INSERT` — a long outage's catch-up stays a bounded statement, not a
 * single giant one. A failed tick backs off the *next* tick's delay exponentially
 * (capped), resetting to {@link DEFAULT_INTERVAL_MS} on the next success, so a
 * sustained PG outage does not retry every 200 ms forever.
 */

import { max } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import type { Instance } from '../db/instance.js'
import { instanceWhere, intentWal } from '../db/schema.js'
import type { WalFile } from './wal-file.js'

/** Default forwarder tick interval (`14` §2.1: "every 200 ms or N entries"). */
const DEFAULT_INTERVAL_MS = 200
/** Max rows shipped per `INSERT` — a tick loops over batches until the backlog drains. */
const DEFAULT_BATCH_SIZE = 500
/** Backoff ceiling on repeated PG failure (`14` §2.1: keep retrying, never storm the DB). */
const MAX_BACKOFF_MS = 30_000

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
  batchSize = DEFAULT_BATCH_SIZE,
}: {
  readonly wal: WalFile
  readonly pool: Pool
  readonly instance: Instance
  readonly intervalMs?: number
  /** Max rows shipped per `INSERT`; a tick loops over batches until the backlog drains. */
  readonly batchSize?: number
}): Forwarder {
  const db = drizzle(pool)
  const instanceScope = instanceWhere(intentWal, instance)

  // Highest forwarded seq. Re-derived from the DB on the first successful tick
  // (`14` §2.1); -1 means "nothing shipped yet".
  let watermark = -1
  let derived = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let stopped = true
  // Current retry delay — resets to `intervalMs` on success, grows (capped) on failure.
  let currentDelayMs = intervalMs

  /** Ship one bounded batch past the watermark; returns the number of rows shipped. */
  async function forwardBatch(): Promise<number> {
    const pending = wal
      .readAll()
      .filter((record) => record.seq > watermark)
      .slice(0, batchSize)
    if (pending.length === 0) return 0

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
    return pending.length
  }

  /** Ship the full current backlog, one bounded batch at a time (idempotent catch-up after any downtime). */
  async function forwardOnce(): Promise<void> {
    if (!derived) {
      const [row] = await db
        .select({ m: max(intentWal.seq) })
        .from(intentWal)
        .where(instanceScope)
      watermark = row?.m ?? -1
      derived = true
    }
    // Loop within the tick so a long backlog drains in one pass rather than one batch/200ms.
    while ((await forwardBatch()) === batchSize) {
      // keep draining
    }
  }

  async function tick(): Promise<void> {
    if (inFlight) return
    inFlight = true
    try {
      await forwardOnce()
      currentDelayMs = intervalMs // success — reset the backoff
    } catch (err) {
      // Never throw into the hot path: warn, keep the watermark, back off the next tick.
      console.warn(`[forwarder] deferring — Postgres unreachable: ${(err as Error).message}`)
      currentDelayMs = Math.min(currentDelayMs * 2, MAX_BACKOFF_MS)
    } finally {
      inFlight = false
    }
  }

  function scheduleNext(): void {
    if (stopped) return
    timer = setTimeout(() => {
      void tick().finally(scheduleNext)
    }, currentDelayMs)
    // Do not keep the process alive solely for the forwarder.
    timer.unref?.()
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      scheduleNext()
    },
    stop() {
      stopped = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
    tick,
  }
}
