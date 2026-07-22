/**
 * Strategy 4.2a — Post-Funding LONG Single Limit (`06_strategy_4_2a.md`) — pure core. The S4.1a
 * ladder collapsed to **one** resting BUY-LIMIT rung: one fill, one `P_entry`, no averaging (`06`
 * §2). It is a post-funding LONG recovery strategy — usually receives no funding (the limit is meant
 * to fill *after* `T_settle`), its edge is delta recovery on the post-settlement drop.
 *
 * Selection is §G-R — the same most-negative threshold as S4.1a — so it reuses `selectGroupL`
 * verbatim. LONG is the default side (no `entrySide`).
 *
 * It rides the ladder entry path (`entryPlan`) exactly as S4.1a does: `rungPrices` returns a single
 * price, and the engine's ladder machinery handles placement, the conditional stop armed at
 * placement, the deadline, and the per-fill TP unchanged. Two things distinguish it from S4.1a:
 *   - {@link strategy4_2aLimitPlan} — a **single** BUY-LIMIT at `0.75×|F|` below `P_ref` (`06` §2);
 *   - `entryExpiryErrorCode: 'limit_expired'` — the normative no-fill terminal (`06` §2 R5): the
 *     lone limit carries `expireAt`, and a zero-fill expiry terminates `NO_POSITION{limit_expired}`
 *     (a shallow-drop event that never dips to `P_limit` is a cost of zero, not a defect).
 *
 * `|F|` is the realized predicted rate the intent entered on (`ratePercent`), falling back to the
 * selection threshold only if it was never threaded — identical to S4.1a.
 */

import { selectGroupL } from './group-l-selection.js'
import type { LadderEntryPlan, RuntimeStrategyConfig, StrategyModule } from './registry.js'
import { strategy4_1aLadderPlan } from './strategy-4-1a.js'

/** `|F|` for the limit math: the realized predicted rate (`ratePercent`), else the threshold (`06` §2). */
function magnitude(config: RuntimeStrategyConfig, ratePercent?: number): number {
  return Math.abs(ratePercent ?? config.thresholdPercent)
}

/**
 * S4.2a single-limit geometry (`06` §2). `rungPrices` returns a one-element ladder — the lone
 * BUY-LIMIT at `P_ref × (1 − |F| × limitOffsetMult/100)`; `slTriggerPrice` anchors the engine-side
 * SL below it. For a single rung the engine's `P_avg_full` equals `P_limit`, so the SL geometry is
 * S4.1a's verbatim (`06` §3 SL row): reuse it, then assert the loader-guaranteed `P_SL < P_limit`.
 */
export const strategy4_2aLimitPlan: LadderEntryPlan = {
  rungPrices(refPrice, config, ratePercent): number[] {
    if (config.limitOffsetMult === undefined) {
      throw new Error('STRATEGY_4_2A: config has no limitOffsetMult for the single limit')
    }
    const absF = magnitude(config, ratePercent)
    return [refPrice * (1 - (absF * config.limitOffsetMult) / 100)]
  },
  slTriggerPrice(pLimit, config, ratePercent): number {
    // Single rung: `P_avg_full === P_limit`, so the SL trigger is S4.1a's `P_limit × (1 − |F| ×
    // slMultiplier/100)` (`06` §2 / §3 SL row) — reuse it to stay DRY.
    const pSl = strategy4_1aLadderPlan.slTriggerPrice(pLimit, config, ratePercent)
    // Defensive invariant (`06` §2): the loader enforces `slMultiplier > limitOffsetMult`, so the
    // stop sits below the entry limit. Assert the geometric consequence — a violation is a config bug.
    if (!(pSl < pLimit)) {
      throw new Error(`STRATEGY_4_2A: P_SL (${pSl}) must be < P_limit (${pLimit}) — check slMultiplier`)
    }
    return pSl
  },
}

/**
 * Build the S4.2a module: id `s4-2a`, `sl_tp_deadline` exit, §G-R (= §G-L) selection, single-limit
 * entry, and the `limit_expired` no-fill terminal seam (`06` §2 R5) — the entry limit carries
 * `expireAt` and a zero-fill expiry terminates with this code instead of `ladder_no_fills`.
 */
export function createStrategy4_2a(): StrategyModule {
  return {
    id: 's4-2a',
    exitPolicyKind: 'sl_tp_deadline',
    // §G-R selection is the same family as §G-L, shared verbatim (`group-l-selection.ts`).
    select: selectGroupL,
    entryPlan: strategy4_2aLimitPlan,
    entryExpiryErrorCode: 'limit_expired',
  }
}
