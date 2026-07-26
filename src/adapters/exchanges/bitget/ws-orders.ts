/**
 * Bitget {@link OrderTransport} — the venue-specific write path behind the order manager
 * (`11_execution_and_account_state.md` §5), mirroring `../okx/ws-orders.ts`. WS submit/cancel
 * via the native `WebsocketAPIClient` (tiagosiebler `bitget-api@3.2.1`), REST-fallback submit
 * via `RestClientV3`, and order ground truth via the adapter's existing ccxt `getOrder`. Every
 * throw is mapped through {@link mapBitgetError} so the manager only ever sees an
 * {@link AdapterError}.
 *
 * WS timeout: the lib's submit/cancel promise rejects on disconnect / WS-API error but has
 * **no** per-request timeout, so we race it against a {@link Clock} timer that rejects
 * {@link WsTimeoutError} — the signal the manager turns into REST fallback (where the venue
 * profile enables it) or a bounded WS retry.
 *
 * Bitget specifics:
 *  - **the client id goes out verbatim.** `clientOid` accepts the engine's charset; only the
 *    32-char ceiling is enforced (`./client-order-id.ts`). OKX needs a full escape codec here;
 *    Bitget, like Binance and Bybit, does not.
 *  - **two spellings of everything.** The WS trade API takes `category: 'usdt-futures'` and
 *    `reduceOnly: 'YES' | 'NO'`; the REST endpoint takes `category: 'USDT-FUTURES'` and
 *    `reduceOnly: 'yes' | 'no'`. Same product, same field — the casing is not interchangeable,
 *    so each path builds its own payload from one shared core.
 *  - **two success codes.** A WS-API reply is accepted at `code: '0'`, a REST reply at
 *    `code: '00000'` ({@link SUCCESS_CODES}). `'00000'` is Bitget's success envelope everywhere
 *    else, so it must never be read as an error code (`./error-map.ts`).
 *  - **the reply payload is on `args`, not `data`** — a WS-API quirk of this SDK; the accepted
 *    order's `orderId` is at `reply.args[0].orderId`.
 *  - **`marginMode: 'isolated'` on every order.** The mandate is isolated margin (`11` §1) and
 *    Bitget accepts the mode per order, so it is stated per order rather than assumed from the
 *    account-level switch `./account-setup.ts` performs. If that switch was refused, the venue
 *    rejects the submit loudly instead of quietly filling it cross-margined.
 *  - **no native stop type**: a `'stop'` request becomes a market order with an attached
 *    `stopLoss` trigger (`slTriggerBy: 'mark'`), the form Bitget's UTA order endpoint takes.
 *    `posSide` is omitted — it only exists in hedge mode, which `setPositionMode` rules out.
 */

import type { Clock } from '../../../core/ports/clock.js'
import type { Order, OrderAck, OrderRequest } from '../../../core/ports/exchange-adapter.js'
import type { OrderTransport } from '../../../execution/order-manager.js'
import { NotFoundError, WsTimeoutError } from '../../shared/errors.js'
import { toVenueClientOid } from './client-order-id.js'
import { mapBitgetError } from './error-map.js'

/** Default WS ack timeout — the lib has no per-request timer, so we impose one (`10` §5 `WsTimeout`). */
const WS_ACK_TIMEOUT_MS = 5_000
/**
 * Order-lane weights (`10` §6). Bitget publishes no weight model — its UTA caps are request
 * counts per UID (10 place-order/s, 20 order-info/s), which the profile's
 * `rate_limit_weight_per_minute: 1800` at a 33 % reserve expresses as 594/min ≈ 9.9/s. So every
 * order-lane call costs 1 token: one token = one request.
 */
const WEIGHT_WS_ORDER = 1
const WEIGHT_WS_CANCEL = 1
const WEIGHT_REST_ORDER = 1

/** The linear-USDT product, as each surface spells it. See the file header. */
export const WS_CATEGORY = 'usdt-futures' as const
export const REST_CATEGORY = 'USDT-FUTURES' as const

/** Margin mode requested per order (`11` §1). */
const MARGIN_MODE = 'isolated'

/** Trigger price source for the attached stop-loss on a `'stop'` request. */
const STOP_TRIGGER_BY = 'mark'

/**
 * Accepted envelope codes. The WS trade API answers `'0'`; REST answers `'00000'`. Anything
 * else is a rejection, whichever surface it came from.
 */
const SUCCESS_CODES = new Set(['0', '00000'])

/** The accepted-order row both surfaces return (WS under `args`, REST under `data`). */
export interface BitgetOrderResult {
  readonly orderId?: string
  readonly clientOid?: string
  readonly symbol?: string
}

/** The WS-API envelope: `code: '0'` on acceptance, with the order row inside `args`. */
export interface BitgetWsApiReply {
  readonly code?: string
  readonly msg?: string
  readonly args?: readonly BitgetOrderResult[]
}

/** The REST envelope: `code: '00000'` on acceptance, with the order row inside `data`. */
export interface BitgetRestReply {
  readonly code?: string
  readonly msg?: string
  readonly data?: BitgetOrderResult
}

