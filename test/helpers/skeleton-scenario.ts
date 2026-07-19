/**
 * The one scripted scenario shared by the golden, crash-recovery, engine-unit,
 * and Postgres integration tests (task 0090). Keeping it in one place means every
 * tier drives the *same* deterministic path: BTC triggers (predicted funding
 * `-0.5` ≤ threshold `-0.3`), ETH does not (`+0.01`), proving the finder filter.
 *
 * Timeline (virtual clock, `startMs = 0` — before the `00:58:00` scan boundary):
 *   00:58:00 scan → 00:59:30 entry (scan + 90 s) → 01:04:30 deadline (entry + 5 min).
 */

import type { SkeletonHarness } from './build-skeleton-engine.js'

export const SCAN_TS = 58 * 60_000 // 00:58:00 UTC, epoch ms (startMs = 0)

export const BTC = { symbol: 'BTC', price: 60_000, predicted: -0.5 } as const
export const ETH = { symbol: 'ETH', price: 3_000, predicted: 0.01 } as const

/** The triggered intent's id under the scenario constants (`BTC-<entryTs>`). */
export function triggeredIntentId(h: SkeletonHarness): string {
  return `${BTC.symbol}-${SCAN_TS + h.strategy.config.entryOffsetMs}`
}

/**
 * Script prices + predicted funding, then advance scan → entry → deadline. Under
 * the sim venue every order fills synchronously, so by the time this returns the
 * intent has reached `CLOSED` and both trace files are fully written.
 */
export function runSkeletonScenario(h: SkeletonHarness): void {
  const { clock, exchange, scheduler, strategy } = h

  exchange.setPrice(BTC.symbol, BTC.price)
  exchange.setPrice(ETH.symbol, ETH.price)
  exchange.setPredictedFunding(BTC.symbol, BTC.predicted)
  exchange.setPredictedFunding(ETH.symbol, ETH.predicted)

  scheduler.start()
  clock.advanceTo(SCAN_TS) // scan → schedules the BTC entry timer

  const entryTs = SCAN_TS + strategy.config.entryOffsetMs
  clock.advanceTo(entryTs) // entry → SUBMITTING_ENTRY → fill → MONITORING → schedules deadline

  const deadlineTs = entryTs + strategy.config.holdMs
  clock.advanceTo(deadlineTs) // deadline → EXITING → reduce-only fill → CLOSED
}
