/**
 * KuCoin {@link OrderTransport} — the venue-specific write path behind the order manager
 * (`11_execution_and_account_state.md` §5), mirroring `../bitget/ws-orders.ts`. WS submit/cancel
 * via the native `WebsocketAPIClient` (tiagosiebler `kucoin-api@2.6.1`), REST-fallback submit via
 * `FuturesClient.submitOrder`, and order ground truth via the adapter's existing ccxt `getOrder`.
 * Every throw is mapped through {@link mapKucoinError} so the manager only ever sees an
 * {@link AdapterError}.
 *
 * WS timeout: the lib's submit/cancel promise rejects on disconnect / WS-API error but has **no**
 * per-request timeout, so we race it against a {@link Clock} timer that rejects
 * {@link WsTimeoutError} — the signal the manager turns into REST fallback (where the venue
 * profile enables it) or a bounded WS retry.
 *
 * KuCoin specifics:
 *
 *  - **`size` is an integer contract count, and there is no second division.** This is the venue
 *    where the `10` §4 denomination trap actually fires. `computeQty` is
 *    `amountUsd / price / contractSize`, and KuCoin's `contractSize` *is* its `multiplier` — so
 *    `computeQty`'s output is already the number the venue wants. Applying `toVenueUnits` on top
 *    would divide by the contract size a second time and under-size every order by up to 1000×
 *    (`XBTUSDTM` = 0.001 BTC/contract). `contract-size-chain.test.ts` pins this end to end.
 *  - **one spelling, one success code.** Unlike Bitget, both surfaces take the same payload
 *    shape and both answer `code: '200000'` ({@link SUCCESS_CODE}) — the WS trade API and REST
 *    share the venue's one success envelope, so there is no casing fork here.
 *  - **the client id goes out verbatim.** `clientOid` is any unique string up to 40 chars, above
 *    the engine's 36-char key, so `./client-order-id.ts` is a bare length guard — no escape codec
 *    (OKX) and no ceiling below the core's (Bitget).
 *  - **cancel needs the symbol.** `cancelFuturesOrder` accepts `{ orderId }` *or*
 *    `{ clientOid, symbol }` — cancelling by client id is only possible with the instrument, so
 *    the cancel path reads the submit-time `clientOrderId → venue symbol` map (OKX's shape). An
 *    id this process never submitted is a local typed `NotFound` rather than a venue round-trip.
 *  - **`marginMode: 'ISOLATED'` on every order** (upper case on this venue). The mandate is
 *    isolated margin (`11` §1) and KuCoin accepts the mode per order, so it is stated per order
 *    rather than assumed from the account-level switch `./account-setup.ts` performs.
 *  - **no standalone stop type**: a `'stop'` request becomes a market order carrying the venue's
 *    trigger triplet (`stop: 'up' | 'down'`, `stopPrice`, `stopPriceType: 'MP'` = mark price).
 *    The direction is derived from the order side — a stop on a long exit triggers on the way
 *    *down*, and vice versa. `positionSide` is omitted: it only exists in hedge mode, which
 *    `setPositionMode` rules out.
 */

import type { Clock } from '../../../core/ports/clock.js'
import type { Order, OrderAck, OrderRequest } from '../../../core/ports/exchange-adapter.js'
import type { OrderTransport } from '../../../execution/order-manager.js'
import { NotFoundError, WsTimeoutError } from '../../shared/errors.js'
import { toVenueClientOid } from './client-order-id.js'
import { mapKucoinError } from './error-map.js'

/** Default WS ack timeout — the lib has no per-request timer, so we impose one (`10` §5 `WsTimeout`). */
const WS_ACK_TIMEOUT_MS = 5_000

/**
 * Order-lane weights (`10` §6). KuCoin is the one venue in this repo with a **real** published
 * per-endpoint weight model — a per-UID resource pool over a rolling 30 s window — so these are
 * not the siblings' uniform `1`. The values and the pool sizing are derived in the
 * `rate_limit_weight_per_minute` comment in `config/exchanges.yaml`; the read-side weights live
 * in `./adapter.ts`.
 */
const WEIGHT_WS_ORDER = 2
const WEIGHT_WS_CANCEL = 1
const WEIGHT_REST_ORDER = 2

/** KuCoin's single success envelope, on REST and on the WS trade API alike. */
const SUCCESS_CODE = '200000'

/** Margin mode requested per order (`11` §1) — upper case on this venue. */
const MARGIN_MODE = 'ISOLATED' as const

/** Trigger price source for a `'stop'` request: `MP` = mark price (vs `TP` trade, `IP` index). */
const STOP_PRICE_TYPE = 'MP' as const

/** The accepted-order row both surfaces return under `data`. */
export interface KucoinOrderResult {
  readonly orderId?: string
  readonly clientOid?: string
}

