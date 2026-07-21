/**
 * Strategy 1-WS — Negative-Funding LONG, funding-fee-event exit (`02_strategy_1_ws.md`)
 * — pure core. The first **WS-mandatory** strategy and the template for the event-gated
 * exits (S2/S6). A pure `StrategyModule`: selection is identical to S1 (`selectGroupL`,
 * shared §G-L rule — the two strategies differ only in their exit policy), so it declines
 * to copy the rule and reuses the helper.
 *
 * The behavioural difference is the exit: instead of S1's fixed-clock `timed` deadline,
 * S1-WS exits on **confirmed funding accrual** — the `funding_fee_event` policy owns a
 * funding gate that opens on the WS `funding_fee` event or a REST poll (`exit_reason =
 * funding_fee_event`), or times out (`funding_fee_timeout`). All exit mechanics live in
 * that handler; the module encodes only selection.
 */

import { selectGroupL } from './group-l-selection.js'
import type { StrategyModule } from './registry.js'

/** Build the S1-WS module: id `s1-ws`, `funding_fee_event` exit, most-negative-funding selection (`02` §1). */
export function createStrategy1Ws(): StrategyModule {
  return {
    id: 's1-ws',
    exitPolicyKind: 'funding_fee_event',
    // §G-L most-negative rule, shared verbatim with S1 (`group-l-selection.ts`).
    select: selectGroupL,
  }
}
