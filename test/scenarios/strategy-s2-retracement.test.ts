/**
 * Scenario: **Strategy S2 — trailing-retracement exit** (`03_strategy_2.md` §2/§3). Drives
 * the real S2 module + `sl_tp_deadline_retracement_funding_event` handler (owning the funding
 * gate + retracement tracker) through the sim venue on the virtual clock. Covers the four exit
 * paths plus the same-session tracker restart:
 *
 *  (a) **tp_hit** — a V-retrace back to the anchor fills the trailing TP;
 *  (b) **sl_hit** — a continued decline triggers the resting SL after the gate opened (funding
 *      still booked);
 *  (c) **sl before T_settle** — an SL fill a candle early ⇒ no position at settle ⇒ no funding;
 *  (d) **deadline** — no recovery ⇒ the market close fires at `T_settle + deadlineSeconds`;
 *  (e) **restart mid-trailing** — the handler's serialize→restore rehydrates `P_low`, and the
 *      next new low re-places the TP from it (`03` §2: the tracker survives a restart).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FundingFeeAccrued, MarketTick } from '../../src/core/events/types.js'
import { createRetracementHandler, type RetracementHandler } from '../../src/core/intent/exit-policies/retracement.js'
import type { ExitLegRequest, ExitPolicyContext } from '../../src/core/intent/exit-policy.js'
import type { SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import { harnessPool } from '../helpers/harness-pool.js'
import {
  buildS2Engine,
  DEADLINE_TS,
  driveToTpExit,
  driveToTrailing,
  S2_RUNTIME_CONFIG,
  SL_TRIGGER,
  withPlacements,
} from '../helpers/s2-scenario.js'
import { BTC, driveToEntry, INTENT_ID, SETTLE_TS, START_MS } from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

const RETRACEMENT_KIND = 'sl_tp_deadline_retracement_funding_event'

let tmp: TempDir
const pool = harnessPool()

function build(): SkeletonHarness {
  return pool.track(buildS2Engine({ startMs: START_MS, walPath: tmp.walPath }))
}

/** Last WAL transition for an intent → its `[to, exitReason?]`. */
function lastTransition(h: SkeletonHarness, intentId: string): { to: string; exitReason?: string } {
  const rows = h.wal.readAll().filter((r) => r.intentId === intentId)
  const last = rows[rows.length - 1]
  return { to: last?.toState ?? '', exitReason: (last?.payload as { exitReason?: string } | undefined)?.exitReason }
}

beforeEach(() => {
  tmp = tempDir('s2-scenario-')
})

afterEach(() => {
  pool.disposeAll()
  tmp.dispose()
})

