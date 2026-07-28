/**
 * Live-tier suite registry (task 0470 phase 4).
 *
 * One entry per suite, each an ordered list of checks run serially by the testnet tier's
 * `runChecks` (reused unchanged — the runner is already venue- and tier-neutral). Unlike the
 * testnet tier there is **no per-venue registry**: the live checks speak only the
 * `ExchangeAdapter` port and the venue-native cancel sweep, both uniform across the five, so
 * five copies of one list would be duplication, not a boundary. The per-venue difference lives
 * in `./context.ts`'s builders.
 *
 * Order is load-bearing: preflight first (a failed one skips the rest without placing an
 * order), `assert-flat` last (the account always ends flat, whichever earlier check blew up).
 */

import type { Check } from '../testnet/types.js'
import type { LiveSuite } from './caps.js'
import { assertFlatCheck } from './checks/assert-flat.js'
import { capRejectionCheck } from './checks/cap-rejection.js'
import { fillEntryCheck } from './checks/fill-entry.js'
import { fundingSettlementCheck } from './checks/funding-settlement.js'
import { fundingWindowCheck } from './checks/funding-window.js'
import { orderLifecycleCheck } from './checks/order-lifecycle.js'
import { positionTrackingCheck } from './checks/position-tracking.js'
import { preflightCheck } from './checks/preflight.js'
import { reduceOnlyCloseCheck } from './checks/reduce-only-close.js'
import type { LiveContext } from './context.js'

/** A live check: one `17` §3-style bullet against a real venue. */
export type LiveCheck = Check<LiveContext>

/**
 * `self-test` — the harness proving itself: right account, an order that opens and cancels, a
 * cap that refuses an over-sized order before it reaches the venue, and a verified-flat exit.
 * No fill is intended, so it risks fees only if the venue crosses the resting order.
 *
 * `fill-test` — the first suite that intends to trade: a marketable limit that really fills, the
 * position it produces seen by the engine's own tracker, and a reduce-only close that really
 * closes. It costs a round trip of taker fees (cents, bounded by `LIVE_SUITE_FEE_BOUND_USD`) and
 * carries market risk for the seconds between entry and close, bounded by the 25 USD cap.
 *
 * `funding-test` — `fill-test` wrapped around a real settlement. `funding-window` runs *first*
 * and does the expensive thinking: it targets the next 1 h boundary, scans that venue's
 * short-interval symbols for negative predicted funding, and releases the entry only ~90 s
 * before `T_settle`. So the position exists for seconds-to-minutes rather than a whole funding
 * interval, and the five venues can be run **concurrently against the same boundary**. Both
 * funding witnesses (private stream and REST income) must then agree before the close.
 */
export const LIVE_SUITE_CHECKS: Readonly<Record<LiveSuite, readonly LiveCheck[]>> = {
  'self-test': [preflightCheck, orderLifecycleCheck, capRejectionCheck, assertFlatCheck],
  'fill-test': [preflightCheck, fillEntryCheck, positionTrackingCheck, reduceOnlyCloseCheck, assertFlatCheck],
  'funding-test': [
    preflightCheck,
    fundingWindowCheck,
    fillEntryCheck,
    positionTrackingCheck,
    fundingSettlementCheck,
    reduceOnlyCloseCheck,
    assertFlatCheck,
  ],
}
