/**
 * The live run's position tracker (task 0470 phase 6).
 *
 * `fill-test` asserts that a real fill becomes a tracked position, which means the tracker has
 * to exist — and the private stream has to be subscribed — **before** the order is placed, or
 * the `PositionUpdate` it is meant to observe is published into nothing. So the entry check
 * builds it, this helper memoizes it on the run state, and the tracking check reads it.
 *
 * Two deps are set to their live-tier values rather than the engine's:
 *  - `hasOwningIntent: () => true` — there are no intents in this tier (adapter-level only, no
 *    engine boot; that is 0480), and every position on this sub-account was opened by this run.
 *    Reporting them as orphans would be noise, not signal; preflight already refused the account
 *    if it held anything beforehand.
 *  - a long reconcile interval — the checks call `reconcile()` at the moment they need REST
 *    ground truth, so the background tick only exists to keep the tracker's contract intact.
 *
 * Disposal is the live context's (`close()`), not a check's: the tracker holds a clock timer and
 * a bus subscription that outlive the check that created it.
 */

import { createPositionTracker, type PositionTracker } from '../../execution/position-tracker.js'
import type { LiveContext } from '../context.js'

/** Background reconcile cadence, ms. Long on purpose — the checks reconcile explicitly. */
const RECONCILE_INTERVAL_MS = 30_000

/** The run's position tracker, subscribing the private stream on first use. */
export async function ensurePositionTracker(ctx: LiveContext): Promise<PositionTracker> {
  const existing = ctx.state.positionTracker
  if (existing !== undefined) return existing

  // Before the tracker, not after: the stream is what it consumes.
  await ctx.adapter.streams.private.subscribe()
  const tracker = createPositionTracker({
    bus: ctx.bus,
    clock: ctx.clock,
    exchange: ctx.adapter,
    hasOwningIntent: () => true,
    reconcileIntervalMs: RECONCILE_INTERVAL_MS,
    log: ctx.log,
  })
  ctx.state.positionTracker = tracker
  return tracker
}
