/**
 * `flattenAll()` — the venue-ground-truth safety net behind the kill switch's `flatten` state
 * (`13_risk_and_failure_modes.md` §3/§4, `00_globals.md` §5.2, task 0380).
 *
 * Reads `getPositions()` and runs the pure {@link ../core/runtime/close-with-retries.js} abort
 * ladder against **every** open position — including orphans (a position with no owning intent) —
 * as a reduce-only market close on the opposite side, using `getPositions` as ground truth. A
 * position that will not flatten after the retry schedule is a residual: it is published as an
 * `OrphanDetected` (last-ditch alert path) and returned in `orphans`.
 *
 * The engine's own kill-switch subscription already terminalizes tracked intent rows to
 * CLOSED(kill_switch_flatten); this closes the venue positions and does not touch intent rows.
 * Double-closing a position the engine also exited is safe: reduce-only + the ladder's residual=0
 * short-circuit make the second close a no-op.
 */

import { makeClientOrderId } from '../core/order-id/client-order-id.js'
import type { EventBus } from '../core/ports/bus.js'
import type { Clock } from '../core/ports/clock.js'
import type { ExchangeAdapter, Side } from '../core/ports/exchange-adapter.js'
import { closeWithRetries } from '../core/runtime/close-with-retries.js'

/** A position `flattenAll` could not flatten after its retry schedule (`13` §4). */
export interface FlattenResidual {
  readonly symbol: string
  readonly residualQty: number
  readonly side: Side
}

export interface FlattenAllDeps {
  readonly exchange: Pick<ExchangeAdapter, 'getPositions' | 'placeOrder' | 'normalize'>
  readonly clock: Clock
  readonly bus: EventBus
  /** Backoff schedule between close attempts, ms — its length is the attempt cap (reuse S6's `[250,1000,3000]`). */
  readonly backoffsMs: readonly number[]
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
}

/** Deterministic reduce-only close id for a flatten attempt — no owning intent, so a synthetic key. */
function flattenClose(symbol: string, attempt: number): string {
  return makeClientOrderId({ intentId: `flatten-${symbol}`, leg: 'flat', attempt })
}

/**
 * Flatten every venue position reduce-only. Returns the symbols confirmed flat and any residuals
 * that survived the retry schedule (each also published as an `OrphanDetected` alert).
 */
export async function flattenAll(deps: FlattenAllDeps): Promise<{ flattened: string[]; orphans: FlattenResidual[] }> {
  const { exchange, clock, bus, backoffsMs, log } = deps
  const flattened: string[] = []
  const orphans: FlattenResidual[] = []

  const positions = await exchange.getPositions()
  for (const pos of positions) {
    const closeSide: Side = pos.side === 'long' ? 'short' : 'long'
    const result = await closeWithRetries({
      symbol: pos.symbol,
      closeSide,
      backoffsMs,
      clock,
      placeClose: (attempt, qty) => {
        void exchange.placeOrder({
          symbol: pos.symbol,
          side: closeSide,
          type: 'market',
          qty,
          clientOrderId: flattenClose(pos.symbol, attempt),
          reduceOnly: true,
        })
      },
      groundTruthFetch: () => exchange.getPositions(),
    })
    if (result.closed) {
      flattened.push(pos.symbol)
      continue
    }
    // Unresolved residual: alert + last-ditch OrphanDetected so the orphan handler gets one more pass.
    const residual: FlattenResidual = { symbol: pos.symbol, residualQty: result.residualQty, side: pos.side }
    orphans.push(residual)
    log?.('flattenAll: residual position could not be closed', { ...residual })
    bus.publish({ type: 'OrphanDetected', symbol: pos.symbol, qty: result.residualQty, side: pos.side })
  }

  return { flattened, orphans }
}
