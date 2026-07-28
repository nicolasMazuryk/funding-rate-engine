/**
 * Bounded retry on the **run's clock** (task 0470 phase 6).
 *
 * The testnet tier's `retry` sleeps on `setTimeout`, which is right for a CLI-only helper but
 * makes anything built on it untestable under the repo's determinism rule (`test/CLAUDE.md`:
 * virtual clock only, no real waits). The live fill checks poll for venue state — a fill, a
 * position, a flat symbol — so their waiting has to run through the `Clock` port the context
 * already carries: real time live, virtual time in a unit test.
 */

import type { Clock } from '../core/ports/clock.js'
import { waitMs } from '../core/runtime/close-with-retries.js'

/** Default gap between polls, ms — venue REST views lag a submit by well under a second. */
export const LIVE_POLL_INTERVAL_MS = 1_000

/** Default slice of a long wait, ms — small enough that an hour-long hold reports progress. */
export const LIVE_WAIT_CHUNK_MS = 60_000

/**
 * Wait on `clock` until `untilMs`, calling `onTick` with the milliseconds still to go before each
 * slice. Sliced rather than one long timer purely so a wait measured in minutes or hours (the
 * `funding-test` window, task 0470 phase 7) reports progress instead of looking like a hang.
 * Returns at once when the deadline has already passed.
 */
export async function waitUntil(
  clock: Clock,
  untilMs: number,
  onTick: (remainingMs: number) => void = () => {},
  chunkMs: number = LIVE_WAIT_CHUNK_MS,
): Promise<void> {
  while (clock.now() < untilMs) {
    const remainingMs = untilMs - clock.now()
    onTick(remainingMs)
    await waitMs(clock, Math.min(chunkMs, remainingMs))
  }
}

/**
 * Call `fn` up to `attempts` times, waiting `delayMs` on `clock` between tries, and rethrow the
 * last error when none succeeded. Identical semantics to `src/testnet/runner.ts`'s `retry`,
 * except that the wait is a clock timer rather than a real one.
 */
export async function retryOnClock<T>(
  clock: Clock,
  fn: () => Promise<T>,
  attempts: number,
  delayMs: number = LIVE_POLL_INTERVAL_MS,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < attempts - 1) await waitMs(clock, delayMs)
    }
  }
  throw lastErr
}
