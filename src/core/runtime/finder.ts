/**
 * Opportunity finder — pure core (`12_strategy_runtime_and_intent_lifecycle.md` §2;
 * `00_globals.md` §7). The strategy-agnostic first half of the `HH:58` scan: it
 * applies three engine-level guards to the cached predicted-funding readings, then
 * ranks the survivors by extremity. Strategy-specific selection (the threshold
 * rule) is applied afterwards by the `StrategyModule` the engine dispatches to.
 *
 * The three guards (`12` §2):
 *   1. proximity  — `|rate − threshold| ≤ 0.1` pp: only rates near the threshold band.
 *   2. freshness  — `now − observed < 60_000` ms: a stale predicted reading is ignored.
 *   3. imminence  — the symbol settles at the very next top-of-hour: a `k`-hour-interval
 *                   symbol is in-scope for one scan in `k`, never scheduled hours out.
 *
 * Pure: all wall-clock and venue data arrive as arguments (`nowMs`, the universe,
 * the predicted map, the schedule); no `Date.now`, no I/O.
 */

import type { FundingPredicted } from '../events/types.js'
import { type FundingScheduleEntry, nextSettleTs } from './funding-schedule.js'

/** Proximity band half-width, percentage points (`00_globals.md` §7). */
const PROXIMITY_PP = 0.1
/** A predicted reading older than this (ms) is stale and ignored. */
const FRESHNESS_MS = 60_000

/** Direction-tagged selection threshold (signed percent) the guards/ordering use. */
export interface ThresholdConfig {
  readonly percent: number
  readonly direction: 'negative' | 'positive'
}

/** Everything the pure finder needs for one scan — caller-supplied, no I/O. */
export interface FindCandidatesInput {
  /** Symbols in scope this scan (trading markets). */
  readonly universe: readonly string[]
  /** Latest predicted-funding reading per symbol. */
  readonly predicted: ReadonlyMap<string, FundingPredicted>
  /** Next settlement per symbol (`computeFundingSchedule`). */
  readonly schedule: ReadonlyMap<string, FundingScheduleEntry>
  readonly threshold: ThresholdConfig
  /** Scan instant, epoch ms UTC. */
  readonly nowMs: number
}

/** A guarded candidate: the symbol, its predicted rate, the settlement it targets, and when it was observed. */
export interface Candidate {
  readonly symbol: string
  /** Predicted funding rate, signed percent. */
  readonly ratePercent: number
  /** `T_settle` the candidate would enter against, epoch ms UTC. */
  readonly settleTs: number
  /** Observation time of the predicted reading, epoch ms UTC. */
  readonly observedTs: number
}

/**
 * Apply the three guards, then rank by extremity descending (most-extreme first)
 * with a `symbol` tie-break — a total, deterministic order independent of the
 * universe's iteration order (the golden trace depends on it).
 */
export function findCandidates(input: FindCandidatesInput): readonly Candidate[] {
  const { universe, predicted, schedule, threshold, nowMs } = input
  const topOfHour = nextSettleTs(nowMs, 1)

  const candidates: Candidate[] = []
  for (const symbol of universe) {
    const reading = predicted.get(symbol)
    if (reading === undefined) continue
    if (Math.abs(reading.rate - threshold.percent) > PROXIMITY_PP) continue // proximity
    if (nowMs - reading.ts >= FRESHNESS_MS) continue // freshness
    const entry = schedule.get(symbol)
    if (entry === undefined || entry.settleTs !== topOfHour) continue // imminence
    candidates.push({ symbol, ratePercent: reading.rate, settleTs: entry.settleTs, observedTs: reading.ts })
  }

  candidates.sort((a, b) => extremity(b, threshold) - extremity(a, threshold) || compareSymbol(a.symbol, b.symbol))
  return candidates
}

/** How far past the threshold a rate is, in the strategy's direction (larger = more extreme). */
function extremity(candidate: Candidate, threshold: ThresholdConfig): number {
  return threshold.direction === 'negative'
    ? threshold.percent - candidate.ratePercent
    : candidate.ratePercent - threshold.percent
}

function compareSymbol(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
