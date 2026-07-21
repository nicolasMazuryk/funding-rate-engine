/**
 * Unit tests for the `sl_tp_deadline` exit policy (task 0320; `04_strategy_3a.md` §3) and the
 * S3a OCO price geometry. The handler is pure given its geometry callbacks + the engine's
 * order-command seam, so these tests drive it through a recording {@link ExitPolicyContext}:
 *
 *  - arm places a static reduce-only OCO pair — SL stop *above* entry, TP limit *below* entry
 *    (the short-side arithmetic) — and returns the deadline instant;
 *  - the geometry's fixed-percent SL vs funding-scaled TP asymmetry, and the realized-rate `|F|`
 *    source (falling back to the threshold only when `ratePercent` is absent);
 *  - a leg fill routes to `confirmClose` with the right `exit_reason` (SL → `sl_hit`, TP →
 *    `tp_hit`); an update on a since-cancelled leg is ignored;
 *  - the deadline Timer fires `requestExit('deadline')`;
 *  - fail-loud arming when `entryFillPx` / `settleTs` / `deadlineSeconds` is missing.
 */

import { describe, expect, it } from 'vitest'
import type { OrderUpdate } from '../../../../../src/core/events/types.js'
import { createSlTpDeadlineHandler } from '../../../../../src/core/intent/exit-policies/sl-tp-deadline.js'
import type { ExitLegRequest, ExitPolicyContext, MonitoredIntent } from '../../../../../src/core/intent/exit-policy.js'
import type { RuntimeStrategyConfig } from '../../../../../src/core/strategies/registry.js'
import { strategy3aGeometry } from '../../../../../src/core/strategies/strategy-3a.js'

const SETTLE_TS = 8 * 3_600_000
const DEADLINE_SECONDS = 900

const CONFIG: RuntimeStrategyConfig = {
  id: 's3a',
  thresholdPercent: -0.3,
  direction: 'negative',
  entrySide: 'short',
  entryOffsetSeconds: 3,
  stopLossPercent: 1.0,
  tpVariantAMultiplier: 1.5,
  deadlineSeconds: DEADLINE_SECONDS,
  amountUsd: 10,
  leverage: 5,
}

function intent(overrides: Partial<MonitoredIntent> = {}): MonitoredIntent {
  return {
    intentId: 'BTC-1',
    symbol: 'BTC',
    entrySide: 'short',
    entryQty: 0.001,
    entryFillPx: 60_000,
    entryFillQty: 0.001,
    enteredAtMs: SETTLE_TS - 3_000,
    settleTs: SETTLE_TS,
    ratePercent: -0.35,
    ...overrides,
  }
}

interface Recorder {
  readonly placed: Array<{ intentId: string; req: ExitLegRequest }>
  readonly cancelled: string[]
  readonly deadlines: Array<{ intentId: string; atMs: number }>
  readonly exits: Array<{ intentId: string; reason: string }>
  readonly closes: Array<{ intentId: string; reason: string; coid: string }>
  ctx: ExitPolicyContext
}

/** A ctx that records every order-command seam call and hands out deterministic client order ids. */
function recorder(): Recorder {
  const r: Recorder = {
    placed: [],
    cancelled: [],
    deadlines: [],
    exits: [],
    closes: [],
    ctx: undefined as unknown as ExitPolicyContext,
  }
  r.ctx = {
    scheduleDeadline: (intentId, atMs) => r.deadlines.push({ intentId, atMs }),
    now: () => SETTLE_TS,
    requestExit: (intentId, reason) => r.exits.push({ intentId, reason }),
    placeExitLeg: (intentId, req) => {
      r.placed.push({ intentId, req })
      return `${intentId}-${req.leg}-${req.attempt}`
    },
    cancelExitLeg: (coid) => r.cancelled.push(coid),
    confirmClose: (intentId, reason, coid) => r.closes.push({ intentId, reason, coid }),
  }
  return r
}

function fill(clientOrderId: string): OrderUpdate {
  return { type: 'OrderUpdate', clientOrderId, status: 'FILLED', fillPx: 0, qty: 0.001 }
}

