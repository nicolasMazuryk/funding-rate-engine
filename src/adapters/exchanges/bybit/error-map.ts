/**
 * Bybit venue-error mapping (`10_exchange_adapters_and_market_data.md` §5). Turns any
 * ccxt/native throw into exactly one {@link AdapterError} — the core only ever sees one of
 * eight kinds, never a raw venue code. Mapping tables are adapter-local; the union is
 * shared (task 0200 decision 5), so this file mirrors `../binance/error-map.ts` structurally
 * and only the table differs.
 *
 * Resolution order (same as Binance):
 *  1. **Numeric `retCode` wins** — read off `err.retCode`/`err.code`, else parsed out of the
 *     message (`bybit {"retCode":110007,…}`), so a generic ccxt `ExchangeError` carrying a
 *     Bybit code still lands on the right kind.
 *  2. **ccxt class** — `instanceof`, most-specific subclass first (`OrderNotFound` before its
 *     `InvalidOrder` parent, else a not-found would read as a rejection).
 *  3. **Unknown → `NetworkError`** (retryable), raw code captured on the error and handed to
 *     `opts.onUnknown` so the adapter logs it. Never a raw re-throw.
 *
 * Bybit quirk: the same code space is used by REST **and** the WS trade API (a WS-API reply
 * carries `retCode` in the frame, lifted onto `Error.code` by `ws-orders.ts`), so this one
 * table classifies both — unlike Binance, where the WS-API nests its code under `error.code`.
 */

import {
  AuthenticationError,
  DDoSProtection,
  ExchangeNotAvailable,
  InsufficientFunds,
  InvalidOrder,
  OnMaintenance,
  OrderNotFound,
  PermissionDenied,
  RateLimitExceeded,
  RequestTimeout,
} from 'ccxt'
import type { VenueErrorKind } from '../../../core/ports/exchange-adapter.js'
import {
  AdapterError,
  AuthError,
  InsufficientBalanceError,
  NetworkError,
  NotFoundError,
  OrderRejectedError,
  RateLimitedError,
  VenueUnavailableError,
} from '../../shared/errors.js'

export interface MapErrorOpts {
  /** Called with the raw code + original error when nothing matched (adapter logs it). */
  onUnknown?(rawCode: string | number | undefined, err: unknown): void
}

/**
 * Bybit v5 `retCode` → kind (`10` §5; Bybit v5 error-code reference). These win over the
 * ccxt class default so a generic `ExchangeError` still lands right. HTTP 403/429 sit
 * alongside the venue codes since ccxt surfaces the status on `.code` too — Bybit answers
 * IP-rate abuse with a bare 403 at the edge, before any `retCode` exists.
 */
const CODE_KIND = new Map<number, VenueErrorKind>([
  [403, 'RateLimited'], // edge rejection on IP-rate abuse (no retCode)
  [429, 'RateLimited'],
  [10006, 'RateLimited'], // too many visits (UID rate limit)
  [10018, 'RateLimited'], // exceeded IP rate limit
  [10403, 'RateLimited'], // WS trade API: request throttled
  [10429, 'RateLimited'], // WS trade API: too many requests
  [10003, 'AuthError'], // invalid API key
  [10004, 'AuthError'], // error sign / invalid signature
  [10005, 'AuthError'], // permission denied for current API key
  [10002, 'AuthError'], // request timestamp outside recv_window
  [10007, 'InsufficientBalance'], // insufficient balance (unified account gate)
  [110007, 'InsufficientBalance'], // insufficient available balance
  [110012, 'InsufficientBalance'], // insufficient available balance (position margin)
  [110045, 'InsufficientBalance'], // wallet balance insufficient
  [110001, 'NotFound'], // order does not exist
  [110017, 'OrderRejected'], // reduce-only rule not satisfied
  [110043, 'OrderRejected'], // set-leverage / order not modified — a rejected write, not a retry
  [110094, 'OrderRejected'], // order qty/price out of the venue's permitted range
  [10001, 'OrderRejected'], // params error (precision / min-notional / bad field)
  [10016, 'VenueUnavailable'], // internal server error
  [10015, 'VenueUnavailable'], // service temporarily unavailable
])

/** Construct the right subclass for a kind, threading raw code + reason through. */
function make(
  kind: VenueErrorKind,
  message: string,
  rawCode?: string | number,
  reason?: string,
  cause?: unknown,
): AdapterError {
  const opts = { rawCode, reason, cause }
  switch (kind) {
    case 'RateLimited':
      return new RateLimitedError(message, opts)
    case 'OrderRejected':
      return new OrderRejectedError(message, opts)
    case 'InsufficientBalance':
      return new InsufficientBalanceError(message, opts)
    case 'AuthError':
      return new AuthError(message, opts)
    case 'NotFound':
      return new NotFoundError(message, opts)
    case 'VenueUnavailable':
      return new VenueUnavailableError(message, opts)
    default:
      // WsTimeout is never produced from a REST throw; unknown kinds fall to NetworkError.
      return new NetworkError(message, opts)
  }
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/**
 * Read a Bybit `retCode`: the native lib rejects with the raw response body (`retCode` on
 * the object), the WS-API path lifts it onto `Error.code`, and ccxt embeds the whole body
 * in the message (`bybit {"retCode":110007,"retMsg":…}`) — so try all three, in that order.
 */
function extractCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    for (const field of ['retCode', 'code'] as const) {
      if (field in err) {
        const raw = (err as Record<string, unknown>)[field]
        if (typeof raw === 'number') return raw
        if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw)
      }
    }
  }
  const msg = extractMessage(err)
  const inJson = msg.match(/"retCode"\s*:\s*(\d+)/)
  if (inJson?.[1] !== undefined) return Number(inJson[1])
  // Bybit codes are positive and ≥5 digits (10xxx account/transport, 1100xx trade); a
  // narrower pattern than Binance's avoids matching a price or quantity in the message.
  const bare = msg.match(/\b\d{5,6}\b/)
  return bare ? Number(bare[0]) : undefined
}

/** Map by ccxt class — most-specific subclass first. Returns `undefined` if unrecognised. */
function mapByClass(err: unknown): VenueErrorKind | undefined {
  if (err instanceof RateLimitExceeded || err instanceof DDoSProtection) return 'RateLimited'
  if (err instanceof RequestTimeout) return 'NetworkError'
  if (err instanceof OnMaintenance || err instanceof ExchangeNotAvailable) return 'VenueUnavailable'
  if (err instanceof AuthenticationError || err instanceof PermissionDenied) return 'AuthError'
  if (err instanceof InsufficientFunds) return 'InsufficientBalance'
  if (err instanceof OrderNotFound) return 'NotFound' // must precede InvalidOrder (its parent)
  if (err instanceof InvalidOrder) return 'OrderRejected'
  return undefined
}

export function mapBybitError(err: unknown, opts?: MapErrorOpts): AdapterError {
  // Already mapped (e.g. re-thrown through a lower layer) — don't double-wrap.
  if (err instanceof AdapterError) return err

  const rawCode = extractCode(err)
  const message = extractMessage(err)

  const byCode = rawCode !== undefined ? CODE_KIND.get(rawCode) : undefined
  if (byCode) return make(byCode, message, rawCode, message, err)

  const byClass = mapByClass(err)
  if (byClass) return make(byClass, message, rawCode, message, err)

  opts?.onUnknown?.(rawCode, err)
  return new NetworkError(message, { rawCode, reason: message, cause: err })
}
