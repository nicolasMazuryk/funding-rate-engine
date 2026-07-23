/**
 * Strategy 6 — Post-Funding Directional, WS-Gated Entry (`07_strategy_6.md`) — pure core. The
 * last and most complex strategy: it bets on the directional move *after* settlement in whichever
 * direction `mainSide` says, for whichever funding-sign regime `fundingThresholdPercent` selects
 * (all four sign/direction combinations are legal; the proposed config is LONG on funding ≥ +0.1).
 *
 * Two things make S6 unlike every prior strategy:
 *   - **Entry is a sub-machine** ({@link ./entry-submachines/strategy-6-entry.ts}): a tiny
 *     opposite-direction PRE_FUNDING order subscribes the private WS, the WS `funding_fee` event
 *     fires a MAIN reversal once under a lock, and a REST net-qty confirm precedes MONITORING.
 *     The engine delegates the whole `SUBMITTING_ENTRY` phase via the `entrySubMachine` marker.
 *   - **`entrySide = mainSide`** (the managed net direction), so the reused `sl_tp_deadline` OCO
 *     exit (kind `sl_tp_deadline_post_funding_event`) reduce-only-closes at `exitSide = opposite`.
 *     Its TP/SL are computed at MAIN fill from the **settled** `|F|` (`settledRatePercent`), not
 *     the decision-time predicted rate — the geometry below.
 *
 * Selection ({@link selectSignedAny}) is signed-any, independent of `mainSide`: a positive
 * threshold selects funding ≥ threshold, a negative one funding ≤ threshold, and `0` is always-on.
 */

import type { SlTpDeadlineGeometry } from '../intent/exit-policies/sl-tp-deadline.js'
import type { MonitoredIntent } from '../intent/exit-policy.js'
import type { Candidate } from '../runtime/finder.js'
import type { Strategy6EntryDeps } from './entry-submachines/strategy-6-entry.js'
import { createStrategy6EntrySubMachine } from './entry-submachines/strategy-6-entry.js'
import type { RuntimeStrategyConfig, StrategyModule, StrategyTrigger } from './registry.js'

/**
 * S6 signed-any selection (`07` §1): the threshold sign picks the funding regime, independent of
 * `mainSide`. `threshold > 0` ⇒ trigger on `F ≥ threshold`; `threshold < 0` ⇒ `F ≤ threshold`;
 * `threshold == 0` ⇒ always-on (band-limited in practice by the finder's proximity filter). The
 * three strategy-agnostic guards already ran in the finder.
 */
export function selectSignedAny(candidate: Candidate, config: RuntimeStrategyConfig): StrategyTrigger | undefined {
  const threshold = config.thresholdPercent
  const selected =
    threshold > 0 ? candidate.ratePercent >= threshold : threshold < 0 ? candidate.ratePercent <= threshold : true
  return selected ? { symbol: candidate.symbol, settleTs: candidate.settleTs } : undefined
}

/** `|F|` for the OCO geometry: the settled rate at MAIN fill, falling back to predicted then threshold. */
function magnitude(intent: MonitoredIntent, config: RuntimeStrategyConfig): number {
  return Math.abs(intent.settledRatePercent ?? intent.ratePercent ?? config.thresholdPercent)
}

/**
 * S6's OCO price geometry (`07` §2 step 4), computed at MAIN fill from the **settled** `|F|`. The
 * legs are reduce-only against the managed net position, so their direction mirrors `mainSide`:
 *   - LONG main (`entrySide === 'long'`): TP **above** entry, SL **below** — `P × (1 ± |F| × mult/100)`;
 *   - SHORT main: TP **below** entry, SL **above** (mirror).
 * Both callbacks fail loud on a missing config key / entry fill — a misconfigured S6 is a startup bug.
 */
export const strategy6Geometry: SlTpDeadlineGeometry = {
  slPrice(intent, config): number {
    if (intent.entryFillPx === undefined) {
      throw new Error(`STRATEGY_6: intent '${intent.intentId}' has no entryFillPx for the SL`)
    }
    if (config.slMultiplier === undefined) {
      throw new Error(`STRATEGY_6: intent '${intent.intentId}' config has no slMultiplier`)
    }
    const distance = (magnitude(intent, config) * config.slMultiplier) / 100
    // SL sits on the losing side of the net position: below a long, above a short.
    return intent.entrySide === 'long' ? intent.entryFillPx * (1 - distance) : intent.entryFillPx * (1 + distance)
  },
  tpPrice(intent, config): number {
    if (intent.entryFillPx === undefined) {
      throw new Error(`STRATEGY_6: intent '${intent.intentId}' has no entryFillPx for the TP`)
    }
    if (config.tpMultiplier === undefined) {
      throw new Error(`STRATEGY_6: intent '${intent.intentId}' config has no tpMultiplier`)
    }
    const distance = (magnitude(intent, config) * config.tpMultiplier) / 100
    // TP sits on the winning side: above a long, below a short.
    return intent.entrySide === 'long' ? intent.entryFillPx * (1 + distance) : intent.entryFillPx * (1 - distance)
  },
}

/**
 * Build the S6 module: id `s6`, `sl_tp_deadline_post_funding_event` exit, signed-any selection, and
 * the entry sub-machine wired with the injected gate ports (clock + REST funding-income poll). The
 * factory is captured so each engine instantiates its own gate + per-intent state.
 */
export function createStrategy6(gate: Strategy6EntryDeps): StrategyModule {
  return {
    id: 's6',
    exitPolicyKind: 'sl_tp_deadline_post_funding_event',
    select: selectSignedAny,
    entrySubMachine: () => createStrategy6EntrySubMachine(gate),
  }
}