describe('sl_tp_deadline handler (S3a geometry)', () => {
  it('arms a static reduce-only OCO pair and returns the deadline instant', () => {
    const h = createSlTpDeadlineHandler(strategy3aGeometry)
    const r = recorder()

    const deadlineMs = h.arm(intent(), CONFIG, r.ctx)

    expect(deadlineMs).toBe(SETTLE_TS + DEADLINE_SECONDS * 1_000)
    expect(r.deadlines).toEqual([{ intentId: 'BTC-1', atMs: deadlineMs }])
    // SL stop ABOVE entry (buy-to-close a short), TP limit BELOW entry — the short-side OCO.
    const sl = r.placed.find((p) => p.req.leg === 'sl')?.req
    const tp = r.placed.find((p) => p.req.leg === 'tp')?.req
    expect(sl).toMatchObject({ type: 'stop', price: 60_600, qty: 0.001 }) // 60 000 × (1 + 1.0/100)
    expect(tp).toMatchObject({ type: 'limit', price: 59_685, qty: 0.001 }) // 60 000 × (1 − 0.35 × 1.5/100)
    expect(sl?.price).toBeGreaterThan(60_000)
    expect(tp?.price).toBeLessThan(60_000)
  })

  it('scales the TP off the realized predicted rate, not the threshold', () => {
    // ratePercent −0.5 (steeper than the −0.3 threshold) ⇒ a deeper TP than a threshold proxy.
    expect(strategy3aGeometry.tpPrice(intent({ ratePercent: -0.5 }), CONFIG)).toBe(59_550) // 60 000 × (1 − 0.5×1.5/100)
    // absent realized rate ⇒ fall back to the selection threshold (|−0.3|).
    expect(strategy3aGeometry.tpPrice(intent({ ratePercent: undefined }), CONFIG)).toBe(59_730) // 60 000 × (1 − 0.3×1.5/100)
  })

  it('routes an SL fill to confirmClose{sl_hit} and a TP fill to confirmClose{tp_hit}', () => {
    const slHandler = createSlTpDeadlineHandler(strategy3aGeometry)
    const rSl = recorder()
    slHandler.arm(intent(), CONFIG, rSl.ctx)
    slHandler.onOrderUpdate?.(fill('BTC-1-sl-1'), intent(), CONFIG, rSl.ctx)
    expect(rSl.closes).toEqual([{ intentId: 'BTC-1', reason: 'sl_hit', coid: 'BTC-1-sl-1' }])

    const tpHandler = createSlTpDeadlineHandler(strategy3aGeometry)
    const rTp = recorder()
    tpHandler.arm(intent(), CONFIG, rTp.ctx)
    tpHandler.onOrderUpdate?.(fill('BTC-1-tp-1'), intent(), CONFIG, rTp.ctx)
    expect(rTp.closes).toEqual([{ intentId: 'BTC-1', reason: 'tp_hit', coid: 'BTC-1-tp-1' }])
  })

  it('ignores an update on a since-cancelled/unknown leg', () => {
    const h = createSlTpDeadlineHandler(strategy3aGeometry)
    const r = recorder()
    h.arm(intent(), CONFIG, r.ctx)
    h.onOrderUpdate?.(fill('BTC-1-unknown'), intent(), CONFIG, r.ctx)
    expect(r.closes).toHaveLength(0)
  })

  it('fires requestExit(deadline) on the deadline Timer, once', () => {
    const h = createSlTpDeadlineHandler(strategy3aGeometry)
    const r = recorder()
    h.arm(intent(), CONFIG, r.ctx)
    const timer = { type: 'Timer', kind: 'deadline', ts: 0, intentId: 'BTC-1' } as const
    h.onEvent(timer, intent(), CONFIG, r.ctx)
    h.onEvent(timer, intent(), CONFIG, r.ctx) // idempotent: record already deleted
    expect(r.exits).toEqual([{ intentId: 'BTC-1', reason: 'deadline' }])
  })

  it('fails loud when arming without entryFillPx / settleTs / deadlineSeconds', () => {
    const h = createSlTpDeadlineHandler(strategy3aGeometry)
    const r = recorder()
    expect(() => h.arm(intent({ entryFillPx: undefined }), CONFIG, r.ctx)).toThrow(/entryFillPx/)
    expect(() => h.arm(intent({ settleTs: undefined }), CONFIG, r.ctx)).toThrow(/settleTs/)
    expect(() => h.arm(intent(), { ...CONFIG, deadlineSeconds: undefined }, r.ctx)).toThrow(/deadlineSeconds/)
  })
})
