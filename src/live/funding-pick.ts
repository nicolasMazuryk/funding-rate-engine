/**
 * Live-tier **funding-symbol selection** (task 0470 phase 7).
 *
 * `funding-test` wants the opposite of what `./symbol-pick.ts` wants. That picker asks "what is
 * the cheapest thing I can legally trade" — right for a suite that only needs *an* order. This
 * one asks "what will actually pay me at the next settlement", which is a different question
 * with three different answers:
 *
 *  - **short interval.** A 1 h symbol settles within the hour; the 8 h default would hold a real
 *    position for most of a working day to observe one event. The interval is on the validated
 *    `Instrument`, so this costs nothing to filter on.
 *  - **negative predicted funding.** The suite holds a long, so a negative rate is a *credit*
 *    (`00_globals.md` §1.1/§3.1) — the sign the harness can then assert against the venue's own
 *    settled rate. The threshold is deliberately near zero
 *    ({@link LIVE_FUNDING_RATE_THRESHOLD_PERCENT}): this tier is verifying that funding *arrives*
 *    and *is signed correctly*, not harvesting it, so a wide net beats a profitable one.
 *  - **notional near the cap, not at the venue minimum.** Funding is a fraction of notional, and
 *    a 5 USD position at −0.01 % credits 0.5 **micro**-dollars — a number a venue may round to
 *    zero and the check would then read as "never funded". Sizing at
 *    {@link LIVE_FUNDING_TARGET_NOTIONAL_USD} keeps the credit comfortably above venue rounding
 *    while staying under the compiled-in per-order ceiling with headroom for a price move
 *    between the pick and the submit.
 *
 * Pure, like its sibling: the caller does the venue reads and hands in prices and rates.
 */

import type { Instrument, OrderRequest } from '../core/ports/exchange-adapter.js'
import { computeQty, minFeasibleQty } from '../core/sizing/sizing.js'
import type { LiveCaps } from './caps.js'
import { orderNotionalUsd } from './notional.js'
import type { PickedSymbol } from './symbol-pick.js'

/**
 * The cadence the suite prefers, hours — the shortest grid any of the five publishes, and where
 * the extreme-funding alts live. It is a *preference*, not a rule: the boundary is chosen on the
 * venue's own shortest cadence (`checks/funding-window.ts`), because **OKX lists no 1 h symbols
 * at all** and a 1 h-only rule targets an hour where nothing on that venue settles.
 */
export const LIVE_FUNDING_INTERVAL_HOURS = 1

/**
 * How negative a predicted rate must be to qualify, signed percent (`00_globals.md` §1.2). At
 * −0.01 % (1 bp) almost any symbol drifting negative qualifies, which is the point: the run is
 * verifying the *plumbing*, and a strict threshold would just make the suite unrunnable on a
 * calm hour. Strategy selection thresholds are a different number in a different file.
 */
export const LIVE_FUNDING_RATE_THRESHOLD_PERCENT = -0.01

/**
 * Target notional for the held position, USD — under the 25 USD per-order cap with headroom for
 * the price to move between the pick and the submit. See the file header for why the venue
 * minimum is the wrong size here.
 */
export const LIVE_FUNDING_TARGET_NOTIONAL_USD = 20

/** One priced candidate plus the rate that makes it a candidate at all. */
export interface FundingCandidate {
  readonly instrument: Instrument
  /** The price the caller intends to submit at (band-anchored, tick-rounded), quote currency. */
  readonly price: number
  /** Predicted funding for the coming settlement, signed percent. */
  readonly ratePercent: number
}

export interface PickedFundingSymbol extends PickedSymbol {
  readonly ratePercent: number
  /** What the position should be credited at settlement, USD (positive = the long receives). */
  readonly expectedFundingUsd: number
}

/** A candidate priced and sized, kept with its verdict for the throw message. */
interface Priced extends PickedFundingSymbol {
  readonly fits: boolean
}

/**
 * Size for {@link LIVE_FUNDING_TARGET_NOTIONAL_USD}, but never below what the venue will accept:
 * a lot-floored target under the minimum is raised to `minFeasibleQty`, which may itself exceed
 * the cap — that is what `fits` then reports.
 */
function sizeFor(candidate: FundingCandidate, caps: LiveCaps): Priced {
  const { instrument, price, ratePercent } = candidate
  const target = Math.min(LIVE_FUNDING_TARGET_NOTIONAL_USD, caps.maxOrderNotionalUsd)
  const qty = Math.max(computeQty(target, price, instrument), minFeasibleQty(price, instrument))
  const req: OrderRequest = {
    symbol: instrument.normalized,
    side: 'long',
    type: 'limit',
    qty,
    price,
    clientOrderId: 'funding-pick',
  }
  const notionalUsd = orderNotionalUsd(req, instrument)
  return {
    symbol: instrument.normalized,
    venueSymbol: instrument.venueSymbol,
    instrument,
    price,
    qty,
    minOrderUsd: Math.max(instrument.minNotional, instrument.minQty * price * instrument.contractSize),
    notionalUsd,
    ratePercent,
    // A long is paid `-rate` of its notional (`00_globals.md` §1.1) — positive for a negative rate.
    expectedFundingUsd: (notionalUsd * -ratePercent) / 100,
    fits: notionalUsd <= caps.maxOrderNotionalUsd,
  }
}

/**
 * The most-negative qualifying symbol that fits the per-order cap.
 *
 * Ranked on the rate rather than on cost — the biggest credit is the one least likely to vanish
 * into venue rounding — with the normalized symbol as a deterministic tie-break. Candidacy is
 * decided on {@link orderNotionalUsd}, the same conservative estimate the cap wrapper applies at
 * submit, so a picked symbol cannot be refused by the cap it was picked under.
 *
 * Throws, naming what was scanned and the best rate seen, when nothing qualifies. There is no
 * fallback to a positive rate or a longer interval: a run that holds a position it cannot reason
 * about is worse than a run that refuses to start.
 */
export function pickFundingSymbol(
  candidates: readonly FundingCandidate[],
  caps: LiveCaps,
  thresholdPercent: number = LIVE_FUNDING_RATE_THRESHOLD_PERCENT,
): PickedFundingSymbol {
  const priced = candidates.filter((c) => c.ratePercent <= thresholdPercent).map((c) => sizeFor(c, caps))
  const chosen = priced
    .filter((p) => p.fits)
    .sort((a, b) => a.ratePercent - b.ratePercent || a.symbol.localeCompare(b.symbol))[0]

  if (chosen === undefined) {
    const best = candidates.reduce<number | undefined>(
      (acc, c) => (acc === undefined || c.ratePercent < acc ? c.ratePercent : acc),
      undefined,
    )
    const overCap = priced.map((p) => `${p.symbol} (${p.notionalUsd.toFixed(2)} USD)`).join(', ')
    throw new Error(
      '[live] no symbol qualifies for funding-test: scanned ' +
        `${candidates.length}, needed a predicted rate <= ${thresholdPercent}% fitting the ` +
        `${caps.maxOrderNotionalUsd} USD per-order cap; best rate seen ` +
        `${best === undefined ? 'none' : `${best}%`}` +
        `${overCap.length > 0 ? `, qualifying but over cap: ${overCap}` : ''}`,
    )
  }
  const { fits: _fits, ...pick } = chosen
  return pick
}
