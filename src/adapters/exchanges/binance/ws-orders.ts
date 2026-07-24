/**
 * Binance {@link OrderTransport} — the venue-specific write path behind the order
 * manager (`11_execution_and_account_state.md` §5). WS submit/cancel via the native
 * `WebsocketAPIClient` (tiagosiebler `binance@3.6.1`), REST-fallback submit via the
 * `USDMClient`, and order ground truth via the adapter's existing ccxt `getOrder`.
 * Denomination lives only here (the manager speaks base-unit core requests); every
 * throw is mapped through {@link mapBinanceError} so the manager only ever sees an
 * {@link AdapterError}.
 *
 * WS timeout: the lib's submit/cancel promise **rejects on disconnect / WS-API error**
 * but has **no** per-request timeout, so we race it against a {@link Clock} timer that
 * rejects {@link WsTimeoutError} — the signal the manager turns into REST fallback (where
 * the venue profile enables it) or a bounded WS retry (Binance today).
 *
 * `newClientOrderId` is set on every submit and the `clientOrderId → venueSymbol` map is
 * populated authoritatively at submit time (before the WS ack), so `getOrder`/`cancel`
 * can resolve the symbol Binance REST/WS require even if the ack later times out.
 */

import type {
  NewFuturesOrderParams,
  NewOrderResult,
  WSAPIFuturesOrder,
  WSAPIFuturesOrderCancelRequest,
  WSAPINewFuturesOrderRequest,
  WSAPIResponse,
} from 'binance'
import type { Clock } from '../../../core/ports/clock.js'
import type { Order, OrderAck, OrderRequest } from '../../../core/ports/exchange-adapter.js'
import type { OrderTransport } from '../../../execution/order-manager.js'
import { NotFoundError, WsTimeoutError } from '../../shared/errors.js'
import { mapBinanceError } from './error-map.js'

/** Default WS ack timeout — the lib has no per-request timer, so we impose one (`10` §5 `WsTimeout`). */
const WS_ACK_TIMEOUT_MS = 5_000
/**
 * Order-lane weights (`10` §6) — real published Binance fapi request weights (`POST
 * order`/`DELETE order`), cross-checked against `ccxt.binanceusdm().describe().api
 * .fapiPrivate.{post,delete}` cost tables. The native WS-API order endpoints mirror
 * their REST equivalents 1:1, so the same weights apply to the WS submit/cancel path.
 */
const WEIGHT_WS_ORDER = 4
const WEIGHT_WS_CANCEL = 1
const WEIGHT_REST_ORDER = 4

/** The slice of the native `WebsocketAPIClient` the transport calls (USD-M futures orders). */
export interface BinanceWsOrderClient {
  submitNewFuturesOrder(market: 'usdm', params: WSAPINewFuturesOrderRequest): Promise<WSAPIResponse<WSAPIFuturesOrder>>
  cancelFuturesOrder(market: 'usdm', params: WSAPIFuturesOrderCancelRequest): Promise<WSAPIResponse<WSAPIFuturesOrder>>
}

/** The slice of the native `USDMClient` the REST-fallback submit calls. */
export interface BinanceRestOrderClient {
  submitNewOrder(params: NewFuturesOrderParams): Promise<NewOrderResult>
}

export interface BinanceOrderTransportDeps {
  readonly wsApi: BinanceWsOrderClient
  readonly rest: BinanceRestOrderClient
  readonly clock: Clock
  /** Normalized symbol → exact venue string (adapter registry read). */
  readonly resolveVenue: (symbol: string) => string
  /** Persist `clientOrderId → venueSymbol` at submit so `getOrder`/`cancel` can resolve the symbol. */
  readonly recordVenue: (clientOrderId: string, venueSymbol: string) => void
  /** Look up the venue symbol for a known `clientOrderId`; throws `NotFound` if unseen. */
  readonly venueForClientId: (clientOrderId: string) => string
  /**
   * Reuse the adapter's ccxt `getOrder` (symbol resolved from the same map). Already
   * lane-wrapped + error-mapped by the adapter (`callGeneral`), so the transport does
   * not re-wrap it — that would double-charge the limiter.
   */
  readonly getOrder: (clientOrderId: string) => Promise<Order>
  /** Order-lane limiter + error-map wrapper (adapter `callOrder`, mirrors `callGeneral`). */
  readonly callOrder: <T>(weight: number, fn: () => Promise<T>) => Promise<T>
  /** Override the WS ack timeout (tests); defaults to {@link WS_ACK_TIMEOUT_MS}. */
  readonly wsAckTimeoutMs?: number
  /** Structured-log callback for an unmapped venue error code (mirrors `adapter.ts`'s `callGeneral`/`callOrder`). */
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void
}

/**
 * The WS-API client rejects with a plain payload `{ status, error: { code, msg } }`
 * (not an `Error`), so the numeric venue code sits at `err.error.code` — invisible to
 * {@link mapBinanceError}, which reads `err.code`. Lift it onto an `Error.code` so a
 * `-4164`/`-2010`/… reject classifies as `OrderRejected`, not an unknown `NetworkError`
 * (which would be wrongly retried). Anything else (our `WsTimeoutError`, a real socket
 * `Error`) passes through untouched.
 */
