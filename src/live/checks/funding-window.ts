/**
 * `funding-window` — choose the symbol and the moment `funding-test` will trade (task 0470
 * phase 7). Runs *before* the entry, and its whole job is to make the entry cheap in the two
 * currencies this suite actually spends: **wall-clock** and **market exposure**.
 *
 * The naive shape — open a position, then wait for whatever settlement comes next — holds real
 * money on a real venue for up to a full funding interval, which on the 8 h default is most of a
 * working day per venue. This check inverts it:
 *
 *  1. target the next settlement boundary on **this venue's shortest cadence**, with enough lead
 *     to prepare — 1 h where the venue lists 1 h symbols, 4 h on OKX, which lists none;
 *  2. wait until `T_settle − SCAN_LEAD` and *then* scan, so the predicted rates read are the ones
 *     that will actually settle rather than an hour-stale snapshot;
 *  3. pick on funding rate (`../funding-pick.ts`), not on price;
 *  4. wait until `T_settle − ENTRY_LEAD` and hand off.
 *
 * The position therefore exists for ~90 seconds before settlement instead of hours, which is all
 * a venue needs — funding is charged on the position held at the settlement instant — and the
 * five venues can be run **concurrently against the same boundary** rather than one at a time.
 *
 * The scan is the expensive part and is bounded by construction: only 1 h-interval symbols are
 * rate-read (a small fraction of any venue's universe), and only the few that clear the
 * threshold are then priced.
 */

import type { Instrument } from '../../core/ports/exchange-adapter.js'
import type { LiveContext } from '../context.js'
import {
  type FundingCandidate,
  LIVE_FUNDING_INTERVAL_HOURS,
  LIVE_FUNDING_RATE_THRESHOLD_PERCENT,
  pickFundingSymbol,
} from '../funding-pick.js'
import { waitUntil } from '../poll.js'
import type { LiveCheck } from '../registry.js'
import { requirePreflight } from './preflight.js'
import { adoptPickedSymbol, suitePrice } from './symbol.js'

const HOUR_MS = 3_600_000

/**
 * Least lead the check will accept for a boundary. Below this the scan and the entry would be
 * racing the settlement, so the *following* hour is targeted instead — costing an hour of
 * waiting rather than a position that may or may not have been held in time.
 */
const MIN_PREP_MS = 9 * 60_000

/** When the rate scan runs, before `T_settle`. Late enough to be predictive, early enough to finish. */
const SCAN_LEAD_MS = 6 * 60_000

/**
 * When the entry is released, before `T_settle` — the position's whole real-money lifetime.
 *
 * Three minutes, not ninety seconds: the entry may have to walk its escalating cross ladder
 * (`./symbol.ts`), and a rung that does not fill costs a poll budget plus a cancel. Missing the
 * settlement wastes the entire run and an hour of wall-clock, while the extra ninety seconds of
 * exposure on a 20 USD capped position is worth cents. Time is the scarce resource here, not money.
 */
const ENTRY_LEAD_MS = 180_000

/** How many qualifying symbols are priced. The pick only ever uses the most negative few. */
const PRICED_SHORTLIST = 6

/**
 * Ceiling on rate reads per run. The scan is ordered shortest-interval-first, so on a venue that
 * lists 1 h symbols the budget is never approached; it exists for the venue that does not
 * (**OKX lists none at all** — its live cadences are 4 h and 8 h) and whose eligible set is then
 * its whole universe. A truncated scan is logged, never silent.
 */
const MAX_SCAN_SYMBOLS = 120

/**
 * The shortest funding cadence this venue actually lists, hours.
 *
 * The boundary has to be chosen on **this venue's** grid, not on a global assumption. OKX lists
 * no 1 h symbols at all, so at 17:00 UTC — a 1 h boundary and nothing else — *nothing* on that
 * venue settles, and a run targeting it finds an empty universe (observed live, 0470 §7: the
 * first pass happened to target 16:00, which is also 4 h- and 8 h-aligned, and looked fine).
 * Taking the venue's own minimum makes the target structurally non-empty everywhere.
 */
