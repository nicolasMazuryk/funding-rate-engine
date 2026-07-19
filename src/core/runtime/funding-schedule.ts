/**
 * Funding schedule — pure core (`12_strategy_runtime_and_intent_lifecycle.md` §1;
 * `00_globals.md` §7, §8.1).
 *
 * Funding settlements land on UTC-epoch instants that are multiples of a symbol's
 * `fundingIntervalHours` (1 / 2 / 4 / 8 h). There is no predicted-funding-schedule
 * feed (that is 0210), and none is needed: the next settlement for any symbol is a
 * pure function of `now` + its interval, both already on the {@link Instrument}
 * (`10` §4). So the finder's caller builds the schedule each scan from the loaded
 * instruments rather than a new event/port.
 */

import type { Instrument } from '../ports/exchange-adapter.js'

const HOUR_MS = 3_600_000

/** One symbol's next funding settlement (`T_settle`, epoch ms UTC). */
export interface FundingScheduleEntry {
  readonly symbol: string
  readonly fundingIntervalHours: number
  /** Next `T_settle ≥ nowMs`, epoch ms UTC. */
  readonly settleTs: number
}

/**
 * The first funding-settlement instant `≥ nowMs` for a symbol on an
 * `intervalHours` schedule — the next UTC-epoch multiple of `intervalHours × 1h`.
 * Used both to build the schedule and, with `intervalHours = 1`, as the finder's
 * "next top of the hour" imminence reference.
 */
export function nextSettleTs(nowMs: number, intervalHours: number): number {
  const period = intervalHours * HOUR_MS
  return Math.ceil(nowMs / period) * period
}

/** Build the per-symbol funding schedule from the loaded instruments at `nowMs`. */
export function computeFundingSchedule(
  instruments: readonly Instrument[],
  nowMs: number,
): ReadonlyMap<string, FundingScheduleEntry> {
  const schedule = new Map<string, FundingScheduleEntry>()
  for (const instrument of instruments) {
    schedule.set(instrument.normalized, {
      symbol: instrument.normalized,
      fundingIntervalHours: instrument.fundingIntervalHours,
      settleTs: nextSettleTs(nowMs, instrument.fundingIntervalHours),
    })
  }
  return schedule
}
