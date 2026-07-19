/**
 * Tracks the {@link SkeletonHarness}es a test builds and disposes them all in one
 * `afterEach` (task 0180 cleanup). Crash-recovery tests spin up two engines over a
 * shared WAL/venue and every such test repeated the same
 * `harnesses.splice(0)` dispose loop; this is the one definition.
 */

import type { SkeletonHarness } from './build-skeleton-engine.js'

export interface HarnessPool {
  /** Register `h` for teardown; returns it for `const h = pool.track(build(...))`. */
  track(h: SkeletonHarness): SkeletonHarness
  /** Dispose every tracked engine and close its WAL, then clear the pool. */
  disposeAll(): void
}

export function harnessPool(): HarnessPool {
  const harnesses: SkeletonHarness[] = []
  return {
    track(h) {
      harnesses.push(h)
      return h
    },
    disposeAll() {
      for (const h of harnesses.splice(0)) {
        h.engine.dispose()
        h.wal.close()
      }
    },
  }
}
