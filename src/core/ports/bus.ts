/**
 * Event bus port (`08_system_overview.md` §4 — the spine).
 *
 * A single in-process, synchronous typed pub/sub. Ordering is **per-symbol FIFO**;
 * because dispatch is synchronous and drained in publish order, global publish
 * order is preserved, which subsumes per-symbol order. The concrete bus lives at
 * {@link ../events/bus.ts}; the core depends only on this interface.
 */

import type { EngineEvent } from '../events/types.js'

/** A synchronous event handler. Must not throw for control flow; errors propagate to `publish`. */
export type EventHandler = (event: EngineEvent) => void

/** Removes a previously-registered subscriber. Idempotent. */
export type Unsubscribe = () => void

export interface EventBus {
  /** Dispatch `event` synchronously to every subscriber, in subscription order. */
  publish(event: EngineEvent): void
  /** Register `handler`; returns an idempotent unsubscribe. */
  subscribe(handler: EventHandler): Unsubscribe
}
