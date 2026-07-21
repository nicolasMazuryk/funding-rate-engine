/**
 * Strategy 2 — Negative-Funding LONG, trailing-retracement exit (`03_strategy_2.md`)
 * — pure core. Selection is identical to S1/S1-WS (`selectGroupL`, shared §G-L rule —
 * the strategies differ only in their exit policy), so it reuses the helper rather than
 * copying it.
 *
 * The exit is the `sl_tp_deadline_retracement_funding_event` policy: on entry fill a
 * resting SL stop-market is placed; the funding gate arms a retracement tracker that
 * trails the running low with a re-derived TP limit, bounded by that SL and a deadline.
 * All exit mechanics live in that handler (`exit-policies/retracement.ts`); the module
 * encodes only selection.
 */

import { selectGroupL } from './group-l-selection.js'
import type { StrategyModule } from './registry.js'

/** Build the S2 module: id `s2`, trailing-retracement exit, most-negative-funding selection (`03` §1). */
export function createStrategy2(): StrategyModule {
  return {
    id: 's2',
    exitPolicyKind: 'sl_tp_deadline_retracement_funding_event',
    // §G-L most-negative rule, shared verbatim with S1/S1-WS (`group-l-selection.ts`).
    select: selectGroupL,
  }
}
