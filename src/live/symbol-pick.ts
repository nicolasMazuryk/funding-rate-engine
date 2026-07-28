/**
 * Live-tier **symbol selection** (task 0470 phase 4).
 *
 * The harness must place a real order that is as small as the venue permits and still under
 * the compiled-in cap (`./caps.ts`). Which symbol that is differs per venue — one venue's BTC
 * contract alone is worth ~90 USD (KuCoin `XBTUSDTM`) and another's BTC min-notional is 50 USDT
 * (Binance), both of which blow the 25 USD per-order ceiling. So the symbol is **picked, not
 * configured**: cheapest candidate that fits, deterministic tie-break, and a loud throw when
 * none fits rather than a silent fall back to something expensive.
 *
 * Pure. The caller reads the tickers and hands in the **price it will actually order at** —
 * not the last price — so the estimate here and the estimate the cap wrapper makes at submit
 * time are the same number.
 */

import type { Instrument, OrderRequest } from '../core/ports/exchange-adapter.js'
import { minFeasibleQty } from '../core/sizing/sizing.js'
import type { LiveCaps } from './caps.js'
import { orderNotionalUsd } from './notional.js'

/**
 * The symbols the live tier is willing to trade, most-likely-cheapest first. A shortlist, not
 * the venue universe: scanning ~400 markets would cost ~400 ticker reads per run, and the tier
 * only needs *a* liquid, tiny-notional perp — one that exists on all five venues, trades deep
 * enough that a marketable order fills (phase 6), and whose lot minimum is worth cents.
 *
 * Order within the list is irrelevant to the outcome ({@link pickCheapestSymbol} sorts by
 * measured cost); it is only the read order for the caller's ticker fetches.
 */
export const LIVE_SYMBOL_CANDIDATES: readonly string[] = [
  'DOGE',
  'TRX',
  'XRP',
  'ADA',
  'SUI',
  'LTC',
  'SOL',
  'ETH',
  'BTC',
]

/** One priced candidate: a validated instrument plus the price the order would rest at. */
export interface SymbolCandidate {
  readonly instrument: Instrument
  /** The price the caller intends to submit at (already band-anchored), quote currency. */
  readonly price: number
}

/** The chosen symbol, with the exact order the caller should submit. */
export interface PickedSymbol {
  readonly symbol: string
  readonly venueSymbol: string
  readonly instrument: Instrument
  readonly price: number
  /** Smallest qty that clears both the lot minimum and the min-notional floor. */
  readonly qty: number
  /** `max(minNotional, minQty · price · contractSize)` — what the venue's minimums cost, USD. */
  readonly minOrderUsd: number
  /** What the cap wrapper will estimate for this order, USD (the conservative reading). */
  readonly notionalUsd: number
}

/** What one candidate costs, and whether it fits — kept for the throw message. */
interface Priced extends PickedSymbol {
  readonly fits: boolean
}

/** The venue minimums' cost in USD (plan formula), independent of lot-step rounding. */
function minOrderUsdOf(instrument: Instrument, price: number): number {
  return Math.max(instrument.minNotional, instrument.minQty * price * instrument.contractSize)
}

function price(candidate: SymbolCandidate, caps: LiveCaps): Priced {
  const { instrument } = candidate
  const qty = minFeasibleQty(candidate.price, instrument)
  const req: OrderRequest = {
    symbol: instrument.normalized,
    side: 'long',
    type: 'limit',
    qty,
    price: candidate.price,
    clientOrderId: 'symbol-pick',
  }
  const notionalUsd = orderNotionalUsd(req, instrument)
  return {
    symbol: instrument.normalized,
    venueSymbol: instrument.venueSymbol,
    instrument,
    price: candidate.price,
    qty,
    minOrderUsd: minOrderUsdOf(instrument, candidate.price),
    notionalUsd,
    fits: notionalUsd <= caps.maxOrderNotionalUsd,
  }
}

/**
 * Cheapest candidate whose smallest feasible order is under the per-order cap.
 *
 * Ranked on `minOrderUsd` (what the venue's own minimums cost), ties broken on the normalized
 * symbol so repeated runs on unchanged market data pick the same symbol. Candidacy is decided
 * on {@link orderNotionalUsd}, the same conservative estimate the cap wrapper applies — a
 * picked symbol therefore cannot be refused by the cap it was picked under.
 *
 * Throws — loudly, naming every candidate and its cost — when nothing fits. There is no
 * fallback: placing a real order the caps were never sized for is the failure this tier exists
 * to prevent.
 */
export function pickCheapestSymbol(candidates: readonly SymbolCandidate[], caps: LiveCaps): PickedSymbol {
  const priced = candidates.map((c) => price(c, caps))
  const fitting = priced
    .filter((p) => p.fits)
    .sort((a, b) => a.minOrderUsd - b.minOrderUsd || a.symbol.localeCompare(b.symbol))

  const chosen = fitting[0]
  if (chosen === undefined) {
    const table = priced
      .map((p) => `${p.symbol} (min ${p.minOrderUsd.toFixed(2)} USD, order ${p.notionalUsd.toFixed(2)} USD)`)
      .join(', ')
    throw new Error(
      `[live] no candidate symbol fits the ${caps.maxOrderNotionalUsd} USD per-order cap: ` +
        `${table.length > 0 ? table : '(no priced candidates)'}`,
    )
  }
  const { fits: _fits, ...pick } = chosen
  return pick
}
