/**
 * Opportunity finder — pure core (`12_strategy_runtime_and_intent_lifecycle.md` §2,
 * minimal for the walking skeleton, task 0090).
 *
 * A pure filter+sort over the cached predicted-funding readings: keep the symbols
 * the strategy selects, ordered most-negative-first with a `symbol` tie-break so
 * the scan is byte-deterministic (the golden trace depends on this order). The
 * full guard/finder with liquidity/spread/OI filters lands in task 0130.
 */

import type { FundingPredicted } from '../events/types.js'
import type { StubStrategy } from '../strategies/stub.js'

/** A selected symbol and the predicted rate (signed percent) that selected it. */
export interface Candidate {
  readonly symbol: string
  readonly rate: number
}

/**
 * Select and rank candidates from the predicted-funding readings. Ordering:
 * ascending `rate` (most-negative first), then ascending `symbol` — a total,
 * deterministic order independent of iteration order of the input.
 */
export function findCandidates(predicted: Iterable<FundingPredicted>, strategy: StubStrategy): readonly Candidate[] {
  const candidates: Candidate[] = []
  for (const reading of predicted) {
    if (strategy.selects(reading.rate)) candidates.push({ symbol: reading.symbol, rate: reading.rate })
  }
  candidates.sort((a, b) => a.rate - b.rate || compareSymbol(a.symbol, b.symbol))
  return candidates
}

function compareSymbol(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
