/**
 * Kill-switch state machine (`13_risk_and_failure_modes.md` §2 /
 * `00_globals.md` §5.1): `off | paused | flatten`. Preflight reads {@link
 * KillSwitch.state} and rejects every new intent while `!= off` (`12` §3).
 * Lives outside `src/core/` (implements/serves core ports from the edge).
 *
 * In-memory current state; each real transition is WAL-logged **before** it takes
 * effect — reusing the existing {@link TransitionLog} port with a reserved
 * sentinel `intentId` ({@link KILL_SWITCH_INTENT_ID}) rather than a new port. A
 * same-state transition is a no-op (no WAL row, no notification). Subscribers are
 * notified synchronously after the state flips.
 */

import type { KillSwitchState } from '../config/env.js'
import type { Unsubscribe } from '../core/ports/bus.js'
import type { Clock } from '../core/ports/clock.js'
import type { TransitionLog } from '../core/ports/transition-log.js'

/** Reserved WAL `intentId` for kill-switch transitions — not a real intent (`13` §6). */
export const KILL_SWITCH_INTENT_ID = '__kill_switch__'

export interface KillSwitch {
  /** Current state. */
  state(): KillSwitchState
  /** Move to `to`; no-op if already there, else WAL-log then notify subscribers. */
  transition(to: KillSwitchState, reason?: string): void
  /** Register a state-change listener; returns an idempotent unsubscribe. */
  subscribe(fn: (state: KillSwitchState) => void): Unsubscribe
}

export function createKillSwitch(opts: {
  readonly initial: KillSwitchState
  readonly clock: Clock
  readonly wal: TransitionLog
}): KillSwitch {
  const { clock, wal } = opts
  let current: KillSwitchState = opts.initial
  const subscribers = new Set<(state: KillSwitchState) => void>()

  return {
    state(): KillSwitchState {
      return current
    },
    transition(to: KillSwitchState, reason?: string): void {
      if (to === current) return // same-state no-op
      const from = current
      // WAL-before-side-effect (`14` §2.1): durably record the flip before it is observable.
      void wal.append({
        ts: clock.now(),
        intentId: KILL_SWITCH_INTENT_ID,
        fromState: from,
        toState: to,
        payload: { reason },
      })
      current = to
      for (const fn of subscribers) fn(to)
    },
    subscribe(fn: (state: KillSwitchState) => void): Unsubscribe {
      subscribers.add(fn)
      return () => {
        subscribers.delete(fn)
      }
    },
  }
}
