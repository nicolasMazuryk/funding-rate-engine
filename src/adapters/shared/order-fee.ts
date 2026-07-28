/**
 * Realized-fee top-up for the venues whose order read carries no commission (task 0470 §6).
 *
 * Two of the five report a filled order with **no fee at all** — Binance (`fapi/v1/order`) and
 * KuCoin (`/api/v1/orders`) — while the money truth sits on their fills endpoint. Both then need
 * the same three lines: read the executions of that order, keep the ones that really belong to
 * it, sum the magnitudes. Shared here so the two adapters cannot drift on what "the fee of an
 * order" means; the *when* (which order, which weight, which client) stays per venue.
 *
 * Magnitudes, not signs: the port's `Order.fee` is a positive cost on every venue (`15` §2),
 * and a venue that signs a charge negative would otherwise credit the engine for trading.
 */

/** The slice of a ccxt trade this needs — `order` is the venue order id it belongs to. */
export interface FeeBearingTrade {
  readonly order?: string | undefined
  readonly fee?: { readonly cost?: number | null | undefined } | null | undefined
}

/**
 * Total fee across `trades` belonging to `venueOrderId`, or `undefined` when none of them
 * carries one — an absent fee must stay absent rather than become a confident `0`, since
 * reconciliation reads `0` as "the venue says this fill was free".
 *
 * The order-id filter is applied again here even though the venue was asked to filter: it is a
 * query parameter on both venues, not a guarantee, and a fee summed across the wrong orders is
 * worse than no fee at all.
 */
export function sumTradeFees(trades: readonly FeeBearingTrade[], venueOrderId: string): number | undefined {
  let total: number | undefined
  for (const trade of trades) {
    if (String(trade.order ?? '') !== venueOrderId) continue
    const cost = trade.fee?.cost
    if (cost === undefined || cost === null || !Number.isFinite(cost)) continue
    total = (total ?? 0) + Math.abs(cost)
  }
  return total
}
