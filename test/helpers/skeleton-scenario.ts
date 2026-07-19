/**
 * The one scripted scenario shared by the golden, crash-recovery, engine-unit,
 * and Postgres integration tests (task 0090/0130). Keeping it in one place means
 * every tier drives the *same* deterministic path through the finder's three
 * guards: BTC triggers, ETH does not.
 *
 * The scan runs at `07:58:00` because the sim instruments settle on an 8 h
 * interval (`00:00 / 08:00 / 16:00`); only a scan whose next top-of-hour is a
 * settlement (here `08:00`) clears the imminence guard. Predicted funding is
 * observed *at* the scan so it clears freshness (`< 60 s` old), and BTC's rate
 * (`-0.35`) sits inside the proximity band around the `-0.3` threshold while
 * ETH's (`+0.01`) does not.
 *
 * Timeline (virtual clock, `startMs = 07:00:00`):
 *   07:58:00 scan → 07:58:30 entry (settle − 90 s) → 08:03:30 deadline (entry + 5 min).
 */

import { DEFAULT_RUNTIME_CONFIG, type SkeletonHarness } from './build-skeleton-engine.js'

const HOUR_MS = 3_600_000

/** 07:00:00 UTC, epoch ms — one hour before the scan, so the scheduler fires exactly one scan. */
export const START_MS = 7 * HOUR_MS
/** 07:58:00 UTC — the `HH:58` scan boundary the scheduler derives from `START_MS`. */
export const SCAN_TS = START_MS + 58 * 60_000
/** 08:00:00 UTC — the next 8 h settlement, imminent at the scan. */
export const SETTLE_TS = 8 * HOUR_MS
/** Entry timer instant: `T_settle − entryOffsetSeconds`. */
export const ENTRY_TS = SETTLE_TS - DEFAULT_RUNTIME_CONFIG.entryOffsetSeconds * 1000
/** Deadline instant: entry fill (`ENTRY_TS`) + hold. */
export const DEADLINE_TS = ENTRY_TS + DEFAULT_RUNTIME_CONFIG.holdMs

export const BTC = { symbol: 'BTC', price: 60_000, predicted: -0.35 } as const
export const ETH = { symbol: 'ETH', price: 3_000, predicted: 0.01 } as const

/** The triggered intent's id under the scenario constants (`BTC-<entryTs>`). */
export const INTENT_ID = `${BTC.symbol}-${ENTRY_TS}`

/**
 * Script prices + predicted funding (observed at the scan, so fresh), then advance
 * scan → entry. Under the sim venue the entry fills synchronously, so on return the
 * intent has reached `MONITORING` with the deadline timer scheduled.
 */
export function driveToEntry(h: SkeletonHarness): void {
  const { clock, exchange, scheduler } = h

  exchange.setPrice(BTC.symbol, BTC.price)
  exchange.setPrice(ETH.symbol, ETH.price)
  exchange.setPredictedFunding(BTC.symbol, BTC.predicted, SCAN_TS)
  exchange.setPredictedFunding(ETH.symbol, ETH.predicted, SCAN_TS)

  scheduler.start()
  clock.advanceTo(SCAN_TS) // scan → schedules the BTC entry timer
  clock.advanceTo(ENTRY_TS) // entry → SUBMITTING_ENTRY → fill → MONITORING → schedules deadline
}

/** Advance to the deadline: `MONITORING → EXITING → reduce-only fill → CLOSED`. */
export function driveToDeadline(h: SkeletonHarness): void {
  h.clock.advanceTo(DEADLINE_TS)
}

/**
 * Full skeleton path: scan → entry → deadline. Under the sim venue every order
 * fills synchronously, so by the time this returns the intent has reached `CLOSED`
 * and both trace files are fully written.
 */
export function runSkeletonScenario(h: SkeletonHarness): void {
  driveToEntry(h)
  driveToDeadline(h)
}
