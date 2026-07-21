/**
 * Strategy 1 — Negative-Funding LONG, timed exit (`01_strategy_1.md`) — pure core.
 *
 * The first real strategy and the template for 0300–0350. A pure `StrategyModule`:
 * given a guarded {@link Candidate} it applies its own §G-L threshold rule and
 * nothing else — the three strategy-agnostic guards (proximity / freshness /
 * imminence) already ran in the finder, and all order mechanics (sizing, entry,
 * the `timed` exit) live in the engine + the `timed` handler.
 *
 * Selection (`01` §1): trigger when `F_predicted ≤ negativeFundingThresholdPercent`
 * (signed percent, so `-0.55 ≤ -0.4` triggers, `-0.39` does not). The effective
 * threshold is read from the runtime config passed at scan time, not baked in — the
 * engine owns the value; the module encodes only the most-negative-first direction.
 */

import type { StrategyModule } from './registry.js'

/** Build the S1 module: id `s1`, `timed` exit, most-negative-funding selection (`01` §1). */
export function createStrategy1(): StrategyModule {
  return {
    id: 's1',
    exitPolicyKind: 'timed',
    select(candidate, config) {
      // §G-L most-negative rule: a rate at or below the (negative) threshold triggers.
      return candidate.ratePercent <= config.thresholdPercent
        ? { symbol: candidate.symbol, settleTs: candidate.settleTs }
        : undefined
    },
  }
}
