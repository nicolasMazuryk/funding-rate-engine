/**
 * `timed` exit-policy handler unit tests (task 0280; `01_strategy_1.md` §3).
 * Proves the load-bearing change from the 0270 placeholder: the deadline anchors
 * on `T_settle + exitOffsetSeconds` (absolute), not fill time. Covers live arm
 * timing, recovered-deadline re-arm, the missing-`settleTs` fail-loud, and firing
 * `timed` only on the matching deadline Timer.
 */

import { describe, expect, it } from 'vitest'
import type { Timer } from '../../../../../src/core/events/types.js'
import { TIMED_HANDLER } from '../../../../../src/core/intent/exit-policies/timed.js'
import type { ExitPolicyContext, MonitoredIntent } from '../../../../../src/core/intent/exit-policy.js'
import type { RuntimeStrategyConfig } from '../../../../../src/core/strategies/registry.js'

const EXIT_OFFSET_SECONDS = 6
const CONFIG: RuntimeStrategyConfig = {
  id: 's1',
  thresholdPercent: -0.4,
  direction: 'negative',
  entryOffsetSeconds: 5,
  exitOffsetSeconds: EXIT_OFFSET_SECONDS,
  amountUsd: 20,
  leverage: 4,
}

const SETTLE_TS = 8 * 3_600_000

function monitored(overrides: Partial<MonitoredIntent> = {}): MonitoredIntent {
  return {
    intentId: 'BTC-1000',
    symbol: 'BTC',
    entrySide: 'long',
    entryQty: 0.01,
    enteredAtMs: SETTLE_TS - 2_000, // filled ~2 s before settlement
    settleTs: SETTLE_TS,
    ...overrides,
  }
}

/** A ctx that records the deadlines armed against it. */
function recordingCtx(): { ctx: ExitPolicyContext; scheduled: Array<[string, number]> } {
  const scheduled: Array<[string, number]> = []
  return {
    scheduled,
    ctx: {
      scheduleDeadline: (intentId, atMs) => scheduled.push([intentId, atMs]),
      now: () => 0,
      requestExit: () => {},
    },
  }
}

function deadlineTimer(intentId: string, ts = 0): Timer {
  return { type: 'Timer', kind: 'deadline', ts, intentId }
}

describe('TIMED_HANDLER', () => {
  it('arms the deadline at T_settle + exitOffsetSeconds (not fill time) and returns it', () => {
    const { ctx, scheduled } = recordingCtx()
    const expected = SETTLE_TS + EXIT_OFFSET_SECONDS * 1000

    const deadlineMs = TIMED_HANDLER.arm(monitored(), CONFIG, ctx)

    expect(deadlineMs).toBe(expected)
    expect(scheduled).toEqual([['BTC-1000', expected]])
  })

  it('honours a pre-supplied deadlineMs (crash-recovery re-arm) over recomputing from settleTs', () => {
    const { ctx, scheduled } = recordingCtx()
    const intent = monitored({ deadlineMs: 42 })

    const deadlineMs = TIMED_HANDLER.arm(intent, CONFIG, ctx)

    expect(deadlineMs).toBe(42)
    expect(scheduled).toEqual([['BTC-1000', 42]])
  })

  it('fails loud when arming a live intent with no settleTs', () => {
    const { ctx } = recordingCtx()
    const intent = monitored({ settleTs: undefined })

    expect(() => TIMED_HANDLER.arm(intent, CONFIG, ctx)).toThrow(/no settleTs to arm the timed exit against/)
  })

  it('fires timed only on the matching deadline Timer', () => {
    const { ctx } = recordingCtx()
    const intent = monitored()

    expect(TIMED_HANDLER.onEvent(deadlineTimer('BTC-1000'), intent, CONFIG, ctx)).toEqual({ exitReason: 'timed' })
    // Wrong intent id, wrong timer kind, and a non-timer event all decline.
    expect(TIMED_HANDLER.onEvent(deadlineTimer('OTHER'), intent, CONFIG, ctx)).toBeUndefined()
    expect(TIMED_HANDLER.onEvent({ type: 'Timer', kind: 'scan', ts: 0 }, intent, CONFIG, ctx)).toBeUndefined()
    expect(
      TIMED_HANDLER.onEvent({ type: 'MarketTick', symbol: 'BTC', price: 60_000, ts: 0 }, intent, CONFIG, ctx),
    ).toBeUndefined()
  })
})
