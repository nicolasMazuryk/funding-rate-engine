/**
 * OKX {@link OrderTransport} — the venue-specific write path behind the order manager
 * (`11_execution_and_account_state.md` §5), mirroring `../bybit/ws-orders.ts`. WS
 * submit/cancel via the native `WebsocketAPIClient` (tiagosiebler `okx-api@3.2.1`),
 * REST-fallback submit via `RestClient`, and order ground truth via the adapter's existing
 * ccxt `getOrder`. Every throw is mapped through {@link mapOkxError} so the manager only ever
 * sees an {@link AdapterError}.
 *
 * WS timeout: the lib's submit/cancel promise rejects on disconnect / WS-API error but has
 * **no** per-request timeout, so we race it against a {@link Clock} timer that rejects
 * {@link WsTimeoutError} — the signal the manager turns into REST fallback (where the venue
 * profile enables it) or a bounded WS retry.
 *
 * OKX specifics, all different from both prior venues:
 *  - **the client id is re-spelled.** OKX's `clOrdId` is alphanumeric-only and 32 chars;
 *    the engine's `BTC-28710000-entry-1` is neither, so it goes through
 *    `./client-order-id.ts` on the way out and comes back through the same codec on the
 *    `orders` channel. Binance and Bybit both take the id verbatim.
 *  - **`tdMode: 'isolated'` on every order** — OKX chooses the margin mode per order rather
 *    than per account/symbol (`11` §1, `./account-setup.ts`). `posSide` is omitted: it is
 *    only accepted in long/short mode.
 *  - **a third reject shape.** A resolved WS-API reply can still be a rejection: the envelope
 *    carries `code: '1'` ("operation failed") with the real reason at `data[0].sCode`/`sMsg`.
 *    Binance nests at `err.error.code`; Bybit rejects with a raw `retCode`. So the transport
 *    inspects the **resolved** value as well as the throw ({@link liftWsApiError}), and a
 *    non-`0` `sCode` becomes a mapped throw rather than a silent fake ack.
 *  - **no native stop type on the trade endpoint**: a `'stop'` request becomes a market order
 *    with `slTriggerPx`/`slOrdPx: '-1'` (market on trigger), the attached-algo form OKX uses.
 */

import type { Clock } from '../../../core/ports/clock.js'
import type { Order, OrderAck, OrderRequest } from '../../../core/ports/exchange-adapter.js'
import type { OrderTransport } from '../../../execution/order-manager.js'
import { NotFoundError, WsTimeoutError } from '../../shared/errors.js'
import { toVenueClOrdId } from './client-order-id.js'
import { mapOkxError } from './error-map.js'

/** Default WS ack timeout — the lib has no per-request timer, so we impose one (`10` §5 `WsTimeout`). */
const WS_ACK_TIMEOUT_MS = 5_000
/**
 * Order-lane weights (`10` §6). OKX publishes no weight model — its caps are request counts
 * (60 orders/2 s per instrument, 1000/2 s per sub-account), which the profile's
 * `rate_limit_weight_per_minute: 1200` at a 50 % reserve expresses as 600/min = 10/s. So every
 * order-lane call costs 1 token: one token = one request.
 */
const WEIGHT_WS_ORDER = 1
const WEIGHT_WS_CANCEL = 1
const WEIGHT_REST_ORDER = 1

/** Margin mode requested per order (`11` §1); OKX has no account-level isolated switch. */
const TRADE_MODE = 'isolated'

/** One per-order result row: `sCode: '0'` is success, anything else is the real reason. */
export interface OkxOrderResult {
  readonly ordId?: string
  readonly clOrdId?: string
  readonly sCode?: string
  readonly sMsg?: string
}

/** The WS-API envelope: `code: '0'` overall, with the per-order verdict inside `data`. */
export interface OkxWsApiReply {
  readonly code?: string
  readonly msg?: string
  readonly data?: readonly OkxOrderResult[]
}

