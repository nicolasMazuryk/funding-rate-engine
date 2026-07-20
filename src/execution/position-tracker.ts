/**
 * Authoritative in-memory position tracker (`11_execution_and_account_state.md` §8
 * reconciliation, §9 state; `00_globals.md` §5.3 orphan positions). Consumes the private
 * stream's `PositionUpdate` (0220) into a per-symbol map, and **reconciles against REST
 * ground truth** (`getPositions`) at the three `11` §8 moments — periodically (self-
 * re-arming tick), after an entry fill, and after an exit (the last two driven by the
 * engine). **REST wins**: on divergence the tracked state is replaced and the divergence
 * logged. A venue position whose symbol has no owning intent is an **orphan** — detected
 * and published as an `OrphanDetected` event on the core bus (handling/auto-flatten is
 * 0380's risk layer, which subscribes to it; out of scope here).
 *
 * Venue-neutral (lives in `src/execution/`, not the pure core): it holds mutable state
 * and reads the `ExchangeAdapter` port. Mirrors the `createOrderManager` factory idiom —
 * closure over deps, `bus.subscribe` → `Unsubscribe`, `clock.scheduleTimer` self-re-arm,
 * `dispose()`. Adds **no** WAL: the state is REST-rebuildable ground truth.
 *
 * The orphan seam is the `OrphanDetected` core-bus `EngineEvent` variant (detect-and-alert
 * only); 0380 owns risk handling and consumes it off the bus.
 */

import type { PositionUpdate } from '../core/events/types.js'
import type { EventBus, Unsubscribe } from '../core/ports/bus.js'
import type { Clock, TimerHandle } from '../core/ports/clock.js'
import type { ExchangeAdapter, Position } from '../core/ports/exchange-adapter.js'

/** Optional structured-log sink for reconciliation divergence / REST failure (`11` §8). */
export type PositionTrackerLog = (message: string, meta?: Record<string, unknown>) => void

export interface PositionTrackerDeps {
  readonly bus: EventBus
  readonly clock: Clock
  /** REST ground truth for reconciliation (`11` §8). */
  readonly exchange: Pick<ExchangeAdapter, 'getPositions'>
  /** Does a live intent own `symbol`? A venue position with no owner is an orphan (`00_globals` §5.3). */
  readonly hasOwningIntent: (symbol: string) => boolean
  /** Cadence of the self-re-arming reconcile tick, ms. */
  readonly reconcileIntervalMs: number
  /** Seed positions (reprime 0220 / recovery 0370) so the tracker starts from known truth. */
  readonly initialPositions?: readonly Position[]
  readonly log?: PositionTrackerLog
}

export interface PositionTracker {
  /** Current tracked position for `symbol` (reduce-only exit sizing reads this), or `undefined` when flat. */
  get(symbol: string): Position | undefined
  /** Reconcile against REST now — REST wins, divergence logged, orphans published. The engine calls this after entry/exit. */
  reconcile(): Promise<void>
  /** Stop the reconcile tick + bus subscription (adapter close). */
  dispose(): void
}

/** Two positions differ if side or (base-unit) qty differ; entry price is not compared. */
function diverges(a: Position | undefined, b: Position): boolean {
  return a === undefined || a.side !== b.side || a.qty !== b.qty
}

export function createPositionTracker(deps: PositionTrackerDeps): PositionTracker {
  const { bus, clock, exchange, hasOwningIntent, reconcileIntervalMs, log } = deps

  // Swapped wholesale on each reconcile (REST wins); mutated in place on PositionUpdate.
  let positions = new Map<string, Position>((deps.initialPositions ?? []).map((p) => [p.symbol, p]))
  let tickHandle: TimerHandle | undefined

  /** Fold a private-stream `PositionUpdate` into tracked state (qty ≤ 0 ⇒ flat ⇒ drop). */
  function onPositionUpdate(event: PositionUpdate): void {
    if (event.qty <= 0) {
      positions.delete(event.symbol)
      return
    }
    const existing = positions.get(event.symbol)
    positions.set(event.symbol, {
      symbol: event.symbol,
      side: event.side,
      qty: event.qty,
      // PositionUpdate carries no entry price; preserve the last known one if same side.
      ...(existing?.entryPrice !== undefined && existing.side === event.side
        ? { entryPrice: existing.entryPrice }
        : {}),
    })
  }

  async function reconcile(): Promise<void> {
    let venuePositions: Position[]
    try {
      venuePositions = await exchange.getPositions()
    } catch (err) {
      // REST failure: keep tracked state + warn (`11` §8) — do not blind the engine.
      log?.('position reconcile: getPositions failed, keeping tracked state', { err })
      return
    }

    const next = new Map<string, Position>()
    for (const p of venuePositions) {
      if (p.qty <= 0) continue
      next.set(p.symbol, p)
      if (diverges(positions.get(p.symbol), p)) {
        log?.('position reconcile: divergence, REST wins', {
          symbol: p.symbol,
          tracked: positions.get(p.symbol),
          venue: p,
        })
      }
      // Orphan: venue holds a position no live intent owns (`00_globals` §5.3) — publish
      // onto the core bus; 0380's risk layer subscribes and owns the auto-flatten.
      if (!hasOwningIntent(p.symbol)) {
        bus.publish({ type: 'OrphanDetected', symbol: p.symbol, qty: p.qty, side: p.side })
      }
    }
    // A tracked position gone from the venue is also a divergence (REST still wins → dropped).
    for (const [symbol, tracked] of positions) {
      if (!next.has(symbol)) log?.('position reconcile: tracked position gone on venue', { symbol, tracked })
    }
    positions = next
  }

  /** Self-perpetuating reconcile tick (mirrors `adapter.ts:armReload`). Re-arm first so a rejected reconcile never stops the loop. */
  function armTick(): void {
    tickHandle = clock.scheduleTimer(clock.now() + reconcileIntervalMs, () => {
      armTick()
      void reconcile()
    })
  }

  const unsubscribe: Unsubscribe = bus.subscribe((event) => {
    if (event.type === 'PositionUpdate') onPositionUpdate(event)
  })
  armTick()

  return {
    get(symbol: string): Position | undefined {
      return positions.get(symbol)
    },
    reconcile,
    dispose(): void {
      tickHandle?.cancel()
      tickHandle = undefined
      unsubscribe()
    },
  }
}
