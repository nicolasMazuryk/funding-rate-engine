/**
 * Unit: **S6 entry sub-machine** (`07_strategy_6.md` §2/§3). Drives the FSM against a fake
 * {@link EntryContext} + a virtual clock (the funding gate + abort ladder are clock-timer driven).
 *
 * Coverage: one test per **error code** (all seven fire from `SUBMITTING_ENTRY`); the once-only
 * `mainEventLock` (duplicate `funding_fee` ⇒ exactly one MAIN); the happy MONITORING confirm; and
 * the REST-confirm-failed → tracked-fills fallback. All deterministic — no wall clock, no randomness.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../../../src/adapters/clock/virtual-clock.js'
import type { OrderStatus, Position, Side } from '../../../../src/core/ports/exchange-adapter.js'
import type { OpsEvent } from '../../../../src/core/runtime/engine.js'
import type { EntryContext } from '../../../../src/core/runtime/entry-submachine.js'
import { createStrategy6EntrySubMachine } from '../../../../src/core/strategies/entry-submachines/strategy-6-entry.js'

const INTENT = 'BTC-1'
const SETTLE = 10_000

function shortPos(qty: number): Position {
  return { symbol: 'BTC', side: 'short', qty }
}
function longPos(qty: number): Position {
  return { symbol: 'BTC', side: 'long', qty }
}

interface Recorder {
  preFundings: Array<{ intentId: string; qty: number }>
  mains: Array<{ intentId: string; qty: number }>
  aborts: Array<{ intentId: string; attempt: number; qty: number }>
  monitored: Array<{ intentId: string; netQty: number; entryPx: number }>
  failed: Array<{ intentId: string; errorCode: string }>
  ops: OpsEvent[]
  positions: Position[]
  flattenOnAbort: boolean
  getPositionsThrows: boolean
}

function setup() {
  const clock = createVirtualClock(0)
  const rec: Recorder = {
    preFundings: [],
    mains: [],
    aborts: [],
    monitored: [],
    failed: [],
    ops: [],
    positions: [],
    flattenOnAbort: true,
    getPositionsThrows: false,
  }
  const ctx: EntryContext = {
    placePreFunding: (intentId, qty) => {
      rec.preFundings.push({ intentId, qty })
      return `${intentId}-pre-1`
    },
    placeMain: (intentId, qty) => {
      rec.mains.push({ intentId, qty })
      return `${intentId}-main-1`
    },
    placeAbortClose: (intentId, attempt, qty) => {
      rec.aborts.push({ intentId, attempt, qty })
      if (rec.flattenOnAbort) rec.positions = []
    },
    getPositions: () =>
      rec.getPositionsThrows ? Promise.reject(new Error('REST down')) : Promise.resolve(rec.positions),
    enterMonitoring: (intentId, netQty, entryPx) => {
      rec.monitored.push({ intentId, netQty, entryPx })
    },
    failEntry: (intentId, errorCode) => {
      rec.failed.push({ intentId, errorCode })
    },
    emitOps: (event) => {
      rec.ops.push(event)
    },
  }
  const sm = createStrategy6EntrySubMachine({ clock, fundingIncome: () => Promise.resolve([]) })
  const begin = () =>
    sm.begin(
      {
        intentId: INTENT,
        symbol: 'BTC',
        settleTs: SETTLE,
        timeoutSeconds: 10,
        preQty: 0.001,
        mainQty: 0.01,
        abortCloseSide: 'long',
      },
      ctx,
    )
  const orderUpdate = (status: OrderStatus, opts: { fillPx?: number } = {}) =>
    sm.onOrderUpdate({ type: 'OrderUpdate', clientOrderId: 'x', status, ...opts }, INTENT, ctx)
  const fundingFee = (fundingTime = SETTLE) =>
    sm.onFundingFee({ type: 'FundingFeeAccrued', symbol: 'BTC', amount: -1, fundingTime }, ctx)
  return { clock, rec, ctx, sm, begin, orderUpdate, fundingFee }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

/** Advance the virtual clock in 1 s steps, flushing microtasks so gate + abort-ladder awaits progress. */
async function drain(clock: VirtualClock): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await flush()
    clock.advanceBy(1000)
  }
  await flush()
}