/** The envelope both surfaces answer with: `code: '200000'` on acceptance, row under `data`. */
export interface KucoinOrderReply {
  readonly code?: string
  readonly msg?: string
  readonly data?: KucoinOrderResult
}

/**
 * The venue-shaped order payload. One shape for both surfaces — see the file header. `size` is a
 * **number** (integer contracts) while prices are strings, which is the venue's own asymmetry,
 * not ours.
 */
export interface KucoinOrderParams {
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly type: 'market' | 'limit'
  readonly size: number
  readonly price?: string
  readonly clientOid: string
  readonly marginMode: typeof MARGIN_MODE
  /**
   * Isolated leverage. KuCoin has **no isolated-leverage endpoint** — the value rides the order
   * (`./account-setup.ts`), so the transport reads it from the account-setup cache at submit.
   */
  readonly leverage?: number
  readonly reduceOnly?: boolean
  readonly stop?: 'up' | 'down'
  readonly stopPrice?: string
  readonly stopPriceType?: typeof STOP_PRICE_TYPE
}

/** The slice of the native `WebsocketAPIClient` the transport calls. */
export interface KucoinWsOrderClient {
  submitFuturesOrder(params: KucoinOrderParams): Promise<KucoinOrderReply>
  cancelFuturesOrder(params: { clientOid: string; symbol: string }): Promise<KucoinOrderReply>
}

/** The slice of the native `FuturesClient` the REST-fallback submit calls. */
export interface KucoinRestOrderClient {
  submitOrder(params: KucoinOrderParams): Promise<KucoinOrderReply>
}

