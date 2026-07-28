/**
 * Order-notional estimation for the live cap (task 0470).
 *
 * Deliberately **fail-closed**: `contractSize` semantics differ across the five venues
 * (SUGGESTIONS `[high]` — the prefix-fold on binance/bybit/bitget), so rather than pick
 * one interpretation we take the **larger** of the two candidate readings, and any input
 * we cannot price at all yields `Infinity`. Overestimating notional can only ever reject
 * an order that was in fact under the cap; underestimating would let real money past it.
 */

import type { Instrument, OrderRequest } from '../core/ports/exchange-adapter.js'

/** A usable positive, finite number — anything else cannot be priced. */
function usable(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

/**
 * Whether `req` carries a price the cap can bind against. A market order carries none, so
 * the wrapper refuses it unless it is reduce-only (a close is exempt — see `notional-cap.ts`).
 */
export function isPriceable(req: OrderRequest): boolean {
  return usable(req.price) && usable(req.qty)
}

/**
 * Estimated USD notional of `req`. `max(qty * price, qty * price * contractSize)` — the
 * conservative reading under the open `contractSize` ambiguity. Returns `Infinity` for an
 * unpriceable request or an unusable `contractSize`, which the caller must treat as
 * "over every cap".
 */
export function orderNotionalUsd(req: OrderRequest, instrument: Instrument): number {
  if (!isPriceable(req)) return Number.POSITIVE_INFINITY
  if (!usable(instrument.contractSize)) return Number.POSITIVE_INFINITY

  const base = req.qty * (req.price as number)
  return Math.max(base, base * instrument.contractSize)
}
