/**
 * Binance venue-error mapping (`10_exchange_adapters_and_market_data.md` §5). Turns any
 * ccxt/native throw into exactly one {@link AdapterError} — the core only ever sees one
 * of eight kinds, never a raw venue code. Mapping tables are adapter-local; the union is
 * shared (task 0200 decision 5).
 *
 * Resolution order (decision 6 / task table):
 *  1. **Numeric code wins** — a Binance code read off `err.code`/message maps first, so a
 *     generic ccxt `ExchangeError` carrying `-2010` still lands on `OrderRejected`.
 *  2. **ccxt class** — `instanceof`, most-specific subclass first (`OrderNotFound` before
 *     its `InvalidOrder` parent, else a not-found would read as a rejection).
 *  3. **Unknown → `NetworkError`** (retryable), raw code captured on the error and handed
 *     to `opts.onUnknown` so the adapter logs it. Never a raw re-throw.
 *
 * ccxt hierarchy verified via Context7: `RequestTimeout`/`ExchangeNotAvailable`/
 * `RateLimitExceeded`/`DDoSProtection ⊂ NetworkError`; `AuthenticationError`/
 * `InsufficientFunds`/`InvalidOrder ⊂ ExchangeError`; `OnMaintenance ⊂ ExchangeNotAvailable`,
 * `PermissionDenied ⊂ AuthenticationError`, `OrderNotFound ⊂ InvalidOrder`.
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
 * Binance numeric codes → kind (`10` §5; Binance fapi error-code reference). These win
 * over the ccxt class default so a generic `ExchangeError` still lands right. HTTP
 * 429/418 sit alongside the venue codes since ccxt surfaces the status on `.code` too.
 */
const CODE_KIND = new Map<number, VenueErrorKind>([
  [429, 'RateLimited'],
  [418, 'RateLimited'],
  [-1003, 'RateLimited'], // too many requests
  [-2010, 'OrderRejected'], // NEW_ORDER_REJECTED (min-notional/precision)
  [-1013, 'OrderRejected'], // filter failure (PRICE_FILTER/LOT_SIZE/MIN_NOTIONAL)
  [-1111, 'OrderRejected'], // precision over max
  [-4164, 'OrderRejected'], // order notional below min
  [-2021, 'OrderRejected'], // reduce-only order would not reduce
  [-2022, 'OrderRejected'], // reduce-only rejected
  [-2019, 'InsufficientBalance'], // margin is insufficient
  [-2013, 'NotFound'], // order does not exist
  [-2015, 'AuthError'], // invalid API-key / permissions / IP
  [-1021, 'AuthError'], // timestamp outside recvWindow
  [-1022, 'AuthError'], // invalid signature
  [-1000, 'VenueUnavailable'], // unknown internal error
  [-1001, 'VenueUnavailable'], // internal disconnect
  [-1016, 'VenueUnavailable'], // service shutting down
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

/** Read a Binance numeric code off `err.code`, else parse the first signed integer in the message. */
function extractCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === 'number') return code
    if (typeof code === 'string' && code.trim() !== '' && Number.isFinite(Number(code))) return Number(code)
  }
  const msg = extractMessage(err)
  const match = msg.match(/-?\d{3,}/) // Binance codes are ≥3 digits; avoids matching stray small ints
  return match ? Number(match[0]) : undefined
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
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

export function mapBinanceError(err: unknown, opts?: MapErrorOpts): AdapterError {
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