/** The order payload OKX takes on both the WS trade API and `POST /api/v5/trade/order`. */
export interface OkxOrderParams {
  readonly instId: string
  /**
   * The venue's numeric instrument code (`GET /api/v5/public/instruments` `instIdCode`, also
   * on the ccxt market `info`). OKX deprecated `instId` on the **WS trade API** in March 2026
   * and now rejects a submit carrying only the string id (`50014 Parameter instIdCode can not
   * be empty` — observed live, task 0430), so the WS path always sends both. REST still takes
   * `instId` alone.
   */
  readonly instIdCode?: number
  readonly tdMode: 'isolated' | 'cross' | 'cash'
  readonly side: 'buy' | 'sell'
  readonly ordType: 'market' | 'limit'
  readonly sz: string
  readonly px?: string
  readonly clOrdId?: string
  readonly reduceOnly?: boolean
  readonly slTriggerPx?: string
  readonly slOrdPx?: string
}

/** The slice of the native `WebsocketAPIClient` the transport calls. */
export interface OkxWsOrderClient {
  submitNewOrder(params: OkxOrderParams): Promise<OkxWsApiReply>
  cancelOrder(params: { instId: string; instIdCode?: number; clOrdId?: string; ordId?: string }): Promise<OkxWsApiReply>
}

/** The slice of the native `RestClient` the REST-fallback submit calls (returns the rows directly). */
export interface OkxRestOrderClient {
  submitOrder(params: OkxOrderParams): Promise<readonly OkxOrderResult[]>
}

