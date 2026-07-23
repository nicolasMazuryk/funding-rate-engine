/**
 * Scenario: **Strategy S6 — post-funding directional, WS-gated entry**
 * (`07_strategy_6.md` §2/§3). Drives the real S6 module (entry sub-machine + the
 * `sl_tp_deadline_post_funding_event` OCO handler) through the sim venue on the virtual clock.
 *
 *  (a) **happy LONG** — PRE_FUNDING short opens, the WS funding_fee fires the MAIN reversal to a
 *      net LONG, the OCO rests from the settled |F|, and the TP fills → CLOSED{tp_hit};
 *  (b) **funding_event_timeout** — no funding event → gate timeout → abort ladder flattens the PRE
 *      leg → NO_POSITION{funding_event_timeout}, sim account flat;
 *  (c) **mainEventLock** — a duplicate funding_fee fires exactly one MAIN order;
 *  (d) **settled-|F| geometry** — the OCO prices derive from the settled +0.2, not the predicted +0.35.
 *
 * The gate + abort ladder resolve async (a microtask / gate-owned timers after `clock.advance`), so
 * those paths `await` a flush (mirrors the S1-WS scenario).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderRequest } from '../../src/core/ports/exchange-adapter.js'
import { stableStringify } from '../../src/replay/stable-stringify.js'
import type { SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import { harnessPool } from '../helpers/harness-pool.js'
import {
  BTC,
  buildS6Engine,
  driveToEntry,
  driveToMonitoring,
  driveToTimeout,
  driveToTpExit,
  flush,
  INTENT_ID,
  NET_QTY,
  SETTLE_RATE,
  SETTLE_TS,
  SL_TRIGGER,
  START_MS,
  TP_LIMIT,
  withPlacements,
} from '../helpers/s6-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

let tmp: TempDir
const pool = harnessPool()

function build(): SkeletonHarness {
  return pool.track(buildS6Engine({ startMs: START_MS, walPath: tmp.walPath }))
}

/** Last WAL transition for an intent → `[to, exitReason?, errorCode?]`. */
function lastTransition(h: SkeletonHarness, intentId: string): { to: string; exitReason?: string; errorCode?: string } {
  const rows = h.wal.readAll().filter((r) => r.intentId === intentId)
  const last = rows[rows.length - 1]
  const payload = (last?.payload ?? {}) as { exitReason?: string; errorCode?: string }
  return { to: last?.toState ?? '', exitReason: payload.exitReason, errorCode: payload.errorCode }
}

/** Every order placed, by leg substring. */
function byLeg(placements: Array<{ req: OrderRequest }>, leg: string): OrderRequest[] {
  return placements.filter((p) => p.req.clientOrderId.includes(`-${leg}-`)).map((p) => p.req)
}

beforeEach(() => {
  tmp = tempDir('s6-scenario-')
})

afterEach(() => {
  pool.disposeAll()
  tmp.dispose()
})

describe('scenario: strategy S6 post-funding-event entry', () => {
  it('(a) happy LONG: PRE short → WS gate → MAIN reversal → OCO from settled |F| → CLOSED{tp_hit}', async () => {
    const h = build()
    const placements = withPlacements(h)

    await driveToTpExit(h)

    const pre = byLeg(placements, 'pre')[0]
    const main = byLeg(placements, 'main')[0]
    const sl = byLeg(placements, 'sl')[0]
    const tp = byLeg(placements, 'tp')[0]
    // PRE opposite-direction SELL MARKET (not reduce-only); MAIN BUY MARKET reverses to net LONG.
    expect(pre).toMatchObject({ side: 'short', type: 'market' })
    expect(pre?.reduceOnly).toBeFalsy()
    expect(main).toMatchObject({ side: 'long', type: 'market', qty: 0.01 })
    // OCO reduce-only, sized to the net qty, priced off the settled |F| = 0.2 (tick-rounded).
    expect(sl).toMatchObject({ side: 'short', type: 'stop', reduceOnly: true })
    expect(tp).toMatchObject({ side: 'short', type: 'limit', reduceOnly: true })
    expect(sl?.price).toBeCloseTo(SL_TRIGGER, 1)
    expect(tp?.price).toBeCloseTo(TP_LIMIT, 1)
    expect(sl?.qty).toBeCloseTo(NET_QTY, 12)
    expect(tp?.qty).toBeCloseTo(NET_QTY, 12)

    expect(h.engine.intentState(INTENT_ID)).toBe('CLOSED')
    expect(lastTransition(h, INTENT_ID)).toMatchObject({ to: 'CLOSED', exitReason: 'tp_hit' })
    // MAIN filled after settlement ⇒ the managed position accrues no funding this cycle.
    expect(h.engine.fundingReceived(INTENT_ID)).toBe(false)
  })

  it('(b) funding_event_timeout: no funding event → abort ladder flattens PRE → NO_POSITION, account flat', async () => {
    const h = build()
    const placements = withPlacements(h)

    await driveToTimeout(h)

    expect(lastTransition(h, INTENT_ID)).toMatchObject({ to: 'NO_POSITION', errorCode: 'funding_event_timeout' })
    // The abort ladder placed a reduce-only close, and the sim account is flat.
    const abort = byLeg(placements, 'preabort')[0]
    expect(abort).toMatchObject({ side: 'long', type: 'market', reduceOnly: true })
    expect(await h.exchange.getPositions()).toEqual([])
    // No MAIN ever fired, and no OCO legs were placed.
    expect(byLeg(placements, 'main')).toHaveLength(0)
    expect(byLeg(placements, 'tp')).toHaveLength(0)
  })

  it('(c) mainEventLock: a duplicate WS funding_fee fires exactly one MAIN order', async () => {
    const h = build()
    const placements = withPlacements(h)

    driveToEntry(h)
    h.clock.advanceTo(SETTLE_TS)
    // Settle once (WS funding_fee), then inject a duplicate funding_fee straight onto the bus.
    h.exchange.settleFunding(BTC.symbol, SETTLE_RATE, SETTLE_TS)
    h.bus.publish({ type: 'FundingFeeAccrued', symbol: BTC.symbol, amount: -1, fundingTime: SETTLE_TS })
    await flush()

    expect(byLeg(placements, 'main')).toHaveLength(1)
  })

  it('(d) settled-|F| geometry: OCO derives from the settled +0.2, not the predicted +0.35', async () => {
    const h = build()
    const placements = withPlacements(h)

    await driveToMonitoring(h)

    const tp = byLeg(placements, 'tp')[0]
    // Predicted 0.35 would give TP 60 000×(1+0.35×1.5/100)=60 315; settled 0.2 gives 60 180.
    expect(tp?.price).toBeCloseTo(TP_LIMIT, 6)
    expect(tp?.price).not.toBeCloseTo(60_315, 1)
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')
  })

  it('(e) determinism: two fresh runs of the tp_hit path yield byte-identical WAL transitions', async () => {
    const runOnce = async (): Promise<string> => {
      const dir = tempDir('s6-determinism-')
      const h = pool.track(buildS6Engine({ startMs: START_MS, walPath: dir.walPath }))
      await driveToTpExit(h)
      const rows = h.wal.readAll().filter((r) => r.intentId === INTENT_ID)
      dir.dispose()
      return stableStringify(rows)
    }
    const a = await runOnce()
    const b = await runOnce()
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(2)
  })
})
