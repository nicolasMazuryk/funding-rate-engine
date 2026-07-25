/**
 * Bybit {@link OrderTransport} — the venue-specific write path behind the order manager
 * (`11_execution_and_account_state.md` §5), mirroring `../binance/ws-orders.ts`. WS
 * submit/cancel via the native `WebsocketAPIClient` (tiagosiebler `bybit-api@4.7.1`),
 * REST-fallback submit via `RestClientV5`, and order ground truth via the adapter's existing
 * ccxt `getOrder`. Denomination lives only here (the manager speaks base-unit core requests);
 * every throw is mapped through {@link mapBybitError} so the manager only ever sees an
 * {@link AdapterError}.
 *
 * WS timeout: the lib's submit/cancel promise **rejects on disconnect / WS-API error** but
 * has **no** per-request timeout, so we race it against a {@link Clock} timer that rejects
 * {@link WsTimeoutError} — the signal the manager turns into REST fallback (where the venue
 * profile enables it) or a bounded WS retry.
 *
 * `orderLinkId` is our `clientOrderId` and is set on every submit; the `clientOrderId →
 * venueSymbol` map is populated authoritatively at submit time (before the WS ack) so
 * `getOrder`/`cancel` can resolve the symbol Bybit requires even if the ack later times out.
 *
 * Bybit specifics:
 *  - every trade call carries `category: 'linear'` and `positionIdx: 0` (one-way, `11` §1);
 *  - a WS-API error **rejects with the raw reply object** (`{retCode, retMsg, …}`), not an
 *    `Error` — the code is hoisted onto `Error.code` locally (STATUS 0230's cross-venue trap);
 *  - `'stop'` has no native order type: it is a conditional market order (`triggerPrice` +
 *    `triggerDirection`, rise for a buy stop, fall for a sell stop).
 */

import type { CancelOrderParamsV5, OrderParamsV5, OrderResultV5 } from 'bybit-api'
import type { Clock } from '../../../core/ports/clock.js'
import type { Order, OrderAck, OrderRequest } from '../../../core/ports/exchange-adapter.js'
import type { OrderTransport } from '../../../execution/order-manager.js'
import { NotFoundError, WsTimeoutError } from '../../shared/errors.js'
import { mapBybitError } from './error-map.js'

/** Default WS ack timeout — the lib has no per-request timer, so we impose one (`10` §5 `WsTimeout`). */
const WS_ACK_TIMEOUT_MS = 5_000
/**
 * Order-lane weights (`10` §6). Bybit publishes **no weight model** — order create/cancel are
 * capped at 10/s per UID, which the profile's `rate_limit_weight_per_minute: 6000` + 10 %
 * order reserve expresses exactly (600/min = 10/s, see `config/exchanges.yaml`). So every
 * order-lane call costs 1 token: one token = one request.
 */
const WEIGHT_WS_ORDER = 1
const WEIGHT_WS_CANCEL = 1
const WEIGHT_REST_ORDER = 1

/** The slice of the native `WebsocketAPIClient` the transport calls. */
export interface BybitWsOrderClient {
  submitNewOrder(params: OrderParamsV5): Promise<{ retCode: number; data: OrderResultV5 }>
  cancelOrder(params: CancelOrderParamsV5): Promise<{ retCode: number; data: OrderResultV5 }>
}

/** The slice of the native `RestClientV5` the REST-fallback submit calls. */
export interface BybitRestOrderClient {
  submitOrder(params: OrderParamsV5): Promise<{ retCode: number; result: OrderResultV5 }>
}

export interface BybitOrderTransportDeps {
  readonly wsApi: BybitWsOrderClient
  readonly rest: BybitRestOrderClient
  readonly clock: Clock
  /** Normalized symbol → exact venue string (adapter registry read). */
  readonly resolveVenue: (symbol: string) => string
  /** Persist `clientOrderId → venueSymbol` at submit so `getOrder`/`cancel` can resolve the symbol. */
  readonly recordVenue: (clientOrderId: string, venueSymbol: string) => void
  /** Look up the venue symbol for a known `clientOrderId`; throws `NotFound` if unseen. */
  readonly venueForClientId: (clientOrderId: string) => string
  /**
   * Reuse the adapter's ccxt `getOrder` (symbol resolved from the same map). Already
   * lane-wrapped + error-mapped by the adapter (`callGeneral`), so the transport does not
   * re-wrap it — that would double-charge the limiter.
   */
  readonly getOrder: (clientOrderId: string) => Promise<Order>
  /** Order-lane limiter + error-map wrapper (adapter `callOrder`, mirrors `callGeneral`). */
  readonly callOrder: <T>(weight: number, fn: () => Promise<T>) => Promise<T>
  /** Override the WS ack timeout (tests); defaults to {@link WS_ACK_TIMEOUT_MS}. */
  readonly wsAckTimeoutMs?: number
  /** Structured-log callback for an unmapped venue error code (mirrors `adapter.ts`). */
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void
}

/**
 * The WS-API client rejects with the raw reply payload (`{ wsKey, retCode, retMsg, op, … }`),
 * not an `Error`, so `err.message` would read `[object Object]` and any `instanceof` check
 * fails. Lift it to a real `Error` carrying `retMsg` as the message and `retCode` on `.code`
 * so {@link mapBybitError} classifies e.g. `110007` as `InsufficientBalance` rather than an
 * unknown `NetworkError` (which would be wrongly retried). Anything else (our
 * {@link WsTimeoutError}, a real socket `Error`) passes through untouched.
 */