describe('scenario: strategy S2 trailing-retracement exit', () => {
  it('(a) V-retrace fills the trailing TP → CLOSED{tp_hit}, SL swept, funding booked', () => {
    const h = build()
    const placements = withPlacements(h)

    driveToTpExit(h)

    const sl = placements.find((p) => p.req.clientOrderId.includes('-sl-'))
    const tps = placements.filter((p) => p.req.clientOrderId.includes('-tp-'))
    // SL rests as a reduce-only stop from entry fill; the TP rotates (≥ 2 placements at the anchor).
    expect(sl?.req.type).toBe('stop')
    expect(sl?.req.price).toBe(SL_TRIGGER)
    expect(sl?.req.reduceOnly).toBe(true)
    expect(tps.length).toBeGreaterThanOrEqual(2)
    expect(tps.every((p) => p.req.type === 'limit' && p.req.price === BTC.price && p.req.reduceOnly === true)).toBe(
      true,
    )

    expect(h.engine.intentState(INTENT_ID)).toBe('CLOSED')
    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'tp_hit' })
    expect(h.engine.fundingReceived(INTENT_ID)).toBe(true)
  })

  it('(b) continued decline after the gate opens triggers the SL → CLOSED{sl_hit}, funding still booked', () => {
    const h = build()

    driveToTrailing(h)
    h.clock.advanceTo(SETTLE_TS + 1_000)
    h.exchange.setPrice(BTC.symbol, 59_700) // first trailing low → TP placed
    h.clock.advanceTo(SETTLE_TS + 2_000)
    h.exchange.setPrice(BTC.symbol, 59_600) // ≤ SL trigger (59 640) → SL fills

    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'sl_hit' })
    // Gate opened before the SL fired, so the funding leg was collected (`03` §3.1).
    expect(h.engine.fundingReceived(INTENT_ID)).toBe(true)
  })

  it('(c) SL fill before T_settle → no position at settle → funding not booked, CLOSED{sl_hit}', () => {
    const h = build()
    const fundingFees: FundingFeeAccrued[] = []
    h.bus.subscribe((e) => {
      if (e.type === 'FundingFeeAccrued') fundingFees.push(e)
    })

    driveToEntry(h) // MONITORING, SL resting, still before T_settle
    h.clock.advanceTo(SETTLE_TS - 1_000)
    h.exchange.setPrice(BTC.symbol, 59_600) // SL fills a candle early → position flat before settle

    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'sl_hit' })

    // Settlement now finds no position → the sim accrues nothing (the accrual test handles it).
    h.clock.advanceTo(SETTLE_TS)
    h.exchange.settleFunding(BTC.symbol, -0.4, SETTLE_TS + 4_000)
    expect(fundingFees).toHaveLength(0)
  })

  it('(d) no recovery → the deadline market close fires at T_settle + deadlineSeconds → CLOSED{deadline}', () => {
    const h = build()

    driveToTrailing(h)
    h.clock.advanceTo(SETTLE_TS + 1_000)
    h.exchange.setPrice(BTC.symbol, 59_700) // above the SL, below the anchor: TP never fills

    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')

    h.clock.advanceTo(DEADLINE_TS)
    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'deadline' })
  })

  it('(e) restart mid-trailing: serialize→restore rehydrates P_low; the next new low re-places the TP', () => {
    const h = build()

    driveToTrailing(h)
    h.clock.advanceTo(SETTLE_TS + 1_000)
    h.exchange.setPrice(BTC.symbol, 59_700) // trailing low → TP placed; P_low = 59 700

    // The live engine's handler snapshots the tracker (mirrors FundingGate serialize; 0370 does the durable write).
    const handler = h.exitPolicyRegistry.get(RETRACEMENT_KIND) as RetracementHandler
    const snapshot = handler.serialize()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.tracker.pLow).toBe(59_700)
    expect(snapshot[0]?.tracker.phase).toBe('trailing')

    // Simulate a restart: a fresh handler restores the snapshot, then drives ticks through a
    // recording ctx (full recover-respawn wiring is 0370 — the anchor is not yet WAL-persisted).
    const restored = createRetracementHandler({
      clock: h.clock,
      fundingIncome: (symbol, range) => h.exchange.fundingIncome(symbol, range),
    })
    restored.restore(snapshot)

    const placed: ExitLegRequest[] = []
    const ctx = recordingCtx(placed)
    const intent = { intentId: INTENT_ID, symbol: BTC.symbol, entrySide: 'long', entryQty: 0.001, enteredAtMs: 0 }
    const feed = (px: number, nowMs: number): void => {
      const tick: MarketTick = { type: 'MarketTick', symbol: BTC.symbol, price: px, ts: nowMs }
      restored.onEvent(tick, intent, S2_RUNTIME_CONFIG, ctx)
    }

    feed(59_750, SETTLE_TS + 90_000) // not below restored P_low → no re-place (proves P_low survived)
    expect(placed).toHaveLength(0)

    feed(59_650, SETTLE_TS + 91_000) // a lower low → re-place the TP from the restored P_low
    expect(placed).toHaveLength(1)
    expect(placed[0]).toMatchObject({ type: 'limit', price: BTC.price }) // retracementPct 1 ⇒ TP at the anchor
  })
})

/** A ctx that records placed exit legs (the restart re-place assertion); other seams are no-ops. */
function recordingCtx(placed: ExitLegRequest[]): ExitPolicyContext {
  let n = 0
  return {
    scheduleDeadline: () => {},
    now: () => 0,
    requestExit: () => {},
    placeExitLeg: (_intentId: string, req: ExitLegRequest) => {
      placed.push(req)
      n += 1
      return `coid-${n}`
    },
    cancelExitLeg: () => {},
    confirmClose: () => {},
  }
}