/** The venue-shaped order fields shared by both surfaces (casing-independent). */
interface BitgetOrderCore {
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly orderType: 'market' | 'limit'
  readonly qty: string
  readonly price?: string
  readonly clientOid: string
  readonly marginMode: 'isolated' | 'crossed'
  readonly stopLoss?: string
  readonly slTriggerBy?: 'market' | 'mark'
  readonly reduceOnly: boolean
}

/** The WS trade API's payload spelling (`reduceOnly: 'YES' | 'NO'`). */
export type BitgetWsOrderParams = Omit<BitgetOrderCore, 'reduceOnly'> & { readonly reduceOnly?: 'YES' | 'NO' }

/** The REST endpoint's payload spelling (`reduceOnly: 'yes' | 'no'`, plus the upper-case category). */
export type BitgetRestOrderParams = Omit<BitgetOrderCore, 'reduceOnly'> & {
  /** Literal, not `string`: the native `RestClientV3` types it as a union, and a widened
   * `string` would make the real client un-assignable to {@link BitgetRestOrderClient}. */
  readonly category: typeof REST_CATEGORY
  readonly reduceOnly?: 'yes' | 'no'
}

/** The slice of the native `WebsocketAPIClient` the transport calls. */
export interface BitgetWsOrderClient {
  submitNewOrder(category: string, params: BitgetWsOrderParams): Promise<BitgetWsApiReply>
  cancelOrder(category: string, params: { clientOid?: string; orderId?: string }): Promise<BitgetWsApiReply>
}

/** The slice of the native `RestClientV3` the REST-fallback submit calls. */
export interface BitgetRestOrderClient {
  submitNewOrder(params: BitgetRestOrderParams): Promise<BitgetRestReply>
}

