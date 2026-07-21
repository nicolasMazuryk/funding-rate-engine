/**
 * Scenario: **Strategy S3a — `sl_tp_deadline` exit** (`04_strategy_3a.md` §2/§3). Drives the real
 * S3a module + `sl_tp_deadline` handler through the sim venue on the virtual clock. S3a is the
 * first SHORT strategy: a SELL MARKET entry opens a short, and on fill a static reduce-only OCO
 * pair rests (BUY STOP-MARKET SL above entry, BUY LIMIT TP below entry) bounded by a deadline.
 *
 *  (a) **tp_hit** — the drop reaches the TP limit → CLOSED{tp_hit}, SL swept, funding booked;
 *  (b) **sl_hit (gap-through)** — a spike *past* the SL trigger fills the stop at the worse mark,
 *      not the trigger (`04` §3);
 *  (c) **deadline** — chop between the legs → the market close fires at `T_settle + deadlineSeconds`;
 *  (d) **SL before T_settle** — a pre-settlement SL fill ⇒ no position at settle ⇒ zero funding cost;
 *  (e) **OCO invariant** — after a TP fill the sibling SL is swept: a later spike never re-fills it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FundingFeeAccrued, OrderUpdate } from '../../src/core/events/types.js'
import type { SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import { harnessPool } from '../helpers/harness-pool.js'
import {
  buildS3aEngine,
  DEADLINE_TS,
  driveToSettled,
  driveToSlExit,
  driveToTpExit,
  SL_TRIGGER,
  TP_LIMIT,
  withPlacements,
} from '../helpers/s3a-scenario.js'
import { BTC, driveToEntry, INTENT_ID, SETTLE_TS, START_MS } from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

let tmp: TempDir
const pool = harnessPool()

function build(): SkeletonHarness {
  return pool.track(buildS3aEngine({ startMs: START_MS, walPath: tmp.walPath }))
}

/** Last WAL transition for an intent → its `[to, exitReason?]`. */
function lastTransition(h: SkeletonHarness, intentId: string): { to: string; exitReason?: string } {
  const rows = h.wal.readAll().filter((r) => r.intentId === intentId)
  const last = rows[rows.length - 1]
  return { to: last?.toState ?? '', exitReason: (last?.payload as { exitReason?: string } | undefined)?.exitReason }
}

/** Capture every FILLED OrderUpdate (client order id → fill price). */
function fillsByCoid(h: SkeletonHarness): Map<string, number> {
  const fills = new Map<string, number>()
  h.bus.subscribe((e: OrderUpdate | { type: string }) => {
    if (e.type === 'OrderUpdate' && (e as OrderUpdate).status === 'FILLED') {
      const u = e as OrderUpdate
      if (u.fillPx !== undefined) fills.set(u.clientOrderId, u.fillPx)
    }
  })
  return fills
}

beforeEach(() => {
  tmp = tempDir('s3a-scenario-')
})

afterEach(() => {
  pool.disposeAll()
  tmp.dispose()
})

describe('scenario: strategy S3a sl_tp_deadline exit', () => {
  it('(a) the drop reaches the TP → CLOSED{tp_hit}, SL swept, funding booked', () => {
    const h = build()
    const placements = withPlacements(h)

    driveToTpExit(h)

    const entry = placements.find((p) => p.req.clientOrderId.includes('-entry-'))
    const sl = placements.find((p) => p.req.clientOrderId.includes('-sl-'))
    const tp = placements.find((p) => p.req.clientOrderId.includes('-tp-'))
    // SHORT entry (SELL MARKET); OCO pair reduce-only, SL stop above entry, TP limit below.
    expect(entry?.req.side).toBe('short')
    expect(entry?.req.type).toBe('market')
    expect(sl).toMatchObject({ req: { side: 'long', type: 'stop', price: SL_TRIGGER, reduceOnly: true } })
    expect(tp).toMatchObject({ req: { side: 'long', type: 'limit', price: TP_LIMIT, reduceOnly: true } })

    expect(h.engine.intentState(INTENT_ID)).toBe('CLOSED')
    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'tp_hit' })
    expect(h.engine.fundingReceived(INTENT_ID)).toBe(true)
  })

  it('(b) a spike past the SL trigger fills the stop at the worse mark (gap-through) → CLOSED{sl_hit}', () => {
    const h = build()
    const fills = fillsByCoid(h)

    driveToSlExit(h, 60_700) // spike above the 60 600 trigger

    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'sl_hit' })
    // Gap-through: a BUY STOP fills at the mark (60 700), worse than the 60 600 trigger.
    const slFill = [...fills].find(([coid]) => coid.includes('-sl-'))?.[1]
    expect(slFill).toBe(60_700)
    expect(slFill).toBeGreaterThan(SL_TRIGGER)
    expect(h.engine.fundingReceived(INTENT_ID)).toBe(true)
  })

  it('(c) chop between the legs → the deadline market close fires → CLOSED{deadline}', () => {
    const h = build()

    driveToSettled(h)
    h.clock.advanceTo(SETTLE_TS + 1_000)
    h.exchange.setPrice(BTC.symbol, 60_100) // between TP and SL: neither fills
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')

    h.clock.advanceTo(DEADLINE_TS)
    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'deadline' })
  })

  it('(d) SL fill before T_settle → no position at settle → zero funding cost, CLOSED{sl_hit}', () => {
    const h = build()
    const fundingFees: FundingFeeAccrued[] = []
    h.bus.subscribe((e) => {
      if (e.type === 'FundingFeeAccrued') fundingFees.push(e)
    })

    driveToEntry(h) // MONITORING, OCO resting, still before T_settle
    h.clock.advanceTo(SETTLE_TS - 1_000)
    h.exchange.setPrice(BTC.symbol, 60_700) // SL fills a candle early → flat before settle

    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'sl_hit' })

    // Settlement now finds no position → the sim accrues nothing (the funding leg is zero).
    h.clock.advanceTo(SETTLE_TS)
    h.exchange.settleFunding(BTC.symbol, -0.35, SETTLE_TS)
    expect(fundingFees).toHaveLength(0)
  })

  it('(e) OCO invariant: after the TP fills the sibling SL is swept and never re-fills', () => {
    const h = build()
    const fills = fillsByCoid(h)

    driveToTpExit(h)
    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'tp_hit' })

    // A later spike that WOULD have crossed the 60 600 SL trigger must not fill it (it was swept).
    h.clock.advanceTo(DEADLINE_TS)
    h.exchange.setPrice(BTC.symbol, 60_700)
    expect([...fills].some(([coid]) => coid.includes('-sl-'))).toBe(false)
    expect(h.engine.intentState(INTENT_ID)).toBe('CLOSED')
  })
})
