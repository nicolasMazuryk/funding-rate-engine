/**
 * Synchronous in-process event bus (`08_system_overview.md` §4).
 *
 * KISS: one strategy, one exchange → low fan-out, no distributed broker. Dispatch
 * is synchronous. To keep ordering **per-symbol FIFO even under re-entrant
 * publishes** (a handler that publishes while dispatching), events are enqueued
 * and drained in FIFO order rather than dispatched depth-first. Global publish
 * order is preserved, which subsumes per-symbol order.
 */

import type { EventBus, EventHandler, Unsubscribe } from '../ports/bus.js'
import type { EngineEvent } from './types.js'

export function createEventBus(): EventBus {
  const handlers = new Set<EventHandler>()
  const queue: EngineEvent[] = []
  let draining = false

  function drain(): void {
    // A handler may `publish` re-entrantly; those events land at the tail of the
    // queue and are delivered after the current one — FIFO, not nested.
    while (queue.length > 0) {
      const event = queue.shift() as EngineEvent
      // Snapshot so unsubscribing during dispatch doesn't skip a sibling handler.
      for (const handler of [...handlers]) {
        handler(event)
      }
    }
  }

  return {
    publish(event: EngineEvent): void {
      queue.push(event)
      if (draining) return
      draining = true
      try {
        drain()
      } finally {
        draining = false
      }
    },
    subscribe(handler: EventHandler): Unsubscribe {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
  }
}
