/**
 * Data-continuity reconnect controller (`10_exchange_adapters_and_market_data.md` §7).
 *
 * The native venue lib already reconnects the socket on its own (open / reconnecting /
 * reconnected events). This is the layer *above* that: a small FSM that keeps the event
 * stream continuous across a drop — fall back to REST polling while the socket is down,
 * then re-prime a fresh snapshot before resuming the live feed so no reading is skipped.
 *
 * States (`10` §7):
 *  - `live`      — socket healthy, WS is the source of truth.
 *  - `degraded`  — socket dropped; a REST fallback poll fills the gap.
 *  - `repriming` — socket back; pulling one fresh REST snapshot before trusting WS again.
 *
 * Reusable across venues and stream kinds (public 0210, private 0220); clock-injected,
 * so it reads no wall clock and unit-tests on a virtual clock.
 */

import type { Clock } from '../../core/ports/clock.js'

/** Reconnect-continuity FSM state (`10` §7). */
export type ReconnectState = 'live' | 'degraded' | 'repriming'

/** Default reprime-retry backoff: 1 s base, doubling, capped at 30 s. */
const DEFAULT_BASE_MS = 1_000
const DEFAULT_CAP_MS = 30_000

/**
 * Exponential backoff, capped. `attempt` is 0-based (first retry = `baseMs`), so the
 * sequence is `baseMs, 2·baseMs, 4·baseMs, …` clamped to `capMs`.
 */
export function expBackoff(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** attempt)
}

export interface ReconnectControllerDeps {
  /** Time + timers for scheduling reprime retries — never a wall clock. */
  readonly clock: Clock
  /**
   * Called on entering `degraded`. Start the REST fallback poll and return a stop
   * function; the controller invokes it once the feed is re-primed and back `live`.
   */
  onEnterDegraded(): () => void
  /** Pull one fresh REST snapshot and publish it. Run before resuming `live`; retried with backoff on throw. */
  onReprime(): Promise<void>
  /** Reprime-retry backoff (ms) by 0-based attempt. Defaults to {@link expBackoff} 1 s→30 s. */
  backoff?(attempt: number): number
}

export interface ReconnectController {
  /** Current FSM state (`10` §7). */
  readonly state: ReconnectState
  /** Socket dropped (lib `reconnecting`): go `degraded` and start the fallback. Idempotent while not `live`. */
  markDisconnected(): void
  /** Socket back (lib `reconnected`): go `repriming`, re-prime, then resume `live`. Ignored unless `degraded`. */
  markReconnected(): void
}

export function createReconnectController(deps: ReconnectControllerDeps): ReconnectController {
  const { clock, onEnterDegraded, onReprime } = deps
  const backoff = deps.backoff ?? ((attempt) => expBackoff(attempt, DEFAULT_BASE_MS, DEFAULT_CAP_MS))

  let state: ReconnectState = 'live'
  let stopFallback: (() => void) | undefined
  let attempt = 0

  /** Re-prime, then resume live (stopping the fallback). On failure, back off and retry — stays `repriming`. */
  async function reprimeThenResume(): Promise<void> {
    try {
      await onReprime()
    } catch {
      const delayMs = backoff(attempt)
      attempt += 1
      clock.scheduleTimer(clock.now() + delayMs, () => void reprimeThenResume())
      return
    }
    // Re-prime landed: stop the REST fallback and hand the stream back to the live socket.
    stopFallback?.()
    stopFallback = undefined
    attempt = 0
    state = 'live'
  }

  return {
    get state() {
      return state
    },
    markDisconnected(): void {
      if (state !== 'live') return // already degraded / repriming — one fallback only
      state = 'degraded'
      stopFallback = onEnterDegraded()
    },
    markReconnected(): void {
      if (state !== 'degraded') return // ignore spurious / mid-reprime reconnects
      state = 'repriming'
      attempt = 0
      void reprimeThenResume()
    },
  }
}
