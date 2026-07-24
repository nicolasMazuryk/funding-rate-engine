/**
 * `OrphanDetected` → auto-flatten handler (`13_risk_and_failure_modes.md` §4, `00_globals.md`
 * §5.3, task 0380). Subscribes to the core bus; on an `OrphanDetected` (published by the position
 * tracker at REST reconcile, or by {@link ./flatten.js}.flattenAll's residual path) it runs the pure
 * abort ladder ({@link ../core/runtime/close-with-retries.js}) as a reduce-only market close of the
 * orphan's `{symbol, side}`. A residual surviving the retry schedule is logged (alert-only — no
 * re-publish, so it cannot spin an infinite close loop).
 *
 * **In-flight dedupe by symbol**: a second `OrphanDetected` for a symbol already being closed is
 * dropped, so `flattenAll`'s own residual publish (which arrives while its close is in flight) does
 * not stack redundant closes against a genuinely stuck position.
 */

import { makeClientOrderId } from '../core/order-id/client-order-id.js'
import type { EventBus, Unsubscribe } from '../core/ports/bus.js'
import type { Clock } from '../core/ports/clock.js'
import type { ExchangeAdapter, Side } from '../core/ports/exchange-adapter.js'
import { closeWithRetries } from '../core/runtime/close-with-retries.js'

export interface OrphanHandlerDeps {
  readonly bus: EventBus
  readonly clock: Clock
  readonly exchange: Pick<ExchangeAdapter, 'getPositions' | 'placeOrder'>
  /** Backoff schedule between close attempts, ms — its length is the attempt cap (reuse S6's `[250,1000,3000]`). */
  readonly backoffsMs: readonly number[]
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
}

export interface OrphanHandler {
  /** Unsubscribe from the bus (SIGTERM teardown). */
  dispose(): void
}

/** Deterministic reduce-only close id for an orphan flatten attempt — no owning intent. */
function orphanClose(symbol: string, attempt: number): string {
  return makeClientOrderId({ intentId: `orphan-${symbol}`, leg: 'flat', attempt })
}

export function createOrphanHandler(deps: OrphanHandlerDeps): OrphanHandler {
  const { bus, clock, exchange, backoffsMs, log } = deps
  const inFlight = new Set<string>()

  async function handle(symbol: string, side: Side): Promise<void> {
    if (inFlight.has(symbol)) return // dedupe: a close for this symbol is already running
    inFlight.add(symbol)
    try {
      const closeSide: Side = side === 'long' ? 'short' : 'long'
      const result = await closeWithRetries({
        symbol,
        closeSide,
        backoffsMs,
        clock,
        placeClose: (attempt, qty) => {
          void exchange.placeOrder({
            symbol,
            side: closeSide,
            type: 'market',
            qty,
            clientOrderId: orphanClose(symbol, attempt),
            reduceOnly: true,
          })
        },
        groundTruthFetch: () => exchange.getPositions(),
      })
      if (!result.closed) {
        // Alert-only: do NOT re-publish OrphanDetected (that would loop against a stuck position).
        log?.('orphan-handler: residual after retries — alerting only', { symbol, residualQty: result.residualQty })
      }
    } finally {
      inFlight.delete(symbol)
    }
  }

  const unsubscribe: Unsubscribe = bus.subscribe((event) => {
    if (event.type !== 'OrphanDetected') return
    void handle(event.symbol, event.side)
  })

  return {
    dispose(): void {
      unsubscribe()
    },
  }
}
