/**
 * Scenario: **Strategy S1 — timed exit** (`01_strategy_1.md` §2/§3). Drives the real
 * S1 module + `timed` handler through the sim venue on the virtual clock:
 *
 *  - entry decided at `T_settle − entryOffsetSeconds`, exit **commanded** at
 *    `T_settle + exitOffsetSeconds`, `exit_reason = timed` on the closed intent;
 *  - **late fill** (fill released after `T_settle` via `reorderNextOrderUpdate`) →
 *    `funding_received = false` (`00_globals.md` §3.1 accrual test);
 *  - **entry reject** → `ENTRY_FAILED{main_order_rejected}`.
 *
 * The timed exit anchors on `T_settle`, never fill time — the load-bearing S1
 * behaviour (`01` §6), asserted by the exit landing at `T_settle + exitOffset`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineEvent, Timer } from '../../src/core/events/types.js'
import type { OrderAck, OrderRequest } from '../../src/core/ports/exchange-adapter.js'
import { buildSkeletonEngine, type SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import { harnessPool } from '../helpers/harness-pool.js'
import {
  BTC,
  DEADLINE_TS,
  driveToDeadline,
  driveToEntry,
  ENTRY_TS,
  INTENT_ID,
  SCAN_TS,
  SETTLE_TS,
  START_MS,
} from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

let tmp: TempDir
const pool = harnessPool()

function build(): SkeletonHarness {
  return pool.track(buildSkeletonEngine({ startMs: START_MS, walPath: tmp.walPath }))
}

/** Last WAL transition for an intent → its `[from, to, exitReason?]`. */
function lastTransition(h: SkeletonHarness, intentId: string): { to: string; exitReason?: string } {
  const rows = h.wal.readAll().filter((r) => r.intentId === intentId)
  const last = rows[rows.length - 1]
  return { to: last?.toState ?? '', exitReason: (last?.payload as { exitReason?: string } | undefined)?.exitReason }
}

beforeEach(() => {
  tmp = tempDir('s1-scenario-')
})

afterEach(() => {
  pool.disposeAll()
  tmp.dispose()
})

describe('scenario: strategy S1 timed exit', () => {
  it('decides entry at T_settle − entryOffset and commands the reduce-only exit at T_settle + exitOffset', () => {
    const h = build()
    const events: EngineEvent[] = []
    h.bus.subscribe((e) => events.push(e))

    // Record the clock instant each order is placed at.
    const placements: Array<{ req: OrderRequest; ts: number }> = []
    const rawPlace = h.exchange.placeOrder.bind(h.exchange)
    h.exchange.placeOrder = (req: OrderRequest): Promise<OrderAck> => {
      placements.push({ req, ts: h.clock.now() })
      return rawPlace(req)
    }

    driveToEntry(h)
    driveToDeadline(h)

    // Entry timer fired at T_settle − entryOffsetSeconds.
    const entryTimer = events.find((e): e is Timer => e.type === 'Timer' && e.kind === 'entry')
    expect(entryTimer?.ts).toBe(ENTRY_TS)
    expect(ENTRY_TS).toBe(SETTLE_TS - h.strategyConfig.entryOffsetSeconds * 1000)

    // Entry BUY placed at ENTRY_TS; reduce-only exit commanded at T_settle + exitOffsetSeconds.
    const entry = placements.find((p) => p.req.clientOrderId.includes('-entry-'))
    const exit = placements.find((p) => p.req.clientOrderId.includes('-exit-'))
    expect(entry?.ts).toBe(ENTRY_TS)
    expect(exit?.req.reduceOnly).toBe(true)
    expect(exit?.req.side).toBe('short')
    expect(exit?.ts).toBe(DEADLINE_TS)
    expect(DEADLINE_TS).toBe(SETTLE_TS + h.strategyConfig.exitOffsetSeconds * 1000)

    // Closed with exit_reason = timed; position accrued funding (entry filled pre-settlement).
    expect(h.engine.intentState(INTENT_ID)).toBe('CLOSED')
    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'timed' })
    expect(h.engine.fundingReceived(INTENT_ID)).toBe(true)
  })

  it('late fill (released after T_settle) records funding_received = false', () => {
    const h = build()
    const { clock, exchange, scheduler } = h

    exchange.setPrice(BTC.symbol, BTC.price)
    exchange.setPredictedFunding(BTC.symbol, BTC.predicted, SCAN_TS)
    scheduler.start()
    clock.advanceTo(SCAN_TS)

    // Hold the entry FILL past its PositionUpdate; only a later emit releases it.
    exchange.reorderNextOrderUpdate(2)
    clock.advanceTo(ENTRY_TS)
    expect(h.engine.intentState(INTENT_ID)).toBe('SUBMITTING_ENTRY') // fill withheld

    // Release the held fill with a post-settlement tick → enteredAtMs > T_settle.
    clock.advanceTo(SETTLE_TS + 1_000)
    exchange.setPrice(BTC.symbol, BTC.price)
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')
    expect(h.engine.fundingReceived(INTENT_ID)).toBe(false)

    // The WAL MONITORING record carries the same verdict.
    const monitoring = h.wal.readAll().find((r) => r.intentId === INTENT_ID && r.toState === 'MONITORING')
    expect((monitoring?.payload as { fundingReceived?: boolean } | undefined)?.fundingReceived).toBe(false)

    driveToDeadline(h)
    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'timed' })
  })

  it('entry reject → ENTRY_FAILED{main_order_rejected}', () => {
    const h = build()
    const { bus, clock, exchange, scheduler } = h

    // Reject the entry leg at the venue: publish a REJECTED OrderUpdate instead of filling.
    const rawPlace = exchange.placeOrder.bind(exchange)
    exchange.placeOrder = (req: OrderRequest): Promise<OrderAck> => {
      if (req.clientOrderId.includes('-entry-')) {
        bus.publish({ type: 'OrderUpdate', clientOrderId: req.clientOrderId, status: 'REJECTED', reason: 'margin' })
        return Promise.resolve({ clientOrderId: req.clientOrderId, accepted: false })
      }
      return rawPlace(req)
    }

    exchange.setPrice(BTC.symbol, BTC.price)
    exchange.setPredictedFunding(BTC.symbol, BTC.predicted, SCAN_TS)
    scheduler.start()
    clock.advanceTo(SCAN_TS)
    clock.advanceTo(ENTRY_TS)

    expect(h.engine.intentState(INTENT_ID)).toBe('ENTRY_FAILED')
    const failed = h.wal.readAll().find((r) => r.intentId === INTENT_ID && r.toState === 'ENTRY_FAILED')
    expect((failed?.payload as { errorCode?: string } | undefined)?.errorCode).toBe('main_order_rejected')
  })
})