function shortestIntervalHours(ctx: LiveContext): number {
  const hours = ctx.adapter
    .markets()
    .filter((m) => m.status === 'trading')
    .map((m) => ctx.adapter.normalize(m.normalized).fundingIntervalHours)
  if (hours.length === 0) throw new Error(`[live] ${ctx.venue} lists no tradable instruments`)
  return Math.min(...hours)
}

/** The next UTC-aligned boundary of `intervalHours` strictly after `nowMs`. */
export function nextBoundaryMs(nowMs: number, intervalHours: number): number {
  const intervalMs = intervalHours * HOUR_MS
  return Math.floor(nowMs / intervalMs) * intervalMs + intervalMs
}

/**
 * Every tradable instrument that settles **at `settleTs`**, shortest cadence first.
 *
 * A symbol's grid contains the boundary exactly when its interval divides it — every venue
 * settles on the UTC-aligned grid of its own interval — so at 16:00 UTC the 1 h, 2 h, 4 h and 8 h
 * universes all settle together, while at 15:00 only the 1 h one does. Ordering by cadence keeps
 * the 1 h symbols at the front of the scan budget: they are the extreme-funding alts, the most
 * likely to qualify, and the cheapest to reach.
 *
 * The widening is not a nicety. **OKX lists no 1 h symbols at all**, so a 1 h-only rule would
 * make the suite permanently unrunnable on one of the five venues.
 */
function eligibleInstruments(ctx: LiveContext, settleTs: number): readonly Instrument[] {
  return ctx.adapter
    .markets()
    .filter((m) => m.status === 'trading')
    .map((m) => ctx.adapter.normalize(m.normalized))
    .filter((i) => settleTs % (i.fundingIntervalHours * HOUR_MS) === 0)
    .sort((a, b) => a.fundingIntervalHours - b.fundingIntervalHours || a.normalized.localeCompare(b.normalized))
}

/**
 * Read the predicted rate for every short-interval symbol, keep the ones paying a long, and
 * price the most negative handful. Two passes on purpose: a rate read is one lane token and
 * every symbol needs one, a price read is another and only a shortlist needs it.
 */
