/**
 * Generic reduce-only **abort ladder** (`07_strategy_6.md` §2 step 2; `00_globals.md` §5.2) —
 * pure core. Retry a market close up to N times with a fixed backoff schedule, using a REST
 * `getPositions()` fetch as the ground truth for what still needs closing.
 *
 * S6's entry sub-machine uses it to flatten the tiny PRE_FUNDING leg on every abort path
 * (funding-event timeout, MAIN reject, PRE-not-filled); 0380's `flattenAll` reuses the same
 * primitive for the kill-switch flatten. It is deliberately dependency-light: time comes from
 * the {@link Clock} port (`scheduleTimer`), placement + the ground-truth read are injected
 * callbacks, so the whole thing stays testable on a virtual clock with no venue.
 *
 * Contract: each attempt reads the residual (position for `symbol` on the side *being closed*
 * — i.e. opposite `closeSide`); `≤ 0` ⇒ done (`{ closed: true }`); else place the sized close
 * and back off. A `groundTruthFetch` throw is a failed attempt (back off, retry). After the
 * last backoff a final ground-truth read decides the verdict — exhaustion with a residual
 * `> 0` returns `{ closed: false }` (S6's `close_pre_funding_failed` orphan risk).
 */

import type { Clock } from '../ports/clock.js'
import type { Position, Side } from '../ports/exchange-adapter.js'

/** The inputs to one abort ladder (`07` §2 step 2). */
export interface CloseWithRetriesParams {
  /** Normalized symbol whose residual position is being flattened. */
  readonly symbol: string
  /** Side of the reduce-only close order (opposite the position being closed). */
  readonly closeSide: Side
  /** Backoff schedule between attempts, ms — its length is the attempt cap (S6: `[250, 1000, 3000]`). */
  readonly backoffsMs: readonly number[]
  readonly clock: Clock
  /** Place attempt `attempt` (1-based) as a reduce-only close of `qty`. */
  placeClose(attempt: number, qty: number): void | Promise<void>
  /** REST ground truth for what is actually open (→ `exchange.getPositions`). */
  groundTruthFetch(): Promise<readonly Position[]>
}

/** The abort ladder's verdict: whether the residual reached flat, and the last-observed residual. */
export interface CloseWithRetriesResult {
  readonly closed: boolean
  /** Residual base qty still open on the last ground-truth read (`0` when flat). */
  readonly residualQty: number
}

/** Sleep `ms` on the injected clock (deterministic on a virtual clock; a real clock schedules a timer). */
function waitMs(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.scheduleTimer(clock.now() + ms, resolve)
  })
}

/** Residual base qty for `symbol` on the side being closed (the position opposite `closeSide`). */
function residualOf(positions: readonly Position[], symbol: string, closeSide: Side): number {
  const pos = positions.find((p) => p.symbol === symbol && p.side !== closeSide)
  return pos?.qty ?? 0
}

/**
 * Run the abort ladder. Loops at most `backoffsMs.length` times: read the residual, close it if
 * present, back off; a fetch throw fails the attempt (backs off, retries). A final ground-truth
 * read after the last backoff decides the verdict.
 */
export async function closeWithRetries(params: CloseWithRetriesParams): Promise<CloseWithRetriesResult> {
  const { symbol, closeSide, backoffsMs, clock, placeClose, groundTruthFetch } = params
  let residual = 0
  for (let attempt = 1; attempt <= backoffsMs.length; attempt++) {
    let positions: readonly Position[]
    try {
      positions = await groundTruthFetch()
    } catch {
      await waitMs(clock, backoffsMs[attempt - 1] as number) // failed attempt: back off, retry
      continue
    }
    residual = residualOf(positions, symbol, closeSide)
    if (residual <= 0) return { closed: true, residualQty: 0 }
    await placeClose(attempt, residual)
    await waitMs(clock, backoffsMs[attempt - 1] as number)
  }
  // Final ground-truth check after the last backoff — the reduce-only close may have landed.
  try {
    residual = residualOf(await groundTruthFetch(), symbol, closeSide)
  } catch {
    // Keep the last-observed residual; a failed final read means we cannot prove flat.
  }
  return { closed: residual <= 0, residualQty: Math.max(0, residual) }
}