export interface BitgetOrderTransportDeps {
  readonly wsApi: BitgetWsOrderClient
  readonly rest: BitgetRestOrderClient
  readonly clock: Clock
  /** Normalized symbol → exact venue symbol (adapter registry read). */
  readonly resolveVenue: (symbol: string) => string
  /** Persist `clientOrderId → venue symbol` at submit so `getOrder` can resolve the instrument. */
  readonly recordVenue: (clientOrderId: string, venueSymbol: string) => void
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
 * A WS-API failure arrives as the raw error frame rather than an `Error` (the SDK rejects the
 * deferred promise with the parsed payload, `{event: 'error', code: '43012', msg: …}`), in which
 * case `err.message` would read `[object Object]` and `instanceof` checks fail. Lift it to a
 * real `Error` carrying the venue's own reason, keeping `code` on it so {@link mapBitgetError}
 * can classify it. Anything else (our {@link WsTimeoutError}, a real socket `Error`) passes
 * through untouched.
 */
function liftWsApiError(err: unknown): unknown {
  if (err !== null && typeof err === 'object' && !(err instanceof Error) && 'code' in err) {
    const reply = err as BitgetWsApiReply
    const lifted = new Error(reply.msg !== undefined && reply.msg.length > 0 ? reply.msg : 'bitget ws-api error')
    Object.assign(lifted, { code: reply.code, msg: reply.msg })
    return lifted
  }
  return err
}

/**
 * A resolved reply is not an ack until its envelope code is checked — the SDK rejects on the
 * error frame, but a defensive gate here costs nothing and is what keeps a future SDK change
 * from turning a rejection into a fake ack. Throws the reply itself (lifted) so the caller's
 * `mapErr` classifies the venue code — which is how a `43012` becomes `InsufficientBalance` and
 * not a retryable `NetworkError`.
 */
function assertAccepted(code: string | undefined, reply: BitgetWsApiReply): void {
  if (code !== undefined && !SUCCESS_CODES.has(code)) throw liftWsApiError(reply)
}

/**
 * Serialize a price/qty for the wire, **off the float grid**. The core rounds a price to the
 * venue tick (`roundPrice` → `Math.round(p / 0.1) * 0.1`), which for a 0.1 tick lands on
 * `62785.700000000004`; `String()` on that ships all 15 digits and Bitget rejects the order
 * with `43028` "Please enter an integer multiple of 0.1 for price" (observed live, task 0440
 * Phase 2). Twelve significant digits is far more precision than any venue tick needs and
 * exactly enough to drop the binary-representation tail.
 */
function toVenueNumber(value: number): string {
  return String(Number(value.toPrecision(12)))
}

/** `long/short` → Bitget `buy/sell`. */
function venueSide(side: OrderRequest['side']): 'buy' | 'sell' {
  return side === 'long' ? 'buy' : 'sell'
}

/**
 * Build the surface-independent order fields. `qty` is in **base units**, which is already the
 * unit the core sizes in (`computeQty` divides by `Instrument.contractSize`, and Bitget's
 * contract size is 1 throughout — `./instrument.ts`).
 *
 * A `'stop'` request becomes a market order with an attached stop-loss: `stopLoss = req.price`
 * triggered off the mark price. Bitget's UTA order endpoint has no standalone stop type.
 */
function toOrderCore(req: OrderRequest, venue: string): BitgetOrderCore {
  const base = {
    symbol: venue,
    side: venueSide(req.side),
    qty: toVenueNumber(req.qty),
    clientOid: toVenueClientOid(req.clientOrderId),
    marginMode: MARGIN_MODE,
    reduceOnly: req.reduceOnly === true,
  } as const
  if (req.type === 'stop') {
    return {
      ...base,
      orderType: 'market',
      ...(req.price !== undefined ? { stopLoss: toVenueNumber(req.price), slTriggerBy: STOP_TRIGGER_BY } : {}),
    }
  }
  if (req.type === 'limit') {
    return { ...base, orderType: 'limit', ...(req.price !== undefined ? { price: toVenueNumber(req.price) } : {}) }
  }
  return { ...base, orderType: 'market' }
}

/** The WS trade API's spelling of an order (upper-case `reduceOnly`, no `category` in the body). */
export function toWsOrderParams(req: OrderRequest, venue: string): BitgetWsOrderParams {
  const { reduceOnly, ...core } = toOrderCore(req, venue)
  return { ...core, ...(reduceOnly ? { reduceOnly: 'YES' as const } : {}) }
}

/** The REST endpoint's spelling of an order (lower-case `reduceOnly`, upper-case `category`). */
export function toRestOrderParams(req: OrderRequest, venue: string): BitgetRestOrderParams {
  const { reduceOnly, ...core } = toOrderCore(req, venue)
  return { category: REST_CATEGORY, ...core, ...(reduceOnly ? { reduceOnly: 'yes' as const } : {}) }
}

export function createBitgetOrderTransport(deps: BitgetOrderTransportDeps): OrderTransport {
  const { wsApi, rest, clock, resolveVenue, recordVenue, getOrder, callOrder } = deps
  const ackTimeoutMs = deps.wsAckTimeoutMs ?? WS_ACK_TIMEOUT_MS
  const log = deps.log ?? (() => {})

  /** Map a venue throw, logging an unmapped code (mirrors `adapter.ts`'s `mapErr`). */
  function mapErr(err: unknown): ReturnType<typeof mapBitgetError> {
    return mapBitgetError(err, { onUnknown: (rawCode) => log('bitget: unmapped venue error code', { rawCode }) })
  }

  /** Race a WS promise against a Clock timer that rejects `WsTimeoutError` (the lib has none). */
  function withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = clock.scheduleTimer(clock.now() + ackTimeoutMs, () =>
        reject(new WsTimeoutError('bitget ws order ack timeout')),
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

  /** An accepted submit → ack. `orderId` is the venue order id when the row carries one. */
  function toAck(clientOrderId: string, row: BitgetOrderResult | undefined): OrderAck {
    return { clientOrderId, accepted: true, ...(row?.orderId ? { venueOrderId: row.orderId } : {}) }
  }

  return {
    submit(req: OrderRequest): Promise<OrderAck> {
      const venue = resolveVenue(req.symbol)
      recordVenue(req.clientOrderId, venue) // authoritative before the ack (adoption on retry needs it)
      return callOrder(WEIGHT_WS_ORDER, async () => {
        try {
          const reply = await withTimeout(wsApi.submitNewOrder(WS_CATEGORY, toWsOrderParams(req, venue)))
          assertAccepted(reply.code, reply)
          return toAck(req.clientOrderId, reply.args?.[0])
        } catch (err) {
          throw liftWsApiError(err) // surface the reply's code so callOrder maps it right
        }
      })
    },

    submitRest(req: OrderRequest): Promise<OrderAck> {
      const venue = resolveVenue(req.symbol)
      recordVenue(req.clientOrderId, venue)
      return callOrder(WEIGHT_REST_ORDER, async () => {
        // A 200 response is not an acceptance: the same envelope-code check the WS path runs.
        const reply = await rest.submitNewOrder(toRestOrderParams(req, venue))
        assertAccepted(reply.code, reply)
        return toAck(req.clientOrderId, reply.data)
      })
    },

    getOrder(clientOrderId: string): Promise<Order> {
      return getOrder(clientOrderId) // already lane-wrapped + mapped by the adapter
    },

    cancel(clientOrderId: string): Promise<void> {
      // Bitget cancels by `clientOid` alone — no instrument required, unlike OKX — so there is
      // no submit-time symbol lookup to fail here. An id the venue does not know comes back as
      // `22001`, which the error map turns into `NotFound` for the manager to reconcile.
      let clientOid: string
      try {
        clientOid = toVenueClientOid(clientOrderId)
      } catch (err) {
        return Promise.reject(err instanceof NotFoundError ? err : mapErr(err))
      }
      return callOrder(WEIGHT_WS_CANCEL, async () => {
        try {
          const reply = await withTimeout(wsApi.cancelOrder(WS_CATEGORY, { clientOid }))
          assertAccepted(reply.code, reply)
        } catch (err) {
          throw liftWsApiError(err)
        }
      })
    },
  }
}
