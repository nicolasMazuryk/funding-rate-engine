/**
 * Exit-policy dispatch unit tests (task 0270; `12` §5). Covers the registry
 * (duplicate-kind fail-loud + lookup), the engine resolving its handler by kind
 * (an unregistered kind fails loud at `createEngine`, proving registry-driven
 * dispatch with no name branching — DoD #3), and the `timed` placeholder handler.
 */

import { describe, expect, it } from 'vitest'
import type { Timer } from '../../../src/core/events/types.js'
import {
  createExitPolicyRegistry,
  type ExitPolicyContext,
  type ExitPolicyHandler,
  type MonitoredIntent,
  TIMED_PLACEHOLDER_HANDLER,
} from '../../../src/core/intent/exit-policy.js'
import {
  createStrategyRegistry,
  type RuntimeStrategyConfig,
  type StrategyModule,
} from '../../../src/core/strategies/registry.js'
import { buildSkeletonEngine } from '../../helpers/build-skeleton-engine.js'
import { tempDir } from '../../helpers/temp-dir.js'

const CONFIG: RuntimeStrategyConfig = {
  id: 's1',
  thresholdPercent: -0.3,
  direction: 'negative',
  entryOffsetSeconds: 90,
  holdMs: 300_000,
  entryQty: 0.01,
  amountUsd: 50,
  leverage: 1,
}

function monitored(overrides: Partial<MonitoredIntent> = {}): MonitoredIntent {
  return {
    intentId: 'BTC-1000',
    symbol: 'BTC',
    entrySide: 'long',
    entryQty: 0.01,
    enteredAtMs: 1_000_000,
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
    },
  }
}

function deadlineTimer(intentId: string, ts = 0): Timer {
  return { type: 'Timer', kind: 'deadline', ts, intentId }
}

describe('createExitPolicyRegistry', () => {
  it('indexes handlers by kind', () => {
    const registry = createExitPolicyRegistry([TIMED_PLACEHOLDER_HANDLER])
    expect(registry.get('timed')).toBe(TIMED_PLACEHOLDER_HANDLER)
    expect(registry.get('funding_fee_event')).toBeUndefined()
  })

  it('throws on a duplicate kind (fail-loud)', () => {
    const other: ExitPolicyHandler = { ...TIMED_PLACEHOLDER_HANDLER }
    expect(() => createExitPolicyRegistry([TIMED_PLACEHOLDER_HANDLER, other])).toThrow(
      /duplicate exit-policy kind 'timed'/,
    )
  })
})

describe('engine exit-policy resolution (DoD #3)', () => {
  it('fails loud when the active module declares an unregistered exit-policy kind', () => {
    const tmp = tempDir('exit-policy-test-')
    // Module declares `funding_fee_event`; the default registry only knows `timed`.
    const module: StrategyModule = { id: 's1', exitPolicyKind: 'funding_fee_event', select: () => undefined }
    try {
      expect(() => buildSkeletonEngine({ walPath: tmp.walPath, registry: createStrategyRegistry([module]) })).toThrow(
        /no exit-policy handler registered for kind 'funding_fee_event'/,
      )
    } finally {
      tmp.dispose()
    }
  })
})

describe('TIMED_PLACEHOLDER_HANDLER', () => {
  it('arms a deadline at enteredAtMs + holdMs and returns it', () => {
    const { ctx, scheduled } = recordingCtx()
    const intent = monitored({ enteredAtMs: 1_000_000 })

    const deadlineMs = TIMED_PLACEHOLDER_HANDLER.arm(intent, CONFIG, ctx)

    expect(deadlineMs).toBe(1_000_000 + CONFIG.holdMs)
    expect(scheduled).toEqual([['BTC-1000', 1_000_000 + CONFIG.holdMs]])
  })

  it('honours a pre-supplied deadlineMs (crash-recovery re-arm)', () => {
    const { ctx, scheduled } = recordingCtx()
    const intent = monitored({ enteredAtMs: 1_000_000, deadlineMs: 42 })

    const deadlineMs = TIMED_PLACEHOLDER_HANDLER.arm(intent, CONFIG, ctx)

    expect(deadlineMs).toBe(42)
    expect(scheduled).toEqual([['BTC-1000', 42]])
  })

  it('fires timed only on the matching deadline Timer', () => {
    const { ctx } = recordingCtx()
    const intent = monitored()

    expect(TIMED_PLACEHOLDER_HANDLER.onEvent(deadlineTimer('BTC-1000'), intent, CONFIG, ctx)).toEqual({
      exitReason: 'timed',
    })
    // Wrong intent id, wrong timer kind, and a non-timer event all decline.
    expect(TIMED_PLACEHOLDER_HANDLER.onEvent(deadlineTimer('OTHER'), intent, CONFIG, ctx)).toBeUndefined()
    expect(
      TIMED_PLACEHOLDER_HANDLER.onEvent({ type: 'Timer', kind: 'scan', ts: 0 }, intent, CONFIG, ctx),
    ).toBeUndefined()
    expect(
      TIMED_PLACEHOLDER_HANDLER.onEvent(
        { type: 'MarketTick', symbol: 'BTC', price: 60_000, ts: 0 },
        intent,
        CONFIG,
        ctx,
      ),
    ).toBeUndefined()
  })
})
