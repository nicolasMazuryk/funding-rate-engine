/**
 * `position-tracking` — the fill became a position the engine can see (task 0470 phase 6;
 * `11` §8 reconciliation, `11` §7 private stream).
 *
 * Two independent paths must agree that the position exists, and the check reports which one
 * answered first:
 *
 *  - the **private stream**, folded into `createPositionTracker` (the engine's own tracker, not
 *    a harness copy) — this is the only place a venue's `PositionUpdate` mapping is ever
 *    observed against a real fill;
 *  - **REST ground truth** via `reconcile()`, which wins on divergence by design.
 *
 * The quantity is compared to the fill within one lot step. That tolerance is deliberate and
 * tight: a `contractSize` mis-fold (the open `[high]` SUGGESTIONS item for binance/bybit/bitget)
 * shows up here as an order-of-magnitude gap, not a rounding one, and would silently mis-size
 * every exit if it were waved through.
 */

import type { LiveContext } from '../context.js'
import { retryOnClock } from '../poll.js'
import type { LiveCheck } from '../registry.js'
import { requirePreflight } from './preflight.js'

/** Poll attempts, one second apart, for the private stream to deliver the position. */
const STREAM_ATTEMPTS = 5

export const positionTrackingCheck: LiveCheck = {
  name: 'position-tracking',
  specRef: '11 §8 reconciliation',
  async run(ctx: LiveContext) {
    const skip = requirePreflight(ctx)
    if (skip !== undefined) return skip

    const fill = ctx.state.fill
    if (fill === undefined) return { status: 'skip', reason: 'no entry fill to track' }
    const tracker = ctx.state.positionTracker
    if (tracker === undefined) return { status: 'skip', reason: 'no position tracker was built' }

    let source: 'stream' | 'rest' = 'stream'
    let tracked = await retryOnClock(
      ctx.clock,
      () => {
        const p = tracker.get(fill.symbol)
        return p === undefined ? Promise.reject(new Error('not tracked yet')) : Promise.resolve(p)
      },
      STREAM_ATTEMPTS,
    ).catch(() => undefined)

    if (tracked === undefined) {
      // The stream never delivered it. REST is ground truth anyway (`11` §8), so reconcile and
      // let the detail record that this venue's private stream did not carry the position.
      await tracker.reconcile()
      tracked = tracker.get(fill.symbol)
      source = 'rest'
    }
    if (tracked === undefined) {
      throw new Error(`neither the private stream nor getPositions() shows the ${fill.symbol} position just filled`)
    }
    if (tracked.side !== 'long') {
      throw new Error(`tracked ${fill.symbol} position is ${tracked.side}, expected long`)
    }

    const lotStep = ctx.adapter.normalize(fill.symbol).amountPrecision
    const delta = Math.abs(tracked.qty - fill.qty)
    if (delta > lotStep) {
      throw new Error(
        `tracked ${fill.symbol} qty ${tracked.qty} differs from the filled qty ${fill.qty} by ${delta}, ` +
          `more than one lot step (${lotStep}) — suspect a contractSize/denomination mismatch`,
      )
    }

    return {
      status: 'pass',
      detail: {
        symbol: fill.symbol,
        source,
        trackedQty: tracked.qty,
        filledQty: fill.qty,
        entryPrice: tracked.entryPrice,
      },
    }
  },
}