describe('S6 entry sub-machine — error terminals (07 §3, all from SUBMITTING_ENTRY)', () => {
  it('pre_funding_order_failed: PRE submission FAILED', () => {
    const t = setup()
    t.begin()
    t.orderUpdate('FAILED')
    expect(t.rec.failed).toEqual([{ intentId: INTENT, errorCode: 'pre_funding_order_failed' }])
    expect(t.rec.mains).toHaveLength(0)
  })

  it('pre_funding_order_rejected: exchange rejected PRE', () => {
    const t = setup()
    t.begin()
    t.orderUpdate('REJECTED')
    expect(t.rec.failed).toEqual([{ intentId: INTENT, errorCode: 'pre_funding_order_rejected' }])
  })

  it('pre_funding_not_filled: gate opens but PRE never filled → abort (nothing to close) → NO_POSITION', async () => {
    const t = setup()
    t.begin() // PRE placed, no FILLED update
    t.rec.positions = [] // nothing actually opened
    t.fundingFee() // gate opens ws → preFilled false → abort → pre_funding_not_filled
    await drain(t.clock)
    expect(t.rec.mains).toHaveLength(0)
    expect(t.rec.failed).toEqual([{ intentId: INTENT, errorCode: 'pre_funding_not_filled' }])
  })

  it('funding_event_timeout: no funding fee within timeout → abort ladder flattens PRE → NO_POSITION', async () => {
    const t = setup()
    t.begin()
    t.orderUpdate('FILLED', { fillPx: 60_000 }) // PRE filled
    t.rec.positions = [shortPos(0.001)] // the tiny opposite leg on the venue
    await drain(t.clock) // no funding fee → gate timeout → abort ladder
    expect(t.rec.mains).toHaveLength(0)
    expect(t.rec.aborts.length).toBeGreaterThanOrEqual(1)
    expect(t.rec.failed).toEqual([{ intentId: INTENT, errorCode: 'funding_event_timeout' }])
    expect(t.rec.positions).toEqual([]) // flat
  })

  it('main_order_failed: MAIN submission FAILED → abort ladder flattens PRE', async () => {
    const t = setup()
    t.begin()
    t.orderUpdate('FILLED', { fillPx: 60_000 })
    t.rec.positions = [shortPos(0.001)]
    t.clock.advanceTo(SETTLE)
    t.fundingFee() // gate opens → placeMain (synchronous record)
    expect(t.rec.mains).toHaveLength(1)
    t.orderUpdate('FAILED') // MAIN failed
    await drain(t.clock)
    expect(t.rec.failed).toEqual([{ intentId: INTENT, errorCode: 'main_order_failed' }])
  })

  it('main_order_rejected: MAIN rejected → abort ladder flattens PRE', async () => {
    const t = setup()
    t.begin()
    t.orderUpdate('FILLED', { fillPx: 60_000 })
    t.rec.positions = [shortPos(0.001)]
    t.clock.advanceTo(SETTLE)
    t.fundingFee()
    t.orderUpdate('REJECTED')
    await drain(t.clock)
    expect(t.rec.failed).toEqual([{ intentId: INTENT, errorCode: 'main_order_rejected' }])
  })

  it('close_pre_funding_failed: abort ladder cannot flatten → ops alert + NO_POSITION (orphan risk)', async () => {
    const t = setup()
    t.begin()
    t.orderUpdate('FILLED', { fillPx: 60_000 })
    t.rec.positions = [shortPos(0.001)]
    t.rec.flattenOnAbort = false // the reduce-only close never lands
    await drain(t.clock) // timeout → abort exhausts → close_pre_funding_failed
    expect(t.rec.aborts.map((a) => a.attempt)).toEqual([1, 2, 3])
    expect(t.rec.ops).toContainEqual({ kind: 'strategy6.close_pre_funding_failed', intentId: INTENT, symbol: 'BTC' })
    expect(t.rec.failed).toEqual([{ intentId: INTENT, errorCode: 'close_pre_funding_failed' }])
  })
})

describe('S6 entry sub-machine — mainEventLock + confirm (07 §2 step 3/4)', () => {
  it('mainEventLock: a duplicate funding_fee fires MAIN exactly once', () => {
    const t = setup()
    t.begin()
    t.orderUpdate('FILLED', { fillPx: 60_000 })
    t.rec.positions = [shortPos(0.001)]
    t.clock.advanceTo(SETTLE)
    t.fundingFee()
    t.fundingFee() // duplicate injection
    expect(t.rec.mains).toEqual([{ intentId: INTENT, qty: 0.01 }])
  })

  it('happy: MAIN fill → REST net confirm → enterMonitoring with the net qty + MAIN fill price', async () => {
    const t = setup()
    t.begin()
    t.orderUpdate('FILLED', { fillPx: 60_000 }) // PRE fill
    t.clock.advanceTo(SETTLE)
    t.fundingFee() // gate opens → placeMain
    t.rec.positions = [longPos(0.009)] // net after reversal = mainQty − preQty
    t.orderUpdate('FILLED', { fillPx: 60_500 }) // MAIN fill → confirmAndMonitor
    await drain(t.clock)
    expect(t.rec.failed).toHaveLength(0)
    expect(t.rec.monitored).toEqual([{ intentId: INTENT, netQty: 0.009, entryPx: 60_500 }])
  })

  it('REST confirm fails → tracked-fills fallback (mainQty − preQty) + ops warn', async () => {
    const t = setup()
    t.begin()
    t.orderUpdate('FILLED', { fillPx: 60_000 })
    t.clock.advanceTo(SETTLE)
    t.fundingFee()
    t.rec.getPositionsThrows = true // the normative getPositions confirm fails
    t.orderUpdate('FILLED', { fillPx: 60_500 })
    await drain(t.clock)
    expect(t.rec.ops).toContainEqual({ kind: 'strategy6.position_fetch_fallback', intentId: INTENT, symbol: 'BTC' })
    // Fallback net = mainQty (0.01) − preQty (0.001) = 0.009 (float-noise tolerant).
    expect(t.rec.monitored).toHaveLength(1)
    expect(t.rec.monitored[0]?.entryPx).toBe(60_500)
    expect(t.rec.monitored[0]?.netQty).toBeCloseTo(0.009, 12)
  })
})

/** Guard the `Side` import stays meaningful (abort ladder closes the opposite-side residual). */
const _abortSide: Side = 'long'
void _abortSide
