/**
 * Strategy 3a — Negative-Funding SHORT, ride the drop (`04_strategy_3a.md`) — pure core. The
 * first SHORT strategy: it pays the funding fee as a short and bets the post-settlement drop
 * exceeds it plus fees. SHORT is expressed via `entrySide` on the runtime config (wired in
 * `composition.ts`), not the selector — §G-S selection is the *same family* as §G-L
 * (`ratePercent ≤ thresholdPercent`), so it reuses `selectGroupL` verbatim (`04` §1).
 *
 * The exit is the reusable `sl_tp_deadline` policy: a static OCO pair (SL stop-market above
 * entry, TP limit below entry) plus a deadline market close. The lifecycle lives in that handler
 * (`exit-policies/sl-tp-deadline.ts`); the module supplies only selection and the S3a price
 * geometry — the deliberate asymmetry the task preserves (`04` §6):
 *   - SL is a **fixed percent** (`stopLossPercent`): `P_entry × (1 + stopLossPercent/100)`;
 *   - TP is **funding-scaled**: `P_entry × (1 − |F| × tpVariantAMultiplier/100)`, where `|F|` is
 *     the *realized predicted rate* the intent entered on (`ratePercent`), not the selection
 *     threshold — a threshold proxy would sit the TP too shallow to cover the funding cost (`04` §3).
 */

import type { SlTpDeadlineGeometry } from '../intent/exit-policies/sl-tp-deadline.js'
import { selectGroupL } from './group-l-selection.js'
import type { StrategyModule } from './registry.js'

/**
 * S3a's OCO price geometry (`04` §3). Both callbacks fail loud on a missing config key / entry
 * fill — a misconfigured S3a is a startup bug, not a silent skip.
 */
export const strategy3aGeometry: SlTpDeadlineGeometry = {
  slPrice(intent, config): number {
    if (intent.entryFillPx === undefined) {
      throw new Error(`STRATEGY_3A: intent '${intent.intentId}' has no entryFillPx for the SL`)
    }
    if (config.stopLossPercent === undefined) {
      throw new Error(`STRATEGY_3A: intent '${intent.intentId}' config has no stopLossPercent`)
    }
    // Fixed-percent SL above the short's entry (`04` §5): NOT a multiple of `|F|`.
    return intent.entryFillPx * (1 + config.stopLossPercent / 100)
  },
  tpPrice(intent, config): number {
    if (intent.entryFillPx === undefined) {
      throw new Error(`STRATEGY_3A: intent '${intent.intentId}' has no entryFillPx for the TP`)
    }
    if (config.tpVariantAMultiplier === undefined) {
      throw new Error(`STRATEGY_3A: intent '${intent.intentId}' config has no tpVariantAMultiplier`)
    }
    // Funding-scaled TP below the short's entry (`04` §3): `|F|` is the realized predicted rate
    // (`ratePercent`), falling back to the selection threshold only if it was never threaded.
    const magnitude = Math.abs(intent.ratePercent ?? config.thresholdPercent)
    return intent.entryFillPx * (1 - (magnitude * config.tpVariantAMultiplier) / 100)
  },
}

/** Build the S3a module: id `s3a`, `sl_tp_deadline` exit, most-negative-funding selection (`04` §1). */
export function createStrategy3a(): StrategyModule {
  return {
    id: 's3a',
    exitPolicyKind: 'sl_tp_deadline',
    // §G-S selection is the same family as §G-L, shared verbatim (`group-l-selection.ts`).
    select: selectGroupL,
  }
}
