/**
 * Strategy 4.1a — Post-Funding LONG Ladder (`05_strategy_4_1a.md`) — pure core. The first ladder
 * strategy: it pre-places N BUY-LIMIT rungs below the pre-event price, scaled by `|F|`, to be
 * filled *by* the post-settlement drop, and exits on a TP above the fill-weighted average `P_avg`.
 *
 * Selection is §G-R — the same most-negative threshold as §G-L/§G-S (`05` §1), so it reuses
 * `selectGroupL` verbatim (S3a does the same). LONG is the default side (no `entrySide`).
 *
 * The exit kind is the shared `sl_tp_deadline`, but wired through the **ladder** handler
 * (`createLadderSlTpDeadlineHandler`): the SL is an engine-side conditional stop armed at
 * placement (not a resting leg), and the TP is re-placed on every rung fill. This module supplies
 * two pure pieces:
 *   - {@link strategy4_1aLadderPlan} — the rung ladder + engine-side SL anchor geometry (`05` §2);
 *   - {@link strategy4_1aTpGeometry} — the per-fill TP limit (`05` §3), consumed by the handler.
 *
 * All price math scales off `|F|` = the realized predicted rate the intent entered on
 * (`ratePercent`), falling back to the selection threshold only if it was never threaded (`05` §2).
 */

import type { LadderTpGeometry } from '../intent/exit-policies/sl-tp-deadline.js'
import { selectGroupL } from './group-l-selection.js'
import type { LadderEntryPlan, RuntimeStrategyConfig, StrategyModule } from './registry.js'

/** `|F|` for the ladder math: the realized predicted rate (`ratePercent`), else the threshold (`05` §2). */
function magnitude(config: RuntimeStrategyConfig, ratePercent?: number): number {
  return Math.abs(ratePercent ?? config.thresholdPercent)
}

/**
 * S4.1a ladder geometry (`05` §2). `rungPrices` builds the linear ladder of BUY-LIMIT prices
 * between `ladder_top` (i=0, most favorable) and `ladder_bottom` (i=ladderCount−1);
 * `slTriggerPrice` anchors the engine-side SL to the precomputed `P_avg_full`. Both fail loud on
 * a missing config key — a misconfigured S4.1a is a startup bug, not a silent skip.
 */
export const strategy4_1aLadderPlan: LadderEntryPlan = {
  rungPrices(refPrice, config, ratePercent): number[] {
    if (config.ladderCount === undefined) {
      throw new Error('STRATEGY_4_1A: config has no ladderCount for the ladder')
    }
    if (config.ladderTopMult === undefined || config.ladderBottomMult === undefined) {
      throw new Error('STRATEGY_4_1A: config has no ladderTopMult/ladderBottomMult for the ladder')
    }
    const absF = magnitude(config, ratePercent)
    const ladderTop = refPrice * (1 - (absF * config.ladderTopMult) / 100)
    const ladderBottom = refPrice * (1 - (absF * config.ladderBottomMult) / 100)
    const count = config.ladderCount
    if (count === 1) return [ladderTop] // degenerate 1-rung ladder (0340 S4.2a); no interpolation span.
    const span = (ladderTop - ladderBottom) / (count - 1)
    return Array.from({ length: count }, (_, i) => ladderTop - i * span)
  },
  slTriggerPrice(pAvgFull, config, ratePercent): number {
    if (config.slMultiplier === undefined) {
      throw new Error('STRATEGY_4_1A: config has no slMultiplier for the conditional stop')
    }
    // Engine-side SL below the fill-weighted average (`05` §2 step 1 / §3 SL row).
    return pAvgFull * (1 - (magnitude(config, ratePercent) * config.slMultiplier) / 100)
  },
}

/** S4.1a TP geometry (`05` §3): a reduce-only SELL LIMIT above the running `P_avg`, re-placed per fill. */
export const strategy4_1aTpGeometry: LadderTpGeometry = {
  tpPrice(pAvg, config): number {
    if (config.takeProfitPct === undefined) {
      throw new Error('STRATEGY_4_1A: config has no takeProfitPct for the TP')
    }
    return pAvg * (1 + config.takeProfitPct / 100)
  },
}

/** Build the S4.1a module: id `s4-1a`, `sl_tp_deadline` exit, §G-R (= §G-L) selection, ladder entry. */
export function createStrategy4_1a(): StrategyModule {
  return {
    id: 's4-1a',
    exitPolicyKind: 'sl_tp_deadline',
    // §G-R selection is the same family as §G-L, shared verbatim (`group-l-selection.ts`).
    select: selectGroupL,
    entryPlan: strategy4_1aLadderPlan,
  }
}