function liftWsApiError(err: unknown): unknown {
  if (err !== null && typeof err === 'object' && 'error' in err) {
    const inner = (err as { error: unknown }).error
    if (inner !== null && typeof inner === 'object' && 'code' in inner) {
      const { code, msg } = inner as { code: unknown; msg?: unknown }
      const lifted = new Error(typeof msg === 'string' ? msg : 'binance ws-api error')
      ;(lifted as { code?: unknown }).code = code
      return lifted
    }
  }
  return err
}

/** `long/short` → Binance `BUY/SELL`. */
function venueSide(side: OrderRequest['side']): 'BUY' | 'SELL' {
  return side === 'long' ? 'BUY' : 'SELL'
}

/** Core order type → Binance `FuturesOrderType`. */
function venueType(type: OrderRequest['type']): 'MARKET' | 'LIMIT' | 'STOP' {
  return type === 'market' ? 'MARKET' : type === 'limit' ? 'LIMIT' : 'STOP'
}

/** Build the WS submit payload; prices/qty are strings at the API boundary, `GTC` for priced orders. */
function toWsOrder(req: OrderRequest, venue: string, timestamp: number): WSAPINewFuturesOrderRequest {
  return {
    symbol: venue,
    side: venueSide(req.side),
    type: venueType(req.type),
    quantity: String(req.qty),
    newClientOrderId: req.clientOrderId,
    newOrderRespType: 'RESULT',
    timestamp,
    ...(req.reduceOnly ? { reduceOnly: 'true' as const } : {}),
    ...(req.price !== undefined ? { price: String(req.price), timeInForce: 'GTC' as const } : {}),
  }
}

/** Build the REST-fallback submit payload (numeric fields; same `clientOrderId`). */
function toRestOrder(req: OrderRequest): NewFuturesOrderParams {
  return {
    symbol: '', // filled by caller (needs the resolved venue symbol)
    side: venueSide(req.side),
    type: venueType(req.type),
    quantity: req.qty,
    newClientOrderId: req.clientOrderId,
    newOrderRespType: 'RESULT',
    ...(req.reduceOnly ? { reduceOnly: 'true' as const } : {}),
    ...(req.price !== undefined ? { price: req.price, timeInForce: 'GTC' as const } : {}),
  }
}

export function createBinanceOrderTransport(deps: BinanceOrderTransportDeps): OrderTransport {
  const { wsApi, rest, clock, resolveVenue, recordVenue, venueForClientId, getOrder, callOrder } = deps
  const ackTimeoutMs = deps.wsAckTimeoutMs ?? WS_ACK_TIMEOUT_MS
  const log = deps.log ?? (() => {})

  /** Map a venue throw, logging an unmapped code (mirrors `adapter.ts`'s `mapErr`). */
  function mapErr(err: unknown): ReturnType<typeof mapBinanceError> {
    return mapBinanceError(err, { onUnknown: (rawCode) => log('binance: unmapped venue error code', { rawCode }) })
  }

  /** Race a WS promise against a Clock timer that rejects `WsTimeoutError` (the lib has none). */
  function withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = clock.scheduleTimer(clock.now() + ackTimeoutMs, () =>
        reject(new WsTimeoutError('binance ws order ack timeout')),
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

  /** WS/REST result → ack. A resolved submit means the venue accepted it (a reject rejects the promise). */
  function toAck(clientOrderId: string, orderId: number): OrderAck {
    return { clientOrderId, accepted: true, venueOrderId: String(orderId) }
  }

  return {
    submit(req: OrderRequest): Promise<OrderAck> {
      const venue = resolveVenue(req.symbol)
      recordVenue(req.clientOrderId, venue) // authoritative before the ack (adoption on retry needs it)
      return callOrder(WEIGHT_WS_ORDER, async () => {
        try {
          const res = await withTimeout(wsApi.submitNewFuturesOrder('usdm', toWsOrder(req, venue, clock.now())))
          return toAck(req.clientOrderId, res.result.orderId)
        } catch (err) {
          throw liftWsApiError(err) // surface a nested venue code so callOrder maps it right
        }
      })
    },

    submitRest(req: OrderRequest): Promise<OrderAck> {
      const venue = resolveVenue(req.symbol)
      recordVenue(req.clientOrderId, venue)
      return callOrder(WEIGHT_REST_ORDER, async () => {
        const res = await rest.submitNewOrder({ ...toRestOrder(req), symbol: venue })
        return toAck(req.clientOrderId, res.orderId)
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
          await withTimeout(
            wsApi.cancelFuturesOrder('usdm', {
              symbol: venue,
              origClientOrderId: clientOrderId,
              timestamp: clock.now(),
            }),
          )
        } catch (err) {
          throw liftWsApiError(err)
        }
      })
    },
  }
}
