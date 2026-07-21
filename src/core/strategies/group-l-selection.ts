/**
 * Shared §G-L selection rule (`00_globals.md` §G-L; `01`/`02` §1) — pure core. The
 * most-negative-first threshold test both S1 (timed) and S1-WS (funding-fee-event)
 * apply verbatim: the two strategies differ only in their exit policy, never in
 * selection. Extracted so the WS variant *shares* this helper rather than copying it
 * (task 0300 mandate: "share the helper, don't copy").
 *
 * Rule: trigger when `F_predicted ≤ thresholdPercent` (both signed percent, so
 * `-0.55 ≤ -0.4` triggers, `-0.39` does not). The three strategy-agnostic guards
 * (proximity / freshness / imminence) already ran in the finder.
 */

import type { Candidate } from '../runtime/finder.js'
import type { RuntimeStrategyConfig, StrategyTrigger } from './registry.js'

/** Apply the §G-L most-negative rule to a guarded candidate; `undefined` declines. */
export function selectGroupL(candidate: Candidate, config: RuntimeStrategyConfig): StrategyTrigger | undefined {
  return candidate.ratePercent <= config.thresholdPercent
    ? { symbol: candidate.symbol, settleTs: candidate.settleTs }
    : undefined
}
