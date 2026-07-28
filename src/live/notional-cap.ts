/**
 * The live-tier notional cap (task 0470) — the one choke point real money must pass.
 *
 * Wraps the `ExchangeAdapter` **port object** rather than sitting in the order manager,
 * because every order path in this codebase is fire-and-forget through
 * `exchange.placeOrder`: `execution/engine.ts`, `risk/flatten.ts`, `orphan-handler.ts`.
 * A caller cannot route around the wrapper without holding the raw adapter, and the live
 * context never exposes one.
 *
 * A capped order is refused in the `order-manager.ts` `failSubmit` dialect — publish
 * `OrderUpdate{REJECTED, errorKind:'OrderRejected'}`, return `{accepted:false}` — so the
 * order FSM sees exactly what a venue reject looks like. It **never throws** (a throw from
 * a fire-and-forget `void placeOrder(...)` is an unhandled rejection) and it **never
 * touches the adapter** (the whole point: the order must not reach the venue).
 */

import type { EventBus } from '../core/ports/bus.js'
import type { Clock } from '../core/ports/clock.js'
import type { ExchangeAdapter, OrderAck, OrderRequest } from '../core/ports/exchange-adapter.js'
import type { LiveCaps } from './caps.js'
import { isPriceable, orderNotionalUsd } from './notional.js'

/** Why the cap refused an order. */
export type CapRejectionKind =
  | 'cap_unpriced_order'
  | 'cap_unknown_instrument'
  | 'cap_order_notional'
  | 'cap_total_notional'

/** One refusal, recorded for the run verdict. */
export interface CapRejection {
  readonly kind: CapRejectionKind
  readonly clientOrderId: string
  readonly symbol: string
  /** Estimated notional, USD; `Infinity` when the order could not be priced. */
  readonly notionalUsd: number
  readonly reason: string
  readonly ts: number
}

/** Read-only view of the cap's running state, for the verdict. */
export interface CapState {
  readonly caps: LiveCaps
  /** Cumulative reserved non-reduce-only notional, USD. */
  exposureUsd(): number
  /** Reserved notional by normalized symbol, USD. */
  exposureBySymbol(): ReadonlyMap<string, number>
  readonly rejections: readonly CapRejection[]
}

/** An adapter whose `placeOrder` is capped. The raw handle is not reachable from here. */
export interface CappedAdapter extends ExchangeAdapter {
  readonly cap: CapState
}

export interface NotionalCapDeps {
  readonly caps: LiveCaps
  readonly bus: EventBus
  readonly clock: Clock
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
}

export function withNotionalCap(adapter: ExchangeAdapter, deps: NotionalCapDeps): CappedAdapter {
  const { caps, bus, clock, log } = deps
  const reserved = new Map<string, number>()
  const rejections: CapRejection[] = []

  function exposureUsd(): number {
    let total = 0
    for (const v of reserved.values()) total += v
    return total
  }

  /** Refuse `req` in the `failSubmit` dialect. Never throws, never reaches the adapter. */
  function reject(req: OrderRequest, kind: CapRejectionKind, notionalUsd: number, reason: string): OrderAck {
    const rejection: CapRejection = {
      kind,
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      notionalUsd,
      reason,
      ts: clock.now(),
    }
    rejections.push(rejection)
    log?.('live cap refused an order', { ...rejection })
    bus.publish({
      type: 'OrderUpdate',
      clientOrderId: req.clientOrderId,
      status: 'REJECTED',
      errorKind: 'OrderRejected',
      reason,
    })
    return { clientOrderId: req.clientOrderId, accepted: false }
  }

  async function placeOrder(req: OrderRequest): Promise<OrderAck> {
    // ── everything below runs synchronously, before the first `await` ─────────
    // Two concurrent capped orders must not both see the pre-reservation exposure,
    // so the reservation is committed in the same synchronous turn as the check.

    // A reduce-only close is exempt: the harness must always be able to flatten what it
    // opened, whatever the position grew to. It also releases the symbol's reservation.
    if (req.reduceOnly === true) {
      reserved.delete(req.symbol)
      return adapter.placeOrder(req)
    }

    if (!isPriceable(req)) {
      return reject(
        req,
        'cap_unpriced_order',
        Number.POSITIVE_INFINITY,
        'live cap: order carries no usable price/qty, so its notional cannot be bounded',
      )
    }

    let notionalUsd: number
    try {
      notionalUsd = orderNotionalUsd(req, adapter.normalize(req.symbol))
    } catch (e) {
      return reject(
        req,
        'cap_unknown_instrument',
        Number.POSITIVE_INFINITY,
        `live cap: cannot normalize '${req.symbol}': ${(e as Error).message}`,
      )
    }

    if (notionalUsd > caps.maxOrderNotionalUsd) {
      return reject(
        req,
        'cap_order_notional',
        notionalUsd,
        `live cap: order notional ${notionalUsd.toFixed(2)} USD exceeds the ${caps.maxOrderNotionalUsd} USD per-order cap`,
      )
    }

    const total = exposureUsd() + notionalUsd
    if (total > caps.maxTotalNotionalUsd) {
      return reject(
        req,
        'cap_total_notional',
        notionalUsd,
        `live cap: total notional ${total.toFixed(2)} USD exceeds the ${caps.maxTotalNotionalUsd} USD exposure cap`,
      )
    }

    // Reserve before awaiting. Deliberately never released on a venue reject or a thrown
    // submit — a one-way ratchet is the conservative reading when we cannot know whether
    // the order reached the book. Only a reduce-only close releases it.
    reserved.set(req.symbol, (reserved.get(req.symbol) ?? 0) + notionalUsd)
    return adapter.placeOrder(req)
  }

  const cap: CapState = {
    caps,
    exposureUsd,
    exposureBySymbol: () => new Map(reserved),
    get rejections() {
      return rejections as readonly CapRejection[]
    },
  }

  return { ...adapter, placeOrder, cap }
}
