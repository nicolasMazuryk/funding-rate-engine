/**
 * Kill-switch unit tests (task 0140; `13` §2 / `00_globals.md` §5.1). Bootstrap,
 * transition + WAL entry, same-state no-op, subscriber notification.
 */

import { describe, expect, it } from 'vitest'
import type { Clock, TimerHandle } from '../../../src/core/ports/clock.js'
import type { TransitionLog, TransitionLogEntry } from '../../../src/core/ports/transition-log.js'
import { createKillSwitch, KILL_SWITCH_INTENT_ID } from '../../../src/risk/kill-switch.js'

/** A clock frozen at a fixed instant — the WAL `ts` under test. */
function fixedClock(nowMs: number): Clock {
  return {
    now: () => nowMs,
    scheduleTimer: (): TimerHandle => ({ cancel: () => {} }),
  }
}

/** A WAL that records appended entries for assertion. */
function recordingWal(): TransitionLog & { readonly entries: TransitionLogEntry[] } {
  const entries: TransitionLogEntry[] = []
  return {
    entries,
    append(entry: TransitionLogEntry): Promise<void> {
      entries.push(entry)
      return Promise.resolve()
    },
  }
}

describe('createKillSwitch', () => {
  it('bootstraps at its initial state', () => {
    const ks = createKillSwitch({ initial: 'off', clock: fixedClock(0), wal: recordingWal() })
    expect(ks.state()).toBe('off')
  })

  it('transitions state and appends a WAL entry with the reserved sentinel id', () => {
    const wal = recordingWal()
    const ks = createKillSwitch({ initial: 'off', clock: fixedClock(1_000), wal })
    ks.transition('paused', 'manual halt')

    expect(ks.state()).toBe('paused')
    expect(wal.entries).toEqual([
      {
        ts: 1_000,
        intentId: KILL_SWITCH_INTENT_ID,
        fromState: 'off',
        toState: 'paused',
        payload: { reason: 'manual halt' },
      },
    ])
  })

  it('is a no-op on a same-state transition (no WAL, no notify)', () => {
    const wal = recordingWal()
    const ks = createKillSwitch({ initial: 'paused', clock: fixedClock(0), wal })
    let notified = 0
    ks.subscribe(() => notified++)
    ks.transition('paused')
    expect(wal.entries).toHaveLength(0)
    expect(notified).toBe(0)
  })

  it('notifies subscribers synchronously on a real transition', () => {
    const ks = createKillSwitch({ initial: 'off', clock: fixedClock(0), wal: recordingWal() })
    const seen: string[] = []
    const unsubscribe = ks.subscribe((s) => seen.push(s))
    ks.transition('paused')
    ks.transition('flatten')
    unsubscribe()
    ks.transition('off')
    expect(seen).toEqual(['paused', 'flatten'])
  })
})