function liftWsApiError(err: unknown): unknown {
  if (err !== null && typeof err === 'object' && !(err instanceof Error) && 'retCode' in err) {
    const { retCode, retMsg } = err as { retCode: unknown; retMsg?: unknown }
    const lifted = new Error(typeof retMsg === 'string' ? retMsg : 'bybit ws-api error')
    ;(lifted as { code?: unknown }).code = retCode
    return lifted
  }
  return err
}

/** `long/short` → Bybit `Buy/Sell`. */
function venueSide(side: OrderRequest['side']): 'Buy' | 'Sell' {
  return side === 'long' ? 'Buy' : 'Sell'
}

/**
 * Build the Bybit order payload; prices/qty are strings at the API boundary, `GTC` for
 * priced limit orders, `positionIdx: 0` for one-way mode (`11` §1).
 *
 * A `'stop'` request becomes a **conditional market order**: `triggerPrice = req.price`, with
 * `triggerDirection` 1 (rise) for a buy stop and 2 (fall) for a sell stop — Bybit has no
 * `Stop` order type of its own.
 */
function toOrderParams(req: OrderRequest, venue: string): OrderParamsV5 {
  const base = {
    category: 'linear' as const,
    symbol: venue,
    side: venueSide(req.side),
    qty: String(req.qty),
    orderLinkId: req.clientOrderId,
    positionIdx: 0 as const,
    ...(req.reduceOnly ? { reduceOnly: true } : {}),
  }
  if (req.type === 'stop') {
    return {
      ...base,
      orderType: 'Market',
      ...(req.price !== undefined
        ? { triggerPrice: String(req.price), triggerDirection: req.side === 'long' ? (1 as const) : (2 as const) }
        : {}),
    }
  }
  if (req.type === 'limit') {
    return {
      ...base,
      orderType: 'Limit',
      ...(req.price !== undefined ? { price: String(req.price), timeInForce: 'GTC' as const } : {}),
    }
  }
  return { ...base, orderType: 'Market' }
}

export function createBybitOrderTransport(deps: BybitOrderTransportDeps): OrderTransport {
  const { wsApi, rest, clock, resolveVenue, recordVenue, venueForClientId, getOrder, callOrder } = deps
  const ackTimeoutMs = deps.wsAckTimeoutMs ?? WS_ACK_TIMEOUT_MS
  const log = deps.log ?? (() => {})

  /** Map a venue throw, logging an unmapped code (mirrors `adapter.ts`'s `mapErr`). */
  function mapErr(err: unknown): ReturnType<typeof mapBybitError> {
    return mapBybitError(err, { onUnknown: (rawCode) => log('bybit: unmapped venue error code', { rawCode }) })
  }

  /** Race a WS promise against a Clock timer that rejects `WsTimeoutError` (the lib has none). */
  function withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = clock.scheduleTimer(clock.now() + ackTimeoutMs, () =>
        reject(new WsTimeoutError('bybit ws order ack timeout')),
      )
      p.then(
        (value) => {
          timer.cancel()
          resolve(value)
        },
        (err) => {
          timer.cancel()
          reject(err)
        },
      )
    })
  }

  /**
   * WS/REST result → ack. A resolved submit means the venue accepted it (a non-zero `retCode`
   * rejects: the WS client rejects the deferred promise, and the REST client is constructed
   * with `throwExceptions: true` in `factory.ts`).
   */
  function toAck(clientOrderId: string, orderId: string | undefined): OrderAck {
    return { clientOrderId, accepted: true, ...(orderId ? { venueOrderId: orderId } : {}) }
  }

  return {
    submit(req: OrderRequest): Promise<OrderAck> {
      const venue = resolveVenue(req.symbol)
      recordVenue(req.clientOrderId, venue) // authoritative before the ack (adoption on retry needs it)
      return callOrder(WEIGHT_WS_ORDER, async () => {
        try {
          const res = await withTimeout(wsApi.submitNewOrder(toOrderParams(req, venue)))
          return toAck(req.clientOrderId, res.data?.orderId)
        } catch (err) {
          throw liftWsApiError(err) // surface the reply's retCode so callOrder maps it right
        }
      })
    },

    submitRest(req: OrderRequest): Promise<OrderAck> {
      const venue = resolveVenue(req.symbol)
      recordVenue(req.clientOrderId, venue)
      return callOrder(WEIGHT_REST_ORDER, async () => {
        const res = await rest.submitOrder(toOrderParams(req, venue))
        return toAck(req.clientOrderId, res.result?.orderId)
      })
    },

    getOrder(clientOrderId: string): Promise<Order> {
      return getOrder(clientOrderId) // already lane-wrapped + mapped by the adapter
    },

    cancel(clientOrderId: string): Promise<void> {
      // Unknown id → NotFound (the manager reconciles via getOrder), never a raw throw.
      let venue: string
      try {
        venue = venueForClientId(clientOrderId)
      } catch (err) {
        return Promise.reject(err instanceof NotFoundError ? err : mapErr(err))
      }
      return callOrder(WEIGHT_WS_CANCEL, async () => {
        try {
          await withTimeout(wsApi.cancelOrder({ category: 'linear', symbol: venue, orderLinkId: clientOrderId }))
        } catch (err) {
          throw liftWsApiError(err)
        }
      })
    },
  }
}
