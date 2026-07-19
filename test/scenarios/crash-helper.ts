/**
 * Crash / restart helper (task 0160) — the `crash-mid-intent` catalog row. Wraps the
 * exact sequence proven in `test/unit/core/runtime/crash-recovery.test.ts`: a "crash"
 * discards the engine's in-memory state (dispose + stop scheduler) while the WAL file
 * and the sim venue survive — exactly what persists across a real process kill. A
 * fresh engine reopens the same WAL path and same venue against a fresh repo, and
 * rebuilds its recoverable intents from `recoveredFromWal`.
 *
 * Reused, not reinvented, so scenario and unit tiers drive the same recovery path.
 */

import type { VirtualClock } from '../../src/adapters/clock/virtual-clock.js'
import type { SimExchange } from '../../src/adapters/sim/sim-exchange.js'
import type { EventBus } from '../../src/core/ports/bus.js'
import { recoveredFromWal } from '../../src/core/runtime/engine.js'
import { buildSkeletonEngine, type SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import { createInMemoryRepo } from '../helpers/in-memory-repo.js'

/** Simulated crash: engine stops reacting and its scan timer is cancelled; WAL + venue survive. */
export function crash(h: SkeletonHarness): void {
  h.engine.dispose()
  h.scheduler.stop()
}

/**
 * Restart against the surviving WAL/clock/bus/venue with a fresh repo, then replay the
 * WAL into the new engine (`engine.recover`). Returns the fresh harness.
 */
export async function restart(shared: {
  readonly walPath: string
  readonly clock: VirtualClock
  readonly bus: EventBus
  readonly exchange: SimExchange
}): Promise<SkeletonHarness> {
  const h = buildSkeletonEngine({ ...shared, repo: createInMemoryRepo() })
  await h.engine.recover(recoveredFromWal(h.wal.readAll()))
  return h
}