export interface OkxOrderTransportDeps {
  readonly wsApi: OkxWsOrderClient
  readonly rest: OkxRestOrderClient
  readonly clock: Clock
  /** Normalized symbol → exact `instId` (adapter registry read). */
  readonly resolveVenue: (symbol: string) => string
  /** Persist `clientOrderId → instId` at submit so `getOrder`/`cancel` can resolve the symbol. */
  readonly recordVenue: (clientOrderId: string, venueSymbol: string) => void
  /** Look up the `instId` for a known `clientOrderId`; throws `NotFound` if unseen. */
  readonly venueForClientId: (clientOrderId: string) => string
  /**
   * `instId` → the venue's numeric `instIdCode`, off the same registry load. Required on the
   * WS trade API (see {@link OkxOrderParams.instIdCode}); `undefined` for a symbol the
   * registry has no code for, which the REST path still handles.
   */
  readonly resolveInstIdCode?: (venueSymbol: string) => number | undefined
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
 * A WS-API failure can arrive as the raw reply object rather than an `Error` (the SDK rejects
 * the deferred promise with the payload), in which case `err.message` would read
 * `[object Object]` and `instanceof` checks fail. Lift it to a real `Error` carrying the
 * venue's own reason, keeping `code`/`data` on it so {@link mapOkxError} can read either the
 * top-level code or the nested `data[0].sCode`. Anything else (our {@link WsTimeoutError}, a
 * real socket `Error`) passes through untouched.
 */
function liftWsApiError(err: unknown): unknown {
  if (err !== null && typeof err === 'object' && !(err instanceof Error) && ('code' in err || 'data' in err)) {
    const reply = err as OkxWsApiReply
    const lifted = new Error(rejectionReason(reply) ?? 'okx ws-api error')
    Object.assign(lifted, { code: reply.code, data: reply.data })
    return lifted
  }
  return err
}

/** The first non-success `sCode` row's message, else the envelope `msg`; `undefined` if none. */
function rejectionReason(reply: OkxWsApiReply): string | undefined {
  const bad = (reply.data ?? []).find((row) => row.sCode !== undefined && row.sCode !== '0')
  if (bad?.sMsg !== undefined && bad.sMsg.length > 0) return bad.sMsg
  return reply.msg !== undefined && reply.msg.length > 0 ? reply.msg : undefined
}

/**
 * OKX answers a rejected order with a **resolved** promise carrying `code: '1'` and the real
 * reason at `data[0].sCode` — so a resolved reply is not an ack until it is checked. Throw the
 * reply itself (lifted) when any row failed; the caller's `mapErr` then classifies the nested
 * `sCode`, which is how a `51008` becomes `InsufficientBalance` and not a retryable
 * `NetworkError`.
 */
function assertAccepted(reply: OkxWsApiReply): OkxOrderResult | undefined {
  const rows = reply.data ?? []
  const bad = rows.find((row) => row.sCode !== undefined && row.sCode !== '0')
  if (bad !== undefined) throw liftWsApiError(reply)
  if (reply.code !== undefined && reply.code !== '0') throw liftWsApiError(reply)
  return rows[0]
}

/** `long/short` → OKX `buy/sell`. */
function venueSide(side: OrderRequest['side']): 'buy' | 'sell' {
  return side === 'long' ? 'buy' : 'sell'
}

/**
 * Build the OKX order payload. Prices/qty are strings at the API boundary and `sz` is counted
 * in **contracts**, which is already the unit the core sizes in (`computeQty` divides by
 * `Instrument.contractSize`) — the thing that makes this venue's `ctVal ≠ 1` listings work.
 *
 * A `'stop'` request becomes a market order with an attached stop-loss trigger:
 * `slTriggerPx = req.price` and `slOrdPx = '-1'` (OKX's marker for "execute at market on
 * trigger"). There is no standalone stop order type on the trade endpoint.
 */
function toOrderParams(req: OrderRequest, venue: string, instIdCode?: number): OkxOrderParams {
  const base = {
    instId: venue,
    ...(instIdCode !== undefined ? { instIdCode } : {}),
    tdMode: TRADE_MODE,
    side: venueSide(req.side),
    sz: String(req.qty),
    clOrdId: toVenueClOrdId(req.clientOrderId),
    ...(req.reduceOnly ? { reduceOnly: true } : {}),
  } as const
  if (req.type === 'stop') {
    return {
      ...base,
      ordType: 'market',
      ...(req.price !== undefined ? { slTriggerPx: String(req.price), slOrdPx: '-1' } : {}),
    }
  }
  if (req.type === 'limit') {
    return { ...base, ordType: 'limit', ...(req.price !== undefined ? { px: String(req.price) } : {}) }
  }
  return { ...base, ordType: 'market' }
}

export function createOkxOrderTransport(deps: OkxOrderTransportDeps): OrderTransport {
  const { wsApi, rest, clock, resolveVenue, recordVenue, venueForClientId, getOrder, callOrder } = deps
  const ackTimeoutMs = deps.wsAckTimeoutMs ?? WS_ACK_TIMEOUT_MS
  const log = deps.log ?? (() => {})
  const instIdCodeOf = deps.resolveInstIdCode ?? ((): number | undefined => undefined)

  /** Map a venue throw, logging an unmapped code (mirrors `adapter.ts`'s `mapErr`). */
  function mapErr(err: unknown): ReturnType<typeof mapOkxError> {
    return mapOkxError(err, { onUnknown: (rawCode) => log('okx: unmapped venue error code', { rawCode }) })
  }

  /** Race a WS promise against a Clock timer that rejects `WsTimeoutError` (the lib has none). */
  function withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = clock.scheduleTimer(clock.now() + ackTimeoutMs, () =>
        reject(new WsTimeoutError('okx ws order ack timeout')),
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

  /** An accepted submit → ack. `ordId` is the venue order id when the row carries one. */
  function toAck(clientOrderId: string, row: OkxOrderResult | undefined): OrderAck {
    return { clientOrderId, accepted: true, ...(row?.ordId ? { venueOrderId: row.ordId } : {}) }
  }

  return {
    submit(req: OrderRequest): Promise<OrderAck> {
      const venue = resolveVenue(req.symbol)
      recordVenue(req.clientOrderId, venue) // authoritative before the ack (adoption on retry needs it)
      return callOrder(WEIGHT_WS_ORDER, async () => {
        try {
          const reply = await withTimeout(wsApi.submitNewOrder(toOrderParams(req, venue, instIdCodeOf(venue))))
          return toAck(req.clientOrderId, assertAccepted(reply))
        } catch (err) {
          throw liftWsApiError(err) // surface the reply's sCode so callOrder maps it right
        }
      })
    },

    submitRest(req: OrderRequest): Promise<OrderAck> {
      const venue = resolveVenue(req.symbol)
      recordVenue(req.clientOrderId, venue)
      return callOrder(WEIGHT_REST_ORDER, async () => {
        // The native REST client returns the `data` rows directly, so the per-order `sCode`
        // check is the same one the WS path runs — a 200 response is not an acceptance.
        const rows = await rest.submitOrder(toOrderParams(req, venue))
        return toAck(req.clientOrderId, assertAccepted({ code: '0', data: rows }))
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
          const instIdCode = instIdCodeOf(venue)
          const reply = await withTimeout(
            wsApi.cancelOrder({
              instId: venue,
              ...(instIdCode !== undefined ? { instIdCode } : {}),
              clOrdId: toVenueClOrdId(clientOrderId),
            }),
          )
          assertAccepted(reply)
        } catch (err) {
          throw liftWsApiError(err)
        }
      })
    },
  }
}