async function scanCandidates(
  ctx: LiveContext,
  settleTs: number,
): Promise<{
  readonly candidates: readonly FundingCandidate[]
  readonly scanned: number
  readonly qualifying: number
  readonly eligible: number
}> {
  const instruments = eligibleInstruments(ctx, settleTs)
  ctx.log('scanning symbols settling at this boundary for negative predicted funding', {
    eligible: instruments.length,
    oneHour: instruments.filter((i) => i.fundingIntervalHours === LIVE_FUNDING_INTERVAL_HOURS).length,
    budget: MAX_SCAN_SYMBOLS,
    thresholdPercent: LIVE_FUNDING_RATE_THRESHOLD_PERCENT,
  })

  const rated: Array<{ instrument: Instrument; ratePercent: number }> = []
  const qualified: typeof rated = []
  for (const instrument of instruments.slice(0, MAX_SCAN_SYMBOLS)) {
    try {
      const { rate } = await ctx.adapter.predictedFunding(instrument.normalized)
      if (!Number.isFinite(rate)) continue
      rated.push({ instrument, ratePercent: rate })
      if (rate <= LIVE_FUNDING_RATE_THRESHOLD_PERCENT) qualified.push({ instrument, ratePercent: rate })
      // Enough to choose from: the pick only ever prices a shortlist, so reading the rest of a
      // 600-symbol universe would spend the window to change nothing.
      if (qualified.length >= PRICED_SHORTLIST) break
    } catch (err) {
      // One unreadable symbol must not cost the run its window; the pick reports the shortfall.
      ctx.log('predicted-funding read failed, symbol skipped', {
        symbol: instrument.normalized,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (rated.length < instruments.length) {
    ctx.log('rate scan stopped early', { rated: rated.length, eligible: instruments.length })
  }

  const qualifying = qualified.sort(
    (a, b) => a.ratePercent - b.ratePercent || a.instrument.normalized.localeCompare(b.instrument.normalized),
  )

  const candidates: FundingCandidate[] = []
  for (const { instrument, ratePercent } of qualifying.slice(0, PRICED_SHORTLIST)) {
    try {
      const last = await ctx.lastPrice(instrument.normalized)
      candidates.push({ instrument, price: suitePrice(ctx, instrument, last), ratePercent })
    } catch (err) {
      ctx.log('last-price read failed, candidate skipped', {
        symbol: instrument.normalized,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { candidates, scanned: rated.length, qualifying: qualifying.length, eligible: instruments.length }
}

/**
 * Guard for every check that would otherwise trade on `funding-test` without a window. Without
 * it a failed scan is *worse* than a failed run: `fill-entry` would fall back to the ordinary
 * cheapest-symbol pick, open a position on an 8 h symbol, and `funding-settlement` would then
 * hold real money until that venue's next 8 h boundary. Returns the skip outcome, or `undefined`
 * when the run may proceed.
 */
export function requireFundingWindow(
  ctx: LiveContext,
): { readonly status: 'skip'; readonly reason: string } | undefined {
  if (ctx.suite !== 'funding-test' || ctx.state.settleTs !== undefined) return undefined
  return { status: 'skip', reason: 'funding-window did not pick a settlement — refusing to hold a live position' }
}

export const fundingWindowCheck: LiveCheck = {
  name: 'funding-window',
  specRef: '00_globals §1.1 T_settle / §3.1 funding sign',
  async run(ctx: LiveContext) {
    const skip = requirePreflight(ctx)
    if (skip !== undefined) return skip

    const cadenceHours = shortestIntervalHours(ctx)
    let settleTs = nextBoundaryMs(ctx.clock.now(), cadenceHours)
    if (settleTs - ctx.clock.now() < MIN_PREP_MS) {
      settleTs = nextBoundaryMs(settleTs, cadenceHours)
    }
    ctx.log('targeting a funding settlement', {
      settleTs,
      settleAt: new Date(settleTs).toISOString(),
      cadenceHours,
    })

    await waitUntil(ctx.clock, settleTs - SCAN_LEAD_MS, (remainingMs) =>
      ctx.log('waiting for the rate-scan window', { remainingMinutes: Math.ceil(remainingMs / 60_000) }),
    )
    const { candidates, scanned, qualifying, eligible } = await scanCandidates(ctx, settleTs)
    const pick = await adoptPickedSymbol(ctx, pickFundingSymbol(candidates, ctx.caps))
    ctx.state.settleTs = settleTs
    ctx.log('picked the symbol to hold across the settlement', {
      symbol: pick.symbol,
      ratePercent: pick.ratePercent,
      notionalUsd: pick.notionalUsd,
      expectedFundingUsd: pick.expectedFundingUsd,
    })

    // Held from here to `T_settle` and a little past it — the shortest exposure that still
    // guarantees the position is on the venue's books when it takes its funding snapshot.
    await waitUntil(ctx.clock, settleTs - ENTRY_LEAD_MS, (remainingMs) =>
      ctx.log('holding the entry until the settlement window', { remainingSeconds: Math.ceil(remainingMs / 1_000) }),
    )

    return {
      status: 'pass',
      detail: {
        settleTs,
        settleAt: new Date(settleTs).toISOString(),
        cadenceHours,
        entryLeadMs: ENTRY_LEAD_MS,
        eligibleSymbols: eligible,
        scannedSymbols: scanned,
        qualifyingSymbols: qualifying,
        symbol: pick.symbol,
        ratePercent: pick.ratePercent,
        qty: pick.qty,
        notionalUsd: pick.notionalUsd,
        expectedFundingUsd: pick.expectedFundingUsd,
      },
    }
  },
}
