/**
 * Shared symbol selection for every order-placing live check (task 0470 phase 6).
 *
 * Lifted out of `order-lifecycle` once a second suite needed it: `fill-test` places its own
 * order without ever resting one, so the pick — and the per-instrument account setup that has
 * to precede any submit — cannot live inside the `self-test` check that happens to run first.
 *
 * Memoized on the run state: one symbol per run, whichever check asks first, so `cap-rejection`
 * and `reduce-only-close` operate on the same instrument the entry used.
 *
 * The price is **per suite**, because the suites want opposite sides of the market:
 * `self-test` rests below last and must not fill, `fill-test`/`funding-test` cross above it and
 * must. Both are priced *here*, before {@link pickCheapestSymbol}, so the picker's cap estimate
 * is made against the exact number that will be submitted — see the tick-rounding note below.
 */

import type { Instrument } from '../../core/ports/exchange-adapter.js'
import { roundPrice } from '../../core/sizing/sizing.js'
import type { LiveSuite } from '../caps.js'
import type { LiveContext } from '../context.js'
import { LIVE_SYMBOL_CANDIDATES, type PickedSymbol, pickCheapestSymbol, type SymbolCandidate } from '../symbol-pick.js'

/**
 * Where each suite prices its order, as a multiple of last.
 *
 * `0.97` is inside every venue's price-limit band (OKX `51006`, Bybit and Bitget equivalents)
 * yet three percent away from a fill for the seconds a `self-test` order lives — a hard-coded
 * far-from-market price is rejected as out of range on three of the five venues.
 *
 * `1.005` is the mirror image: a buy half a percent *through* the ask is marketable on every
 * venue's book at these sizes, so it fills at once (paying the taker fee `fill-test` measures)
 * while staying inside the same band. `fill-test` picks blue-chip perps, where half a percent is
 * many times the spread.
 *
 * `funding-test` crosses far deeper, and **escalates**: it does not get to choose a liquid
 * symbol — it trades whatever pays the most negative funding, and those are thin alt perps whose
 * spread can swallow 0.5 % whole (observed live: OKX's `BEAT` rested unfilled and the run lost
 * its settlement, 0470 §7). The trade being verified is worth far more than the spread it pays,
 * so each attempt re-reads last and crosses harder than the one before.
 *
 * A deeper limit is not automatically a worse price — a marketable order fills at the *book's*
 * price, not at its own — so the extra depth costs nothing unless the book really is that thin,
 * and when it is, paying it is the correct trade. The ladder stops at 5 %: past that a venue's
 * price-limit band rejects the order outright (OKX `51006` and its equivalents), which would
 * turn a slow fill into no fill at all.
 */
const SUITE_ENTRY_FACTORS: Readonly<Record<LiveSuite, readonly number[]>> = {
  'self-test': [0.97],
  'fill-test': [1.005],
  'funding-test': [1.02, 1.05],
}

/**
 * The escalating cross ladder for this suite — one entry per submit attempt, each a multiple of
 * the last price read at that moment.
 *
 * Two attempts is the ceiling for `funding-test`, and the ceiling is the **cap**, not caution: a
 * cancelled order's reservation is never released (`notional-cap.ts` only releases on
 * reduce-only), so at the 20 USD target a third attempt would cross the 50 USD total-exposure
 * ceiling and be refused by the wrapper.
 */
export function suiteEntryFactors(suite: LiveSuite): readonly number[] {
  return SUITE_ENTRY_FACTORS[suite]
}

/**
 * Leverage for the picked symbol, set before any submit exactly as the engine's instrument
 * setup does. `1` is the conservative choice for a capped live order — the position is fully
 * margined, so neither a resting order nor a held position carries liquidation risk.
 *
 * Not optional: on **KuCoin** isolated leverage is an *order parameter* (no endpoint exists),
 * so `setLeverage` only records it and a submit with nothing recorded goes out without the
 * field — the venue answers `Leverage parameter invalid.` (observed live, 0470 §5).
 */
const LIVE_LEVERAGE = 1

/**
 * Price the shortlist against this venue: keep the candidates that exist here and trade, read
 * each one's last price, and hand the picker the price the order would actually be submitted at.
 */
async function priceCandidates(ctx: LiveContext, factor: number): Promise<readonly SymbolCandidate[]> {
  const tradable = new Set(
    ctx.adapter
      .markets()
      .filter((m) => m.status === 'trading')
      .map((m) => m.normalized),
  )
  const candidates: SymbolCandidate[] = []
  for (const symbol of LIVE_SYMBOL_CANDIDATES) {
    if (!tradable.has(symbol)) continue
    const last = await ctx.lastPrice(symbol)
    const instrument = ctx.adapter.normalize(symbol)
    // Round to the venue tick here, not at submit: `pickCheapestSymbol` prices the candidate
    // at exactly the number that will be sent, and an unrounded band price is rejected
    // outright ("Precision is over the maximum defined for this asset.", observed live 0470 §5
    // — earlier runs only passed because `last * 0.97` happened to land on the tick).
    candidates.push({ instrument, price: roundPrice(last * factor, instrument) })
  }
  return candidates
}

/**
 * The symbol this run trades, picking it (and doing its account setup) on first use.
 *
 * Account setup runs in the engine's order (`11` §1). Isolated first: KuCoin states
 * `marginMode` on every submit and rejects it against a symbol the account still holds in
 * cross (`330005`, observed live) — the venues that switch account-wide treat a matching mode
 * as a no-op.
 */
export async function ensurePickedSymbol(ctx: LiveContext): Promise<PickedSymbol> {
  const existing = ctx.state.symbol
  if (existing !== undefined) return existing

  const candidates = await priceCandidates(ctx, suiteEntryFactors(ctx.suite)[0] as number)
  return adoptPickedSymbol(ctx, pickCheapestSymbol(candidates, ctx.caps))
}

/**
 * Adopt a symbol picked by some other rule — `funding-test` chooses on funding rate rather than
 * on price (`../funding-pick.ts`) — and run the same per-instrument account setup. Split out so
 * a suite-specific picker cannot accidentally skip the setup by writing `state.symbol` directly.
 */
export async function adoptPickedSymbol<T extends PickedSymbol>(ctx: LiveContext, pick: T): Promise<T> {
  await ctx.adapter.setMarginMode(pick.symbol, 'isolated')
  await ctx.adapter.setLeverage(pick.symbol, LIVE_LEVERAGE)
  ctx.state.symbol = pick
  return pick
}

/**
 * The price this suite submits at for `instrument` on attempt `attempt` (0-based), band-anchored
 * off `last` and tick-rounded. The tick rounding is not cosmetic: an unrounded band price is
 * rejected outright ("Precision is over the maximum defined for this asset.", observed live).
 */
export function suitePrice(ctx: LiveContext, instrument: Instrument, last: number, attempt = 0): number {
  const factors = suiteEntryFactors(ctx.suite)
  const factor = (factors[Math.min(attempt, factors.length - 1)] ?? factors[0]) as number
  return roundPrice(last * factor, instrument)
}
