/**
 * Bus → Postgres persistence projector (`14` §3, task 0360).
 *
 * Subscribes to the shared core event bus and mirrors derived facts (order
 * status, fills, positions, funding events) into the centralized store, off the
 * hot path — the same async, idempotent, instance-scoped discipline as the WAL
 * forwarder (`wal/forwarder.ts`). Driven from the **bus**, not the execution-
 * layer trackers, because the sim/e2e path shares the bus but has no order-
 * manager/trackers (those are the live Binance path) — the e2e idempotency DoD
 * runs through sim.
 *
 * Fire-and-forget: the `repo` is already instance-scoped and every writer is
 * idempotent on its natural key, so a re-delivered event is a no-op upsert. Repo
 * writers are **optional** (`Repo`); against the in-memory repo the `?.()` calls
 * simply don't run. Errors are swallowed (`.catch`) so a Postgres blip never
 * throws into bus dispatch.
 */

import type { EngineEvent } from '../core/events/types.js'
import type { EventBus, Repo } from '../core/ports/index.js'

/** A running projector; `stop()` unsubscribes from the bus. */
export interface PersistenceProjector {
  stop(): void
}

/**
 * Wire a projector on `bus` writing through `repo`. `now` stamps rows the event
 * carries no time for (positions); defaults to `Date.now`, injectable for
 * deterministic tests. Fills use the event's own fill time via `now()` too — a
 * duplicate delivery under the same virtual-clock replay stamps an identical
 * `ts`, so `(clientOrderId, ts, qty)` dedupes (`14` §4).
 */
export function createPersistenceProjector({
  bus,
  repo,
  now = Date.now,
}: {
  readonly bus: EventBus
  readonly repo: Repo
  readonly now?: () => number
}): PersistenceProjector {
  function project(event: EngineEvent): void {
    switch (event.type) {
      case 'OrderUpdate': {
        void repo.upsertOrderStatus?.({ clientOrderId: event.clientOrderId, status: event.status }).catch(swallow)
        if (event.fillPx !== undefined && event.qty !== undefined) {
          void repo
            .insertFill?.({ clientOrderId: event.clientOrderId, px: event.fillPx, qty: event.qty, ts: now() })
            .catch(swallow)
        }
        return
      }
      case 'PositionUpdate':
        void repo
          .upsertPosition?.({ symbol: event.symbol, side: event.side, qty: event.qty, updatedTs: now() })
          .catch(swallow)
        return
      case 'FundingFeeAccrued':
        void repo
          .upsertFundingEvent?.({ symbol: event.symbol, fundingTime: event.fundingTime, amount: event.amount })
          .catch(swallow)
        return
      default:
        // Every other event is projected elsewhere (WAL forwarder / kill-switch) or not persisted.
        return
    }
  }

  const unsubscribe = bus.subscribe(project)
  return { stop: unsubscribe }
}

/** Swallow a projection write error — persistence never throws into the hot path (`14` §2.1). */
function swallow(err: unknown): void {
  console.warn(`[projector] deferring — persistence write failed: ${(err as Error).message}`)
}