export interface KucoinOrderTransportDeps {
  readonly wsApi: KucoinWsOrderClient
  readonly rest: KucoinRestOrderClient
  readonly clock: Clock
  /** Normalized symbol → exact venue symbol (adapter registry read). */
  readonly resolveVenue: (symbol: string) => string
  /** Persist `clientOrderId → venue symbol` at submit: both `getOrder` and **cancel** need it. */
  readonly recordVenue: (clientOrderId: string, venueSymbol: string) => void
  /** Read back a venue symbol recorded at submit; `undefined` for an id this process never sent. */
  readonly lookupVenue: (clientOrderId: string) => string | undefined
  /**
   * Isolated leverage for a canonical symbol, from the account-setup cache. `undefined` leaves
   * the field off and the venue applies the symbol's current setting — see `./account-setup.ts`
   * for why this is an order field on KuCoin and an endpoint everywhere else.
   */
  readonly resolveLeverage?: (symbol: string) => number | undefined
  /**
   * Reuse the adapter's ccxt `getOrder`. Already lane-wrapped + error-mapped by the adapter
   * (`callGeneral`), so the transport does not re-wrap it — that would double-charge the limiter.
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
 * A WS-API failure arrives as the raw reject frame rather than an `Error` (the SDK rejects the
 * deferred promise with the parsed payload, `{ code: '429000', op: 'futures.order', msg: … }`),
 * in which case `err.message` would read `[object Object]` and `instanceof` checks fail. Lift it
 * to a real `Error` carrying the venue's own reason, keeping `code` on it so
 * {@link mapKucoinError} can classify it. Anything else (our {@link WsTimeoutError}, a real
 * socket `Error`) passes through untouched.
 */
function liftWsApiError(err: unknown): unknown {
  if (err !== null && typeof err === 'object' && !(err instanceof Error) && 'code' in err) {
    const reply = err as KucoinOrderReply
    const lifted = new Error(reply.msg !== undefined && reply.msg.length > 0 ? reply.msg : 'kucoin ws-api error')
    Object.assign(lifted, { code: reply.code, msg: reply.msg })
    return lifted
  }
  return err
}

/**
 * A resolved reply is not an ack until its envelope code is checked — the SDK rejects on a reject
 * frame, but a defensive gate here costs nothing and is what keeps a future SDK change from
 * turning a rejection into a fake ack. Throws the reply itself (lifted) so the caller's `mapErr`
 * classifies the venue code — which is how a `300003` becomes `InsufficientBalance` and not a
 * retryable `NetworkError`.
 */
function assertAccepted(reply: KucoinOrderReply): void {
  if (reply.code !== undefined && reply.code !== SUCCESS_CODE) throw liftWsApiError(reply)
}

/**
 * Serialize a price for the wire, **off the float grid**. The core rounds a price to the venue
 * tick (`roundPrice` → `Math.round(p / 0.1) * 0.1`), which for a 0.1 tick lands on
 * `62785.700000000004`; `String()` on that ships all 15 digits and a venue that validates the
 * tick grid rejects the order (observed live on Bitget, task 0440 — the STATUS carry-forward
 * that made this a per-venue rule). Twelve significant digits is far more precision than any
 * venue tick needs and exactly enough to drop the binary-representation tail.
 */
function toVenueNumber(value: number): string {
  return String(Number(value.toPrecision(12)))
}

/** `long/short` → KuCoin `buy/sell`. */
function venueSide(side: OrderRequest['side']): 'buy' | 'sell' {
  return side === 'long' ? 'buy' : 'sell'
}

/**
 * Build the venue order payload. `size` is passed through as the **contract count** the core
 * already computed — see the file header on why nothing divides it again.
 *
 * A `'stop'` request becomes a market order with the venue's trigger triplet. `stop` is the
 * direction the mark price must cross: a `sell` stop (exiting a long) triggers on the way
 * `'down'`, a `buy` stop (exiting a short) on the way `'up'`.
 */
export function toOrderParams(req: OrderRequest, venue: string, leverage?: number): KucoinOrderParams {
  const side = venueSide(req.side)
  const base = {
    symbol: venue,
    side,
    size: req.qty,
    clientOid: toVenueClientOid(req.clientOrderId),
    marginMode: MARGIN_MODE,
    ...(leverage !== undefined ? { leverage } : {}),
    ...(req.reduceOnly === true ? { reduceOnly: true } : {}),
  } as const
  if (req.type === 'stop') {
    return {
      ...base,
      type: 'market',
      ...(req.price !== undefined
        ? {
            stop: side === 'sell' ? ('down' as const) : ('up' as const),
            stopPrice: toVenueNumber(req.price),
            stopPriceType: STOP_PRICE_TYPE,
          }
        : {}),
    }
  }
  if (req.type === 'limit') {
    return { ...base, type: 'limit', ...(req.price !== undefined ? { price: toVenueNumber(req.price) } : {}) }
  }
  return { ...base, type: 'market' }
}

export function createKucoinOrderTransport(deps: KucoinOrderTransportDeps): OrderTransport {
  const { wsApi, rest, clock, resolveVenue, recordVenue, lookupVenue, getOrder, callOrder } = deps
  const ackTimeoutMs = deps.wsAckTimeoutMs ?? WS_ACK_TIMEOUT_MS
  const resolveLeverage = deps.resolveLeverage ?? ((): undefined => undefined)
  const log = deps.log ?? (() => {})

  /** Map a venue throw, logging an unmapped code (mirrors `adapter.ts`'s `mapErr`). */
  function mapErr(err: unknown): ReturnType<typeof mapKucoinError> {
    return mapKucoinError(err, { onUnknown: (rawCode) => log('kucoin: unmapped venue error code', { rawCode }) })
  }

  /** Race a WS promise against a Clock timer that rejects `WsTimeoutError` (the lib has none). */
  function withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = clock.scheduleTimer(clock.now() + ackTimeoutMs, () =>
        reject(new WsTimeoutError('kucoin ws order ack timeout')),
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
  function toAck(clientOrderId: string, row: KucoinOrderResult | undefined): OrderAck {
    return { clientOrderId, accepted: true, ...(row?.orderId ? { venueOrderId: row.orderId } : {}) }
  }

  return {
    submit(req: OrderRequest): Promise<OrderAck> {
      const venue = resolveVenue(req.symbol)
      recordVenue(req.clientOrderId, venue) // authoritative before the ack (adoption on retry needs it)
      return callOrder(WEIGHT_WS_ORDER, async () => {
        try {
          const reply = await withTimeout(
            wsApi.submitFuturesOrder(toOrderParams(req, venue, resolveLeverage(req.symbol))),
          )
          assertAccepted(reply)
          return toAck(req.clientOrderId, reply.data)
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
        const reply = await rest.submitOrder(toOrderParams(req, venue, resolveLeverage(req.symbol)))
        assertAccepted(reply)
        return toAck(req.clientOrderId, reply.data)
      })
    },

    getOrder(clientOrderId: string): Promise<Order> {
      return getOrder(clientOrderId) // already lane-wrapped + mapped by the adapter
    },

    cancel(clientOrderId: string): Promise<void> {
      // KuCoin cancels by `clientOid` **plus the symbol** (OKX's shape, not Bitget's), so the
      // submit-time map is load-bearing here rather than only on the read path. An id this
      // process never submitted cannot be cancelled at all — a local typed `NotFound`, which is
      // what `11` §6 already treats as "already gone, reconcile to truth".
      const venue = lookupVenue(clientOrderId)
      if (venue === undefined) {
        return Promise.reject(
          new NotFoundError(`KucoinAdapter.cancelOrder: no known symbol for clientOrderId '${clientOrderId}'`),
        )
      }
      let clientOid: string
      try {
        clientOid = toVenueClientOid(clientOrderId)
      } catch (err) {
        return Promise.reject(mapErr(err))
      }
      return callOrder(WEIGHT_WS_CANCEL, async () => {
        try {
          const reply = await withTimeout(wsApi.cancelFuturesOrder({ clientOid, symbol: venue }))
          assertAccepted(reply)
        } catch (err) {
          throw liftWsApiError(err)
        }
      })
    },
  }
}
